import { z } from "zod";

// The public schemas are kept separate from the program API. Arguments are encoded
// as JSON data, never interpolated as JavaScript source.
const target = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.union([z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(), z.object({ ref: z.string().min(1) }).strict()]).optional() }).strict(),
]);
const tabId = z.number().int().nonnegative().optional();
const timeoutMs = z.number().int().positive().optional();
const scriptSource = z.union([z.object({ code: z.string().min(1) }).strict(), z.object({ file: z.string().min(1) }).strict()]);
const scriptFields = {
  matches: z.array(z.string().min(1)).min(1), js: z.array(scriptSource).min(1),
  allFrames: z.boolean(), excludeGlobs: z.array(z.string()), excludeMatches: z.array(z.string()),
  includeGlobs: z.array(z.string()), runAt: z.enum(["document_start", "document_end", "document_idle"]),
  world: z.enum(["USER_SCRIPT", "MAIN"]), worldId: z.string().min(1),
};
const scriptDefinition = z.object({ id: z.string().min(1).refine((id) => !id.startsWith("_")), matches: scriptFields.matches, js: scriptFields.js,
  allFrames: scriptFields.allFrames.optional(), excludeGlobs: scriptFields.excludeGlobs.optional(), excludeMatches: scriptFields.excludeMatches.optional(),
  includeGlobs: scriptFields.includeGlobs.optional(), runAt: scriptFields.runAt.optional(), world: scriptFields.world.optional(), worldId: scriptFields.worldId.optional() }).strict();
const scriptChanges = z.object({ matches: scriptFields.matches.optional(), js: scriptFields.js.optional(), allFrames: scriptFields.allFrames.nullable().optional(),
  excludeGlobs: scriptFields.excludeGlobs.nullable().optional(), excludeMatches: scriptFields.excludeMatches.nullable().optional(), includeGlobs: scriptFields.includeGlobs.nullable().optional(),
  runAt: scriptFields.runAt.nullable().optional(), world: scriptFields.world.nullable().optional(), worldId: scriptFields.worldId.nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0);
const pageFields = { tabId, timeoutMs };
const targetFields = { ...pageFields, target };
const selector = `function locate(page, target) {
  if (target.ref !== undefined) return page.ref(target.ref);
  const root = target.frame ? (target.frame.ref !== undefined ? page.frameRef(target.frame.ref) : page.frameLocator(target.frame.value)) : page;
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
  program: (input: unknown) => { code: string; timeoutMs?: number; background?: boolean };
};

// Actions that can cause dialogs, navigation, downloads or other long-lived
// browser work may return a job so another tool can respond to those events.
const BACKGROUND_ACTIONS = new Set([
  "click", "double_click", "hover", "focus_element", "blur_element", "fill", "type_text", "press_key", "key_down", "key_up", "set_checked", "select_option",
  "drag", "scroll", "move_pointer", "press_pointer", "release_pointer", "navigate", "reload", "go_back", "go_forward", "open_tab", "close_tab",
  "upload_file", "fetch", "evaluate_js", "send_cdp",
]);
function define(name: string, description: string, inputSchema: z.ZodType<any>, body: string, options: { page?: boolean; locators?: boolean; summary?: string } = {}): AtomicToolDefinition {
  const schema = BACKGROUND_ACTIONS.has(name) && name !== "upload_file" ? (inputSchema as z.ZodObject).extend({ background: z.boolean().optional() }) : inputSchema;
  return {
    name, summary: options.summary ?? description, description, inputSchema: schema,
    program(input) {
      const parsed = schema.parse(input);
      if (name === "upload_file" && parsed.chooserId !== undefined) throw new Error("Chooser uploads use the live chooser handler");
      const encoded = JSON.stringify(JSON.stringify(parsed));
      const code = `const input = JSON.parse(${encoded});\n${options.locators ? selector : ""}\n${options.page ? "const currentPage = input.tabId === undefined ? page : await browser.page(input.tabId);" : ""}\n${body}`;
      // Verification's timeout bounds the condition wait, not page setup or cleanup.
      const programTimeout = name === "verify_state" && parsed.timeoutMs !== undefined
        ? parsed.timeoutMs === 0 ? undefined : parsed.timeoutMs + 10_000
        : parsed.timeoutMs;
      return { code, ...(programTimeout === undefined ? {} : { timeoutMs: programTimeout }), ...(parsed.background ? { background: true } : {}) };
    },
  };
}
const noArgs = z.object({ timeoutMs }).strict();
const pageArgs = z.object(pageFields).strict();
const targetArgs = z.object(targetFields).strict();
const page = { page: true };
const locator = { page: true, locators: true };
const targetAction = (name: string, summary: string, method: string) => define(name, summary, targetArgs, `return await locate(currentPage, input.target).${method}();`, locator);

/** Only capabilities supported by the existing program host are registered here. */
export const ATOMIC_TOOL_REGISTRY: readonly AtomicToolDefinition[] = Object.freeze([
  targetAction("click", "Click exactly one matching element.", "click"),
  targetAction("double_click", "Double-click exactly one matching element.", "dblclick"),
  targetAction("hover", "Move the pointer over exactly one matching element.", "hover"),
  targetAction("focus_element", "Focus exactly one matching element.", "focus"),
  targetAction("blur_element", "Blur exactly one matching element.", "blur"),
  define("fill", "Replace an editable element's value; an empty value clears it. Does not emit beforeinput or keyboard events. Date, time, datetime-local, month and week require valid browser-format values and dispatch untrusted input/change events; the result includes the actual normalized value.", z.object({ ...targetFields, value: z.string() }).strict(), "return await locate(currentPage, input.target).fill(input.value);", { ...locator, summary: "Replace an editable element's value; an empty value clears it." }),
  define("type_text", "Insert text character by character into a text, number or contenteditable element; this does not emit beforeinput, keydown or keyup. Use fill for date/time/month/week controls.", z.object({ ...targetFields, text: z.string() }).strict(), "return await locate(currentPage, input.target).pressSequentially(input.text);", { ...locator, summary: "Insert text character by character into an editable element." }),
  define("press_key", "Press a key or chord, optionally focusing an element first. The interaction blocker can reject editing keys with guard-blocked-input and unknown effects.", z.object({ ...pageFields, target: target.optional(), key: z.string().min(1) }).strict(), "return input.target ? await locate(currentPage, input.target).press(input.key) : await currentPage.keyboard.press(input.key);", { ...locator, summary: "Press a key or chord, optionally focusing an element first." }),
  define("key_down", "Hold a key until key_up or run cleanup. The interaction blocker can reject editing keys with guard-blocked-input and unknown effects.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.down(input.key);", { ...page, summary: "Hold a key until key_up or run cleanup." }),
  define("key_up", "Release a held key.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.up(input.key);", page),
  define("set_checked", "Set a checkbox or radio button to the requested checked state.", z.object({ ...targetFields, checked: z.boolean() }).strict(), `const element = locate(currentPage, input.target);
    return input.checked ? await element.check() : await element.uncheck();`, locator),
  define("select_option", "Select option values or labels on a select element. An empty array clears selection; missing, disabled or ambiguous options fail without changing selection.", z.object({ ...targetFields, value: z.union([z.string(), z.array(z.string())]) }).strict(), "return await locate(currentPage, input.target).selectOption(input.value);", { ...locator, summary: "Select option values or labels on a select element." }),
  define("drag", "Drag one element to another using pointer events. Native HTML5 draggable sources are unavailable while the interaction blocker is active.", z.object({ ...pageFields, source: target, destination: target }).strict(), "return await locate(currentPage, input.source).dragTo(locate(currentPage, input.destination));", { ...locator, summary: "Drag one element to another using pointer events." }),
  define("scroll", "Scroll the page by a horizontal and vertical delta at the current pointer.", z.object({ ...pageFields, deltaX: z.number().optional(), deltaY: z.number() }).strict(), "return await currentPage.mouse.wheel(input.deltaX ?? 0, input.deltaY);", page),
  define("move_pointer", "Move the pointer to coordinates bound to a current observation.", z.object({ ...pageFields, observationId: z.string().min(1), x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(), "return await currentPage.point(input.observationId, input.x, input.y, 'hover');", page),
  define("press_pointer", "Press a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.down(input.button);", page),
  define("release_pointer", "Release a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.up(input.button);", page),
  targetAction("read_text", "Read an element's visible text.", "innerText"),
  targetAction("read_value", "Read a form element's current value.", "inputValue"),
  targetAction("read_checked", "Read an element's checked state; missing or unsupported states are errors.", "isChecked"),
  define("read_attribute", "Read an element's named attribute.", z.object({ ...targetFields, name: z.string().min(1) }).strict(), "return await locate(currentPage, input.target).getAttribute(input.name);", locator),
  define("verify_state", "Verify one element condition immediately or wait for it to become true; a timed-out wait returns verified=false and timedOut=true.", z.object({
    tabId, target, timeoutMs: z.number().int().nonnegative().optional(),
    textIncludes: z.string().optional(), valueEquals: z.string().optional(),
    state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "unchecked"]).optional(),
  }).strict().refine((input) => [input.textIncludes, input.valueEquals, input.state].filter((value) => value !== undefined).length === 1,
    "Specify exactly one condition"), `const element = locate(currentPage, input.target);
    const deadline = Date.now() + (input.timeoutMs ?? 0);
    const condition = input.textIncludes !== undefined ? 'text'
      : input.valueEquals !== undefined ? 'value'
      : input.state === 'visible' || input.state === 'hidden' ? 'visible'
      : input.state === 'enabled' || input.state === 'disabled' ? 'enabled'
      : 'checked';
    while (true) {
      const { present, actual } = await element.readCondition(condition);
      const verified = input.state === 'hidden' && !present ? true : !present ? false
        : input.textIncludes !== undefined ? typeof actual === 'string' && actual.includes(input.textIncludes)
        : input.valueEquals !== undefined ? actual === input.valueEquals
        : input.state === 'hidden' || input.state === 'disabled' || input.state === 'unchecked' ? actual === false
        : actual === true;
      if (verified || Date.now() >= deadline) return { verified, actual, present, ...(!verified && (input.timeoutMs ?? 0) > 0 ? { timedOut: true } : {}) };
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }`, locator),
  define("wait_for_url", "Wait until the page URL contains the given text.", z.object({ ...pageFields, url: z.string().min(1) }).strict(), "return await currentPage.waitForURL(input.url);", page),
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
    artifactId: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]), background: z.boolean().optional(),
  }).strict().refine((input) => (input.target !== undefined) !== (input.chooserId !== undefined)
    && (input.chooserId === undefined || input.tabId === undefined && input.background === undefined),
  "Choose exactly one target or chooserId; chooser uploads cannot specify tabId or background"), `const ids = Array.isArray(input.artifactId) ? input.artifactId : [input.artifactId];
    const values = new Map();
    for (const id of ids) if (!values.has(id)) values.set(id, artifacts.read(id));
    const files = await Promise.all(ids.map(async (id) => {
      const artifact = await values.get(id);
      if (!artifact || typeof artifact.filename !== 'string' || typeof artifact.mimeType !== 'string' || typeof artifact.base64 !== 'string')
        throw new Error('AutomationError[invalid-artifact]: The artifact has no available file bytes');
      return {name:artifact.filename,mimeType:artifact.mimeType,base64:artifact.base64};
    }));
    return await locate(currentPage, input.target).setInputFiles(files);`, { ...locator, summary: "Upload artifacts to a file input or captured chooser." }),
  define("take_screenshot", "Capture a screenshot when visual input is enabled.", z.object({ ...pageFields, target: target.optional() }).strict(), "return await currentPage.screenshot(input.target ? { target: input.target } : {});", page),
  define("create_pdf", "Create a PDF artifact of the selected page.", pageArgs, "return await currentPage.pdf();", page),
  define("read_artifact", "Read a stored artifact or large tool result by ID, including during a background job. Missing paths fail. offset/limit page arrays, strings, Map/Set entries, binary bytes for ArrayBuffer/DataView, or elements for TypedArray. In path, a numeric Map index selects a [key,value] pair and a numeric Set index selects an item. Undefined is null with resultType=undefined; nested undefined and array holes are null with undefinedPaths and holePaths; non-finite numbers, negative zero and bigints use numberPaths and bigintPaths. Paths are relative to the returned slice; large results expose paged sidecar access.", z.object({ timeoutMs, artifactId: z.number().int().positive(), path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict(), "return await artifacts.read(input.artifactId, {path:input.path, offset:input.offset, limit:input.limit});", { summary: "Read a stored artifact or large tool result by ID, including during a background job." }),
  define("create_text_artifact", "Store text as an internal artifact.", z.object({ timeoutMs, filename: z.string().min(1), text: z.string(), mimeType: z.string().min(1).optional() }).strict(), "return await artifacts.text(input.filename, input.text, input.mimeType);"),
  define("save_artifact", "Export an internal artifact to a file.", z.object({ timeoutMs, artifactId: z.number().int().positive(), filename: z.string().min(1).optional() }).strict(), "return await artifacts.save(input.artifactId, input.filename);"),
  define("list_scripts", "List persisted user scripts and their state.", noArgs, "return await browser.scripts.list();"),
  define("read_script", "Read a persisted user script by ID.", z.object({ timeoutMs, scriptId: z.string().min(1) }).strict(), "return await browser.scripts.read(input.scriptId);"),
  define("create_script", "Create a persisted user script.", z.object({ timeoutMs, definition: scriptDefinition }).strict(), "return await browser.scripts.create(input.definition);"),
  define("update_script", "Update a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1), changes: scriptChanges }).strict(), "return await browser.scripts.edit(input.scriptId, input.changes);"),
  define("set_script_enabled", "Enable or disable a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1), enabled: z.boolean() }).strict(), "return await browser.scripts.setEnabled(input.scriptId, input.enabled);"),
  define("delete_script", "Delete a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1) }).strict(), "return await browser.scripts.delete(input.scriptId);"),
  define("list_requests", "List captured network requests and requestRef identifiers. limit defaults to 100, max 100. integrity describes captured history, not all network traffic; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list.", z.object({ ...pageFields, limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.requests({limit:input.limit, offset:input.offset}, currentPage.tabId);", { ...page, summary: "List captured network requests and requestRef identifiers." }),
  define("read_response", "Read the captured response body identified by requestRef from list_requests.", z.object({ ...pageFields, requestRef: z.string().min(1) }).strict(), "return await net.responseBody(input.requestRef, currentPage.tabId);", page),
  define("read_console", "Read captured console messages. limit defaults to 100, max 100. integrity describes captured history; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list.", z.object({ ...pageFields, limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.console({limit:input.limit, offset:input.offset}, currentPage.tabId);", { ...page, summary: "Read captured console messages." }),
  define("fetch", "Fetch in the explicit page or extension context; contexts have different permissions and credentials.", z.object({ ...pageFields, context: z.enum(["page", "extension"]), url: z.string().min(1), init: z.object({ method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), credentials: z.enum(["omit", "same-origin", "include"]).optional() }).strict().optional() }).strict(), "return await net.fetch({context:input.context, url:input.url, init:input.init, tabId:input.tabId});"),
  define("evaluate_js", "Execute a JavaScript body in the explicitly selected page world.", z.object({ tabId: z.number().int().nonnegative(), timeoutMs, world: z.enum(["MAIN", "ISOLATED", "USER_SCRIPT"]), code: z.string().min(1), frameId: z.number().int().nonnegative().optional(), documentId: z.string().min(1).optional() }).strict(), "return await browser.runIn({kind:'page', tabId:input.tabId, world:input.world, frameId:input.frameId, documentId:input.documentId}, input.code);"),
  define("list_cdp_sessions", "List CDP sessions owned by the selected tab.", pageArgs, "return await protocol.sessions(currentPage.tabId);", page),
  define("send_cdp", "Send a Chrome DevTools Protocol command to an owned tab or session.", z.object({ timeoutMs, tabId: z.number().int().nonnegative(), sessionId: z.string().min(1).optional(), method: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }).strict(), "return await protocol.send({tabId:input.tabId, sessionId:input.sessionId}, input.method, input.params);"),
]);
