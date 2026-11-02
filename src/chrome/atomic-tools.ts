import { z } from "zod";
import { scriptChanges, scriptDefinition, scriptId } from "../userscripts/schema";
import { elementTargetSchema as target } from "./element-target";

// Arguments are encoded as JSON data, never interpolated as JavaScript source.
const tabId = z.number().int().nonnegative().optional();
const timeoutMs = z.number().int().positive().optional();
const pageFields = { tabId, timeoutMs };
const targetFields = { ...pageFields, target };
const selector = `async function locate(page, target) {
  if (target.ref !== undefined) return page.ref(target.ref);
  let root = target.frame ? (target.frame.ref !== undefined ? page.frameRef(target.frame.ref) : page.frameLocator(target.frame.value)) : page;
  if (target.scope) {
    const selected = target.scope.by === 'css' ? root.locator(target.scope.value)
      : root.getByRole(target.scope.value, { ...(target.scope.name === undefined ? {} : {name:target.scope.name}), ...(target.scope.exact === undefined ? {} : {exact:target.scope.exact}) });
    root = selected.uniqueScope();
  }
  const methods = { role: 'getByRole', text: 'getByText', label: 'getByLabel', placeholder: 'getByPlaceholder', alt: 'getByAltText', title: 'getByTitle', testId: 'getByTestId', css: 'locator' };
  let result = root[methods[target.by]](target.value, { ...(target.name === undefined ? {} : {name:target.name}), ...(target.exact === undefined ? {} : {exact:target.exact}) });
  if (target.index !== undefined) result = result.nth(target.index);
  return result;
}`;

export type AtomicToolDefinition = {
  name: string;
  summary: string;
  description: string;
  inputSchema: z.ZodType<any>;
  program: (input: unknown) => { code: string; timeoutMs?: number; defaultTimeoutMs?: number; background?: boolean };
};

// Actions that can cause dialogs, navigation, downloads or other long-lived
// browser work may return a job so another tool can respond to those events.
const BACKGROUND_ACTIONS = new Set([
  "click", "double_click", "hover", "focus_element", "blur_element", "scroll_to_element", "verify_state", "fill", "fill_from_artifact", "type_text", "press_key", "key_down", "key_up", "set_checked", "select_option",
  "drag", "scroll", "move_pointer", "press_pointer", "release_pointer", "navigate", "reload", "go_back", "go_forward", "open_tab", "close_tab",
  "upload_file", "send_request", "import_file_from_url", "import_file_from_link", "read_value",
]);
function define(name: string, description: string, inputSchema: z.ZodType<any>, body: string, options: { page?: boolean; locators?: boolean; summary?: string } = {}): AtomicToolDefinition {
  let schema = BACKGROUND_ACTIONS.has(name) && name !== "upload_file" ? (inputSchema as z.ZodObject).safeExtend({ background: z.boolean().optional().describe("Run as a background job for long operations or actions blocked by browser events. Use get_job to follow the returned job until terminal.") }) : inputSchema;
  const metadata = inputSchema.meta();
  if (schema !== inputSchema && metadata) schema = schema.meta(metadata);
  return {
    name, summary: options.summary ?? description, description, inputSchema: schema,
    program(input) {
      const parsed = schema.parse(input);
      if (name === "upload_file" && parsed.chooserId !== undefined) throw new Error("Chooser uploads use the live chooser handler");
      const encoded = JSON.stringify(JSON.stringify(parsed));
      const code = `const input = JSON.parse(${encoded});\n${options.locators ? selector : ""}\n${options.page ? "const currentPage = input.tabId === undefined ? page : await browser.page(input.tabId);" : ""}\n${body}`;
      // Verification's timeout bounds the condition wait, not page setup or cleanup.
      const programTimeout = name === "verify_state" && parsed.timeoutMs !== undefined
        ? parsed.timeoutMs === 0 ? undefined : Math.min(Number.MAX_SAFE_INTEGER, parsed.timeoutMs + 10_000)
        : parsed.timeoutMs;
      return { code, ...(programTimeout === undefined ? {} : { timeoutMs: programTimeout }),
        ...((name === "click" || name === "double_click") && programTimeout === undefined ? { defaultTimeoutMs: 5_000 } : {}),
        ...(parsed.background ? { background: true } : {}) };
    },
  };
}
const noArgs = z.object({ timeoutMs }).strict();
const pageArgs = z.object(pageFields).strict();
const targetArgs = z.object(targetFields).strict();
const page = { page: true };
const locator = { page: true, locators: true };
const targetAction = (name: string, summary: string, method: string) => define(name, summary, targetArgs, `return await (await locate(currentPage, input.target)).${method}();`, locator);
const verificationConditions = ["textIncludes", "textEquals", "valueEquals", "state"] as const;

/** Only capabilities supported by the existing program host are registered here. */
export const ATOMIC_TOOL_REGISTRY: readonly AtomicToolDefinition[] = Object.freeze([
  targetAction("click", "Click exactly one matching element. Fails immediately if it is missing, blocked or otherwise not actionable. Defaults to a 5 second execution timeout.", "click"),
  targetAction("double_click", "Double-click exactly one matching element. Fails immediately if it is missing, blocked or otherwise not actionable. Defaults to a 5 second execution timeout.", "dblclick"),
  targetAction("hover", "Move the pointer over exactly one matching element.", "hover"),
  targetAction("focus_element", "Focus exactly one matching element. Fails immediately if the target or frame is missing; use verify_state to wait explicitly.", "focus"),
  targetAction("blur_element", "Blur exactly one matching element. Fails immediately if the target or frame is missing.", "blur"),
  targetAction("scroll_to_element", "Scroll exactly one matching element into view.", "scrollIntoViewIfNeeded"),
  define("fill", "Replace an editable element's value; an empty value clears it. Does not emit beforeinput or keyboard events. Date, time, datetime-local, month and week require valid browser-format values and dispatch untrusted input/change events; the result includes the actual normalized value.", z.object({ ...targetFields, value: z.string() }).strict(), "return await (await locate(currentPage, input.target)).fill(input.value);", { ...locator, summary: "Replace an editable element's value; an empty value clears it." }),
  define("fill_from_artifact", "Replace an editable element's value with a stored string or UTF-8 file artifact. Use path to select a string within a stored result. Applies the same fill semantics as fill.", z.object({ ...targetFields, artifactId: z.number().int().positive(), path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional() }).strict(), `const value = await artifacts.read(input.artifactId, {path:input.path});
    let text;
    if (typeof value === 'string') text = value;
    else if (value && typeof value.base64 === 'string') {
      const binary = atob(value.base64);
      text = new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    } else throw new Error('Artifact path must contain a string or UTF-8 file');
    return await (await locate(currentPage, input.target)).fill(text);`, { ...locator, summary: "Fill an editable element from a stored text artifact or result." }),
  define("type_text", "Insert text character by character into a text, number or contenteditable element. Printable ASCII uses keyboard events; other characters are inserted as text without keydown or keyup. Use fill for date/time/month/week controls.", z.object({ ...targetFields, text: z.string() }).strict(), "return await (await locate(currentPage, input.target)).pressSequentially(input.text);", { ...locator, summary: "Insert text character by character into an editable element." }),
  define("press_key", "Press a character or chord such as Control+ArrowUp, optionally focusing an element first. A missing or non-actionable target, including its frame, fails immediately; use verify_state for an explicit wait. Named keys (ArrowUp, Enter, F1–F24) are case-insensitive; unknown key names fail before input or focus is dispatched.", z.object({ ...pageFields, target: target.optional(), key: z.string().min(1) }).strict(), "return input.target ? await (await locate(currentPage, input.target)).press(input.key) : await currentPage.keyboard.press(input.key);", { ...locator, summary: "Press a key or chord, optionally focusing an element first." }),
  define("key_down", "Hold one character or named key until key_up or run cleanup. Named keys are case-insensitive; chords and unknown key names are rejected.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.down(input.key);", { ...page, summary: "Hold a key until key_up or run cleanup." }),
  define("key_up", "Release one held character or named key. Named keys are case-insensitive; chords and unknown key names are rejected.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.up(input.key);", page),
  define("set_checked", "Set a checkbox or radio button to the requested checked state.", z.object({ ...targetFields, checked: z.boolean() }).strict(), `const element = (await locate(currentPage, input.target));
    return input.checked ? await element.check() : await element.uncheck();`, locator),
  define("select_option", "Select option values or labels on a select element. An empty array clears selection; missing, disabled or ambiguous options fail without changing selection.", z.object({ ...targetFields, value: z.union([z.string(), z.array(z.string())]) }).strict(), "return await (await locate(currentPage, input.target)).selectOption(input.value);", { ...locator, summary: "Select option values or labels on a select element." }),
  define("drag", "Drag one element to another using pointer events.", z.object({ ...pageFields, source: target, destination: target }).strict(), "return await (await locate(currentPage, input.source)).dragTo((await locate(currentPage, input.destination)));", { ...locator, summary: "Drag one element to another using pointer events." }),
  define("scroll", "Scroll the page by a horizontal and vertical delta at the current pointer.", z.object({ ...pageFields, deltaX: z.number().optional(), deltaY: z.number() }).strict(), "return await currentPage.mouse.wheel(input.deltaX ?? 0, input.deltaY);", page),
  define("move_pointer", "Move the pointer using observationId from take_screenshot on the same tab. x and y are pixel coordinates relative to that screenshot's top-left, including for an element screenshot; the tool accounts for its scale and origin. A navigation or change in scroll position, viewport size or scale invalidates the observation; take a new screenshot.", z.object({ ...pageFields, observationId: z.string().min(1), x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(), "return await currentPage.point(input.observationId, input.x, input.y, 'hover');", page),
  define("press_pointer", "Press a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.down(input.button);", page),
  define("release_pointer", "Release a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.up(input.button);", page),
  targetAction("read_text", "Read an element's visible text.", "innerText"),
  targetAction("read_value", "Read a form element's current value.", "inputValue"),
  targetAction("read_checked", "Read an element's checked state; missing or unsupported states are errors.", "isChecked"),
  define("read_attribute", "Read an element's named attribute.", z.object({ ...targetFields, name: z.string().min(1) }).strict(), "return await (await locate(currentPage, input.target)).getAttribute(input.name);", locator),
  define("count_elements", "Count elements matching a target.", targetArgs, "return await (await locate(currentPage, input.target)).count();", locator),
  define("read_elements", "Read visible text and selected attributes from a page of matching elements. The list is live: elements can change between reads or pages. offset defaults to 0 and limit defaults to 25, maximum 100.", z.object({
    ...targetFields, offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(100).optional(), attributes: z.array(z.string().min(1)).max(20).optional(),
  }).strict(), `const elements = (await locate(currentPage, input.target));
    const total = await elements.count();
    const offset = input.offset ?? 0, limit = input.limit ?? 25;
    const items = [];
    for (let index = offset; index < Math.min(total, offset + limit); index++) {
      const element = elements.nth(index), entries = [];
      const text = await element.innerText();
      for (const name of input.attributes ?? []) entries.push([name, await element.getAttribute(name)]);
      items.push({ index, text, attributes: Object.fromEntries(entries) });
    }
    return { total, items, ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}) };`, { ...locator, summary: "Read text and selected attributes from matching elements in pages." }),
  define("verify_state", "Specify exactly one of textIncludes, textEquals, valueEquals, or state. Checks immediately by default (timeoutMs=0); a positive timeoutMs waits for the condition. textEquals compares the complete visible text exactly; textIncludes checks a substring. A timed-out wait returns verified=false and timedOut=true.", z.object({
    tabId, target, timeoutMs: z.number().int().nonnegative().optional(),
    textIncludes: z.string().optional(), textEquals: z.string().optional(), valueEquals: z.string().optional(),
    state: z.enum(["visible", "hidden", "enabled", "disabled", "editable", "checked", "unchecked"]).optional(),
  }).strict().refine((input) => verificationConditions.filter((key) => input[key] !== undefined).length === 1,
    "Specify exactly one condition").meta({ oneOf: verificationConditions.map((key) => ({ required: [key] })) }), `const element = (await locate(currentPage, input.target));
    const deadline = Date.now() + (input.timeoutMs ?? 0);
    const condition = input.textIncludes !== undefined || input.textEquals !== undefined ? 'text'
      : input.valueEquals !== undefined ? 'value'
      : input.state === 'visible' || input.state === 'hidden' ? 'visible'
      : input.state === 'enabled' || input.state === 'disabled' ? 'enabled'
      : input.state === 'editable' ? 'editable'
      : 'checked';
    while (true) {
      const { present, actual } = await element.readCondition(condition);
      const verified = input.state === 'hidden' && !present ? true : !present ? false
        : input.textIncludes !== undefined ? typeof actual === 'string' && actual.includes(input.textIncludes)
        : input.textEquals !== undefined ? actual === input.textEquals
        : input.valueEquals !== undefined ? actual === input.valueEquals
        : input.state === 'hidden' || input.state === 'disabled' || input.state === 'unchecked' ? actual === false
        : actual === true;
      if (verified || Date.now() >= deadline) return { verified, actual, present, ...(!verified && (input.timeoutMs ?? 0) > 0 ? { timedOut: true } : {}) };
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }`, locator),
  define("wait_for_url", "Wait until the page URL contains the given text.", z.object({ ...pageFields, url: z.string().min(1) }).strict(), "return await currentPage.waitForURL(input.url);", page),
  define("get_page_info", "Read the selected page's URL and title.", pageArgs, "return { url: await currentPage.url(), title: await currentPage.title() };", page),
  define("navigate", "Navigate the selected page to a URL.", z.object({ ...pageFields, url: z.string().min(1) }).strict(), "return await currentPage.goto(input.url);", page),
  define("reload", "Reload the selected page.", pageArgs, "return await currentPage.reload();", page),
  define("go_back", "Navigate back in the selected page history.", pageArgs, "return await currentPage.goBack();", page),
  define("go_forward", "Navigate forward in the selected page history.", pageArgs, "return await currentPage.goForward();", page),
  define("list_tabs", "List tabs across browser windows.", noArgs, "return await browser.tabs.list();"),
  define("open_tab", "Open a tab in the bound browser window.", z.object({ timeoutMs, url: z.string().min(1).optional() }).strict(), "const opened = await browser.tabs.open(input.url); return { tabId: opened.tabId };"),
  define("switch_tab", "Switch the bound page to a tab.", z.object({ timeoutMs, tabId: z.number().int().nonnegative() }).strict(), "return await browser.tabs.select(input.tabId);"),
  define("close_tab", "Close a tab.", z.object({ timeoutMs, tabId: z.number().int().nonnegative() }).strict(), "return await browser.tabs.close(input.tabId);"),
  define("upload_file", "Upload one or more artifacts. Supply exactly one target or chooserId; chooser uploads cannot set tabId or background.", z.object({ ...pageFields,
    target: target.optional(), chooserId: z.string().min(1).optional(),
    artifactId: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]), background: z.boolean().optional().describe("Run a target upload as a background job and follow it with get_job; unavailable for chooser uploads."),
  }).strict().refine((input) => (input.target !== undefined) !== (input.chooserId !== undefined)
    && (input.chooserId === undefined || input.tabId === undefined && input.background === undefined),
  "Choose exactly one target or chooserId; chooser uploads cannot specify tabId or background")
    .meta({ oneOf: [
      { required: ["target"], not: { required: ["chooserId"] } },
      { required: ["chooserId"], not: { anyOf: ["target", "tabId", "background"].map((field) => ({ required: [field] })) } },
    ] }), `const ids = Array.isArray(input.artifactId) ? input.artifactId : [input.artifactId];
    const values = new Map();
    for (const id of ids) if (!values.has(id)) values.set(id, artifacts.read(id));
    const files = await Promise.all(ids.map(async (id) => {
      const artifact = await values.get(id);
      if (!artifact || typeof artifact.filename !== 'string' || typeof artifact.mimeType !== 'string' || typeof artifact.base64 !== 'string')
        throw new Error('AutomationError[invalid-artifact]: The artifact has no available file bytes');
      return {name:artifact.filename,mimeType:artifact.mimeType,base64:artifact.base64};
    }));
    return await (await locate(currentPage, input.target)).setInputFiles(files);`, { ...locator, summary: "Upload artifacts to a file input or captured chooser." }),
  define("take_screenshot", "Capture a screenshot when visual input is enabled.", z.object({ ...pageFields, target: target.optional() }).strict(), "return await currentPage.screenshot(input.target ? { target: input.target } : {});", page),
  define("create_pdf", "Create a PDF artifact of the selected page.", pageArgs, "return await currentPage.pdf();", page),
  define("read_artifact", "Read a stored artifact or large tool result by ID, including during a background job. Missing paths fail. offset/limit page arrays, strings, Map/Set entries, binary bytes for ArrayBuffer/DataView, or elements for TypedArray. In path, a numeric Map index selects a [key,value] pair and a numeric Set index selects an item. Undefined is null with resultType=undefined; nested undefined and array holes are null with undefinedPaths and holePaths; non-finite numbers, negative zero and bigints use numberPaths and bigintPaths. Paths are relative to the returned slice; large results expose paged sidecar access.", z.object({ timeoutMs, artifactId: z.number().int().positive(), path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict(), "return await artifacts.read(input.artifactId, {path:input.path, offset:input.offset, limit:input.limit});", { summary: "Read a stored artifact or large tool result by ID, including during a background job." }),
  define("create_text_artifact", "Store text as an internal artifact.", z.object({ timeoutMs, filename: z.string().min(1), text: z.string(), mimeType: z.string().min(1).optional() }).strict(), "return await artifacts.text(input.filename, input.text, input.mimeType);"),
  define("import_file_from_url", "Fetch a file in the extension context and store its original bytes as an internal artifact. Uses extension permissions and credentials, not the page's context. Fails on non-success HTTP responses.", z.object({ timeoutMs, url: z.string().min(1), filename: z.string().min(1) }).strict(), "return await artifacts.importUrl(input.url, input.filename);"),
  define("import_file_from_link", "Import a linked file with its original bytes and filename in the link's page and frame context. Uses page origin, credentials and CORS; supports page-created blob URLs. Preserves the download attribute, otherwise uses Content-Disposition or the response URL filename. Returns filename and byteLength; fails if no filename is available or the response is unsuccessful. Use save_artifact for an explicitly renamed export.", z.object(targetFields).strict(), "return await artifacts.importLink(input.tabId ?? page.tabId, input.target);", { summary: "Import a linked file preserving its source filename and bytes." }),
  define("save_artifact", "Export an internal artifact to a file.", z.object({ timeoutMs, artifactId: z.number().int().positive(), filename: z.string().min(1).optional() }).strict(), "return await artifacts.save(input.artifactId, input.filename);"),
  define("list_scripts", "List persisted user scripts and their state.", noArgs, "return await browser.scripts.list();"),
  define("read_script", "Read a persisted user script by ID.", z.object({ timeoutMs, scriptId }).strict(), "return await browser.scripts.read(input.scriptId);"),
  define("create_script", "Create a persisted user script and immediately enable and register it. It will run on matching page loads according to its injection settings.", z.object({ timeoutMs, definition: scriptDefinition }).strict(), "return await browser.scripts.create(input.definition);", { summary: "Create and enable a persisted user script." }),
  define("update_script", "Update one or more fields of a persisted user script while preserving its enabled state. Supplied fields, including arrays, replace their old values; omitted fields remain unchanged. For nullable optional settings, null removes the setting and restores Chrome's default.", z.object({ timeoutMs, scriptId, changes: scriptChanges }).strict(), "return await browser.scripts.edit(input.scriptId, input.changes);", { summary: "Update a persisted user script while preserving its enabled state." }),
  define("set_script_enabled", "Enable or disable a persisted user script.", z.object({ timeoutMs, scriptId, enabled: z.boolean() }).strict(), "return await browser.scripts.setEnabled(input.scriptId, input.enabled);"),
  define("delete_script", "Delete a persisted user script.", z.object({ timeoutMs, scriptId }).strict(), "return await browser.scripts.delete(input.scriptId);"),
  define("list_requests", "List captured network requests and requestRef identifiers. limit defaults to 100, max 100. integrity describes captured history, not all network traffic; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list.", z.object({ ...pageFields, limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.requests({limit:input.limit, offset:input.offset}, currentPage.tabId);", { ...page, summary: "List captured network requests and requestRef identifiers." }),
  define("read_response", "Read the captured response body identified by requestRef from list_requests.", z.object({ ...pageFields, requestRef: z.string().min(1) }).strict(), "return await net.responseBody(input.requestRef, currentPage.tabId);", page),
  define("read_console", "Read captured console messages. limit defaults to 100, max 100. integrity describes captured history; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list.", z.object({ ...pageFields, limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.console({limit:input.limit, offset:input.offset}, currentPage.tabId);", { ...page, summary: "Read captured console messages." }),
  define("send_request", "Send one HTTP request in the explicit page or extension context; contexts have different permissions and credentials.", z.object({ ...pageFields, context: z.enum(["page", "extension"]), url: z.string().min(1), init: z.object({ method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), credentials: z.enum(["omit", "same-origin", "include"]).optional() }).strict().optional() }).strict(), "return await net.fetch({context:input.context, url:input.url, init:input.init, tabId:input.tabId});"),
]);
