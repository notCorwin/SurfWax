import { z } from "zod";

// The public schemas are kept separate from the program API. Arguments are encoded
// as JSON data, never interpolated as JavaScript source.
const target = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional() }).strict(),
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
  const root = target.frame ? page.frameLocator(target.frame.value) : page;
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
  program: (input: unknown) => { code: string; timeoutMs?: number };
};

function define(name: string, summary: string, inputSchema: z.ZodType<any>, body: string, options: { page?: boolean; locators?: boolean } = {}): AtomicToolDefinition {
  return {
    name, summary, description: summary, inputSchema,
    program(input) {
      const parsed = inputSchema.parse(input);
      const encoded = JSON.stringify(JSON.stringify(parsed));
      const code = `const input = JSON.parse(${encoded});\n${options.locators ? selector : ""}\n${options.page ? "const currentPage = input.tabId === undefined ? page : await browser.page(input.tabId);" : ""}\n${body}`;
      return { code, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) };
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
  define("fill", "Replace an editable element's value; an empty value clears it.", z.object({ ...targetFields, value: z.string() }).strict(), "return await locate(currentPage, input.target).fill(input.value);", locator),
  define("type_text", "Enter text character by character into an editable element.", z.object({ ...targetFields, text: z.string() }).strict(), "return await locate(currentPage, input.target).pressSequentially(input.text);", locator),
  define("press_key", "Press a key or chord, optionally focusing an element first.", z.object({ ...pageFields, target: target.optional(), key: z.string().min(1) }).strict(), "return input.target ? await locate(currentPage, input.target).press(input.key) : await currentPage.keyboard.press(input.key);", locator),
  define("key_down", "Hold a key until key_up or run cleanup.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.down(input.key);", page),
  define("key_up", "Release a held key.", z.object({ ...pageFields, key: z.string().min(1) }).strict(), "return await currentPage.keyboard.up(input.key);", page),
  define("set_checked", "Set a checkbox or radio button to the requested checked state.", z.object({ ...targetFields, checked: z.boolean() }).strict(), `const element = locate(currentPage, input.target);
    if (!input.checked && await element.isChecked() && (await element.getAttribute('type'))?.toLowerCase() === 'radio') throw new Error('AutomationError[invalid-state]: Cannot uncheck a selected radio button');
    return input.checked ? await element.check() : await element.uncheck();`, locator),
  define("select_option", "Select option values or labels on a select element.", z.object({ ...targetFields, value: z.union([z.string(), z.array(z.string()).min(1)]) }).strict(), "return await locate(currentPage, input.target).selectOption(input.value);", locator),
  define("drag", "Drag one element to another.", z.object({ ...pageFields, source: target, destination: target }).strict(), "return await locate(currentPage, input.source).dragTo(locate(currentPage, input.destination));", locator),
  define("scroll", "Scroll the page by a horizontal and vertical delta at the current pointer.", z.object({ ...pageFields, deltaX: z.number().optional(), deltaY: z.number() }).strict(), "return await currentPage.mouse.wheel(input.deltaX ?? 0, input.deltaY);", page),
  define("press_pointer", "Press a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.down(input.button);", page),
  define("release_pointer", "Release a pointer button at its current position.", z.object({ ...pageFields, button: z.enum(["left", "middle", "right"]).optional() }).strict(), "return await currentPage.mouse.up(input.button);", page),
  targetAction("read_text", "Read an element's visible text.", "innerText"),
  targetAction("read_value", "Read a form element's current value.", "inputValue"),
  targetAction("read_checked", "Read an element's checked state.", "isChecked"),
  define("read_attribute", "Read an element's named attribute.", z.object({ ...targetFields, name: z.string().min(1) }).strict(), "return await locate(currentPage, input.target).getAttribute(input.name);", locator),
  define("wait_for_url", "Wait until the page URL contains the given text.", z.object({ ...pageFields, url: z.string().min(1) }).strict(), "return await currentPage.waitForURL(input.url);", page),
  define("navigate", "Navigate the selected page to a URL.", z.object({ ...pageFields, url: z.string().min(1) }).strict(), "return await currentPage.goto(input.url);", page),
  define("reload", "Reload the selected page.", pageArgs, "return await currentPage.reload();", page),
  define("go_back", "Navigate back in the selected page history.", pageArgs, "return await currentPage.goBack();", page),
  define("go_forward", "Navigate forward in the selected page history.", pageArgs, "return await currentPage.goForward();", page),
  define("list_tabs", "List tabs across browser windows.", noArgs, "return await browser.tabs.list();"),
  define("open_tab", "Open a tab in the bound browser window.", z.object({ timeoutMs, url: z.string().min(1).optional() }).strict(), "const opened = await browser.tabs.open(input.url); return { tabId: opened.tabId };"),
  define("switch_tab", "Switch the bound page to a tab.", z.object({ timeoutMs, tabId: z.number().int().nonnegative() }).strict(), "return await browser.tabs.select(input.tabId);"),
  define("close_tab", "Close a tab.", z.object({ timeoutMs, tabId: z.number().int().nonnegative() }).strict(), "return await browser.tabs.close(input.tabId);"),
  define("take_screenshot", "Capture a screenshot when visual input is enabled.", z.object({ ...pageFields, target: target.optional() }).strict(), "return await currentPage.screenshot(input.target ? { target: input.target } : {});", page),
  define("create_pdf", "Create a PDF artifact of the selected page.", pageArgs, "return await currentPage.pdf();", page),
  define("read_artifact", "Read a stored artifact or large tool result by ID.", z.object({ timeoutMs, artifactId: z.number().int().positive(), path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict(), "return await artifacts.read(input.artifactId, {path:input.path, offset:input.offset, limit:input.limit});"),
  define("create_text_artifact", "Store text as an internal artifact.", z.object({ timeoutMs, filename: z.string().min(1), text: z.string(), mimeType: z.string().min(1).optional() }).strict(), "return await artifacts.text(input.filename, input.text, input.mimeType);"),
  define("save_artifact", "Export an internal artifact to a file.", z.object({ timeoutMs, artifactId: z.number().int().positive(), filename: z.string().min(1).optional() }).strict(), "return await artifacts.save(input.artifactId, input.filename);"),
  define("list_scripts", "List persisted user scripts and their state.", noArgs, "return await browser.scripts.list();"),
  define("read_script", "Read a persisted user script by ID.", z.object({ timeoutMs, scriptId: z.string().min(1) }).strict(), "return await browser.scripts.read(input.scriptId);"),
  define("create_script", "Create a persisted user script.", z.object({ timeoutMs, definition: scriptDefinition }).strict(), "return await browser.scripts.create(input.definition);"),
  define("update_script", "Update a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1), changes: scriptChanges }).strict(), "return await browser.scripts.edit(input.scriptId, input.changes);"),
  define("set_script_enabled", "Enable or disable a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1), enabled: z.boolean() }).strict(), "return await browser.scripts.setEnabled(input.scriptId, input.enabled);"),
  define("delete_script", "Delete a persisted user script.", z.object({ timeoutMs, scriptId: z.string().min(1) }).strict(), "return await browser.scripts.delete(input.scriptId);"),
  define("list_requests", "Read captured network requests for the selected tab.", z.object({ ...pageFields, limit: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.requests({limit:input.limit, offset:input.offset}, currentPage.tabId);", page),
  define("read_response", "Read a captured response body by request index.", z.object({ ...pageFields, requestIndex: z.number().int().nonnegative() }).strict(), "return await net.responseBody(input.requestIndex, currentPage.tabId);", page),
  define("read_console", "Read captured console messages for the selected tab.", z.object({ ...pageFields, limit: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() }).strict(), "return await net.console({limit:input.limit, offset:input.offset}, currentPage.tabId);", page),
  define("fetch", "Fetch in the explicit page or extension context; contexts have different permissions and credentials.", z.object({ ...pageFields, context: z.enum(["page", "extension"]), url: z.string().min(1), init: z.object({ method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), credentials: z.enum(["omit", "same-origin", "include"]).optional() }).strict().optional() }).strict(), "return await net.fetch({context:input.context, url:input.url, init:input.init, tabId:input.tabId});"),
  define("evaluate_js", "Execute a JavaScript body in the explicitly selected page world.", z.object({ tabId: z.number().int().nonnegative(), timeoutMs, world: z.enum(["MAIN", "ISOLATED", "USER_SCRIPT"]), code: z.string().min(1), frameId: z.number().int().nonnegative().optional(), documentId: z.string().min(1).optional() }).strict(), "return await browser.runIn({kind:'page', tabId:input.tabId, world:input.world, frameId:input.frameId, documentId:input.documentId}, input.code);"),
  define("list_cdp_sessions", "List CDP sessions owned by the selected tab.", pageArgs, "return await protocol.sessions(currentPage.tabId);", page),
  define("send_cdp", "Send a Chrome DevTools Protocol command to an owned tab or session.", z.object({ timeoutMs, tabId: z.number().int().nonnegative(), sessionId: z.string().min(1).optional(), method: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }).strict(), "return await protocol.send({tabId:input.tabId, sessionId:input.sessionId}, input.method, input.params);"),
]);
