import { dynamicTool, type ToolCallRepairFunction } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { BrowserInput } from "../types";
import type { ChromeExecutor } from "./executor";
import { getRunIdentity } from "../agent/coordinator";

export const COMMAND_NAMES = [
  "goto", "type", "click", "dblclick", "fill", "drag", "drop", "hover", "select", "upload", "check", "uncheck", "snapshot", "find", "eval", "dialog-accept", "dialog-dismiss", "go-back", "go-forward", "reload", "press", "keydown", "keyup", "mousemove", "mousedown", "mouseup", "mousewheel", "screenshot", "pdf", "tab-list", "tab-new", "tab-close", "tab-select", "requests", "request", "request-headers", "request-body", "response-headers", "response-body", "console", "run-code", "artifact-save"
] as const;
export const USER_SCRIPT_TOOL_NAMES = ["userscript-list", "userscript-read", "userscript-create", "userscript-edit", "userscript-set-enabled"] as const;

export type CommandName = typeof COMMAND_NAMES[number];

const timeoutMs = z.number().int().positive().max(300_000).optional();
const common = { timeoutMs };
const save = z.boolean().optional();
const button = z.enum(["left", "right", "middle"]).optional();
const modifiers = z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional();
const elementTargetObject = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional() }).strict(),
]);
const pointTargetObject = z.object({ point: z.object({ observationId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }).strict() }).strict();
const targetObject = z.union([elementTargetObject, pointTargetObject]);
export const commandTargetSchema = z.union([z.string().min(1), targetObject]);
const file = z.object({ name: z.string().min(1), mimeType: z.string().min(1).optional(), text: z.string().optional(), base64: z.string().optional(), url: z.string().url().optional(), artifactId: z.number().int().positive().optional() }).strict()
  .refine((value) => [value.text, value.base64, value.url, value.artifactId].filter((item) => item !== undefined).length === 1, "Exactly one of text, base64, url, or artifactId is required");
const files = z.array(file).min(1);
const browserStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }).strict(),
  ...(["click", "doubleClick", "hover"] as const).map((kind) => z.object({ type: z.literal(kind), target: targetObject, button, modifiers }).strict()),
  z.object({ type: z.literal("fill"), target: elementTargetObject, value: z.string() }).strict(),
  z.object({ type: z.literal("clear"), target: elementTargetObject }).strict(),
  z.object({ type: z.literal("press"), target: elementTargetObject.optional(), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("insertText"), target: elementTargetObject.optional(), text: z.string() }).strict(),
  z.object({ type: z.literal("select"), target: elementTargetObject, values: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("check"), target: elementTargetObject, checked: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("drag"), from: elementTargetObject, to: elementTargetObject }).strict(),
  z.object({ type: z.literal("upload"), target: elementTargetObject, files }).strict(),
  z.object({
    type: z.literal("expect"), target: elementTargetObject.optional(),
    state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked"]).optional(),
    text: z.string().optional(), value: z.string().optional(), url: z.string().optional(),
  }).strict().refine((value) => Boolean(value.url || value.target && (value.state || value.text !== undefined || value.value !== undefined)), "expect requires url or a target condition"),
]);
export const actInputSchema = z.object({
  observationId: z.string().min(1).optional(), steps: z.array(browserStepSchema).min(1), timeoutMs,
}).strict();
export const resultInputSchema = z.object({
  id: z.number().int().positive(), path: z.union([z.string(), z.array(z.union([z.string(), z.number().int()]))]).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().nonnegative().optional(),
}).strict();
const empty = () => z.object(common).strict();
const target = (required = true, point = false) => {
  const schema = point ? commandTargetSchema : z.union([z.string().min(1), elementTargetObject]);
  return required ? schema : schema.optional();
};
const index = z.number().int().nonnegative();
const requestIndex = z.number().int().positive();
const filename = z.string().min(1).optional();
const scriptId = z.string().min(1).refine((id) => !id.startsWith("_"), "Script IDs cannot start with _");
const scriptSource = z.union([z.object({ code: z.string().min(1) }).strict(), z.object({ file: z.string().min(1) }).strict()]);
const scriptFields = {
  matches: z.array(z.string().min(1)).min(1),
  js: z.array(scriptSource).min(1),
  allFrames: z.boolean(),
  excludeGlobs: z.array(z.string()),
  excludeMatches: z.array(z.string()),
  includeGlobs: z.array(z.string()),
  runAt: z.enum(["document_start", "document_end", "document_idle"]),
  world: z.enum(["USER_SCRIPT", "MAIN"]),
  worldId: z.string().min(1),
};
const scriptDefinition = z.object({ id: scriptId, matches: scriptFields.matches, js: scriptFields.js,
  allFrames: scriptFields.allFrames.optional(), excludeGlobs: scriptFields.excludeGlobs.optional(), excludeMatches: scriptFields.excludeMatches.optional(),
  includeGlobs: scriptFields.includeGlobs.optional(), runAt: scriptFields.runAt.optional(), world: scriptFields.world.optional(), worldId: scriptFields.worldId.optional(),
}).strict();
const scriptChanges = z.object({
  matches: scriptFields.matches.optional(), js: scriptFields.js.optional(),
  allFrames: scriptFields.allFrames.nullable().optional(), excludeGlobs: scriptFields.excludeGlobs.nullable().optional(),
  excludeMatches: scriptFields.excludeMatches.nullable().optional(), includeGlobs: scriptFields.includeGlobs.nullable().optional(),
  runAt: scriptFields.runAt.nullable().optional(), world: scriptFields.world.nullable().optional(), worldId: scriptFields.worldId.nullable().optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, "At least one field is required");
const userScriptDefinitions = {
  "userscript-list": { description: "List saved user scripts with IDs, match patterns, and enabled state; excludes source code.", inputSchema: z.object({}).strict(), method: "list" },
  "userscript-read": { description: "Read one saved user script's complete definition and enabled state by ID.", inputSchema: z.object({ id: scriptId }).strict(), method: "read" },
  "userscript-create": { description: "Create and enable a user script from a Chrome RegisteredUserScript definition. Fails if the ID exists.", inputSchema: z.object({ script: scriptDefinition }).strict(), method: "create" },
  "userscript-edit": { description: "Edit specified fields of a saved user script, preserving its enabled state. Replace js and matches as whole fields; set optional fields to null to remove them.", inputSchema: z.object({ id: scriptId, changes: scriptChanges }).strict(), method: "edit" },
  "userscript-set-enabled": { description: "Enable or disable a saved user script by ID. Repeating the same state succeeds.", inputSchema: z.object({ id: scriptId, enabled: z.boolean() }).strict(), method: "setEnabled" },
} as const;

export async function callUserScriptTool(method: string, args: unknown[], signal?: AbortSignal, onDispatch?: () => Promise<void>): Promise<unknown> {
  const definition = Object.values(userScriptDefinitions).find((item) => item.method === method);
  if (!definition) throw new Error("Unsupported user script method");
  definition.inputSchema.parse(method === "list" ? {} : method === "read" ? { id: args[0] } : method === "create" ? { script: args[0] } : args[0]);
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  if (onDispatch) await onDispatch();
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  const pending = chrome.runtime.sendMessage({ type: "surf-wax:user-scripts", method, args, ...getRunIdentity(), operationId: crypto.randomUUID() });
  let onAbort: (() => void) | undefined;
  const interrupted = signal && new Promise<never>((_, reject) => {
    onAbort = () => reject(Object.assign(new DOMException("Operation aborted", "AbortError"), { effectUnknown: !["list", "read"].includes(method) }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const response = await (interrupted ? Promise.race([pending, interrupted]) : pending);
    if (!response?.ok) throw new Error(response?.error ?? "用户脚本操作失败");
    return response.result;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

type Definition = { description: string; inputSchema: z.ZodTypeAny };
const definitions: Record<CommandName, Definition> = {
  goto: { description: "Navigate the current tab to a URL.", inputSchema: z.object({ ...common, url: z.string().url() }).strict() },
  type: { description: "Type text into the focused element.", inputSchema: z.object({ ...common, text: z.string(), submit: z.boolean().optional() }).strict() },
  click: { description: "Click a target from snapshot ref, CSS, locator expression, or structured locator.", inputSchema: z.object({ ...common, target: target(true, true), button, modifiers }).strict() },
  dblclick: { description: "Double-click a target.", inputSchema: z.object({ ...common, target: target(true, true), button, modifiers }).strict() },
  fill: { description: "Clear and fill a target.", inputSchema: z.object({ ...common, target: target(), text: z.string(), submit: z.boolean().optional() }).strict() },
  drag: { description: "Drag one target onto another.", inputSchema: z.object({ ...common, startTarget: target(), endTarget: target() }).strict() },
  drop: { description: "Drop in-memory files or typed data onto a target.", inputSchema: z.object({ ...common, target: target(), files: files.optional(), data: z.record(z.string(), z.string()).optional() }).strict().refine((value) => Boolean(value.files?.length || value.data && Object.keys(value.data).length), "files or data is required") },
  hover: { description: "Hover over a target.", inputSchema: z.object({ ...common, target: target(true, true) }).strict() },
  select: { description: "Select one or more option values.", inputSchema: z.object({ ...common, target: target(), values: z.array(z.string()).min(1) }).strict() },
  upload: { description: "Upload one or more in-memory files to the active file input or chooser.", inputSchema: z.object({ ...common, files, target: target(false) }).strict() },
  check: { description: "Check a checkbox or radio target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  uncheck: { description: "Uncheck a checkbox target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  snapshot: { description: "Capture an accessibility snapshot with stable element refs. filename stores an internal artifact; set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, target: target(false), depth: z.number().int().nonnegative().optional(), boxes: z.boolean().optional(), filename, save }).strict() },
  find: { description: "Find matching text in a fresh accessibility snapshot.", inputSchema: z.object({ ...common, text: z.string().optional() }).strict() },
  eval: { description: "Evaluate a JavaScript function in the page or on a target element. filename stores an internal artifact; set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, func: z.string().min(1), target: target(false), filename, save }).strict() },
  "dialog-accept": { description: "Accept the active dialog, optionally with prompt text.", inputSchema: z.object({ ...common, prompt: z.string().optional() }).strict() },
  "dialog-dismiss": { description: "Dismiss the active dialog.", inputSchema: empty() },
  "go-back": { description: "Navigate back.", inputSchema: empty() },
  "go-forward": { description: "Navigate forward.", inputSchema: empty() },
  reload: { description: "Reload the current page.", inputSchema: empty() },
  press: { description: "Press a key or key chord.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  keydown: { description: "Hold a keyboard key down.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  keyup: { description: "Release a keyboard key.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  mousemove: { description: "Move the mouse to viewport CSS coordinates.", inputSchema: z.object({ ...common, x: z.number().finite(), y: z.number().finite() }).strict() },
  mousedown: { description: "Press a mouse button.", inputSchema: z.object({ ...common, button, clickCount: z.number().int().min(1).max(2).optional() }).strict() },
  mouseup: { description: "Release a mouse button.", inputSchema: z.object({ ...common, button, clickCount: z.number().int().min(1).max(2).optional() }).strict() },
  mousewheel: { description: "Scroll by viewport CSS deltas.", inputSchema: z.object({ ...common, dx: z.number().finite(), dy: z.number().finite() }).strict() },
  screenshot: { description: "Capture a viewport, full-page, or element screenshot as an internal artifact. Set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, target: target(false), filename, save, type: z.enum(["png", "jpeg", "webp"]).optional(), fullPage: z.boolean().optional(), hires: z.boolean().optional() }).strict() },
  pdf: { description: "Print the current page to an internal PDF artifact. Set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, filename, save }).strict() },
  "tab-list": { description: "List tabs in the current Chrome window using zero-based indices.", inputSchema: empty() },
  "tab-new": { description: "Open and select a new tab.", inputSchema: z.object({ ...common, url: z.string().url().optional() }).strict() },
  "tab-close": { description: "Close a tab by stable tabId or legacy zero-based index; omitted selects current tab.", inputSchema: z.object({ ...common, index: index.optional(), tabId: z.number().int().nonnegative().optional() }).strict().refine((value) => value.index === undefined || value.tabId === undefined, "Use tabId or index, not both") },
  "tab-select": { description: "Select a tab in the bound window by stable tabId or legacy zero-based index.", inputSchema: z.object({ ...common, index: index.optional(), tabId: z.number().int().nonnegative().optional() }).strict().refine((value) => (value.index === undefined) !== (value.tabId === undefined), "Exactly one of tabId or index is required") },
  requests: { description: "List captured requests since navigation.", inputSchema: z.object({ ...common, static: z.boolean().optional(), filter: z.string().optional(), clear: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }).strict() },
  request: { description: "Read full request and response details by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "request-headers": { description: "Read request headers by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "request-body": { description: "Read request body by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "response-headers": { description: "Read response headers by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "response-body": { description: "Read response body by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  console: { description: "List captured console messages at or above a level.", inputSchema: z.object({ ...common, minLevel: z.enum(["debug", "info", "warning", "error"]).optional(), clear: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }).strict() },
  "run-code": { description: "Run an async function receiving the bound page facade: locators (CSS/text/role/label/placeholder/alt/title/testId), ref, frameLocator, evaluate, snapshot, observe, point, keyboard, navigation, waitForURL/waitForLoadState/waitForEvent. Locators auto-wait; waitFor supports attached/detached/visible/hidden/enabled/editable/checked; nth accepts negative indices. Upload with locator.setInputFiles([{name, text|base64|url, mimeType?}]); no filesystem paths. Returns serializable values or an object reference. Use dedicated tools to save artifacts.", inputSchema: z.object({ ...common, code: z.string().min(1), save }).strict() },
  "artifact-save": { description: "Save an existing internal artifact to Downloads only when the user explicitly requested it.", inputSchema: z.object({ ...common, id: z.number().int().positive(), filename }).strict() },
};

const ACT_DESCRIPTION = "Execute deterministic browser steps as one batch, without a step-count limit. Prefer a dedicated command for one action; use act for two or more related actions and include expect steps for outcomes.";
const RESULT_DESCRIPTION = "Read an exact slice or path from a large tool result stored in the canonical event log. Use the access object returned with $ref.";

export const TOOL_REGISTRY = Object.freeze([
  ...COMMAND_NAMES.map((name) => ({ name, kind: "command" as const, ...definitions[name], summary: name === "run-code" ? "Run an async function with the bound page facade and auto-waiting locators" : definitions[name].description.split(". ")[0]!.split("; ")[0]! })),
  { name: "act", kind: "batch" as const, description: ACT_DESCRIPTION, inputSchema: actInputSchema, summary: "Execute sequential browser actions with assertions; stops at first failure" },
  { name: "result", kind: "result" as const, description: RESULT_DESCRIPTION, inputSchema: resultInputSchema, summary: "Read a stored result by ID, path, and slice" },
  ...USER_SCRIPT_TOOL_NAMES.map((name) => ({ name, kind: "userscript" as const, ...userScriptDefinitions[name], summary: userScriptDefinitions[name].description.split(". ")[0]! })),
]);
export const TOOL_SUMMARY = TOOL_REGISTRY.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n");
export const TOOL_CATALOG_VERSION = "formal-49-v2";
export const TOOL_CONTEXT = `Available tools:\n${TOOL_SUMMARY}`;

export const PROGRAM_CATALOG_VERSION = "inspect-run-jobs-v1";
export const inspectInputSchema = z.object({ timeoutMs, tabId: z.number().int().nonnegative().optional(), region: target(false),
  fields: z.array(z.enum(["text", "state", "ref", "actions"])).min(1).optional(), budget: z.number().int().min(100).max(1000000).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), depth: z.number().int().nonnegative().optional(),
  since: z.string().min(1).optional(), image: z.boolean().optional() }).strict();
export const runInputSchema = z.object({ code: z.string().min(1), background: z.boolean().optional(), timeoutMs }).strict();
export const jobsInputSchema = z.object({ action: z.enum(["list", "status", "wait", "cancel"]), id: z.string().min(1).optional(),
  after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional(), waitMs: z.number().int().min(0).max(30000).optional() }).strict()
  .refine((value) => value.action === "list" || Boolean(value.id), "id is required for status, wait, and cancel");
export const PROGRAM_TOOL_REGISTRY = Object.freeze([
  { name: "inspect", inputSchema: inspectInputSchema, summary: "Read referenced semantic text; request images only when needed",
    description: "Inspect the bound page as semantic text with stable refs and tab/document ownership. region selects a locator subtree; fields selects text/state/ref/actions; budget limits returned characters with explicit truncation and nextOffset. since returns changes only for the same document/region/fields; a truncated baseline resets to full. image=true explicitly captures a screenshot artifact for images, layout, Canvas, or ambiguity; default never captures pixels." },
  { name: "run", inputSchema: runInputSchema, summary: "Execute one operation or a composable async JavaScript program",
    description: "Execute an async JavaScript body with page, browser, net, protocol, artifacts, emit, check, sleep, signal. Example: await page.getByLabel('Email').fill('a@example.com'); await check(await page.getByLabel('Email').inputValue() === 'a@example.com'); return await page.inspect(); Supports variables/loops/conditions/filtering, locators/frames, page.evaluate, native input, tabs, persistent scripts, explicit page/extension fetch, scoped CDP, and artifacts. Mutations are ordered and recorded as receipts. Subscribe with page.waitForEvent before triggering actions. background=true starts a cancellable job; defaults: 10s foreground / 300s background; jobs reads progress and results. No hidden agent or side-effect retries. See the runtime API appended to the system prompt." },
  { name: "jobs", inputSchema: jobsInputSchema, summary: "Read incremental job receipts, wait, or cancel without blocking execution",
    description: "Manage programs in this conversation: list; status(id,after?,limit?); wait(id,waitMs<=30000,after?,limit?); cancel(id). after/nextCursor are canonical event IDs. Job status and output are projections of the canonical log, available independently of the execution queue. accepted/queued is not completion; completed input is not business success. Cancellation is not rollback. Lost hosts become interrupted and are never automatically replayed or resumed from a JavaScript stack." },
]);
export const PROGRAM_API = `run API (async JavaScript body; no function wrapper required):
page: tabId; inspect(options?, regionLocator?); snapshot(); observe('semantic'|'visual'); ref/locator/frameLocator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId; goto/reload/goBack/goForward; url/title; evaluate(functionOrString,arg?); waitForURL/waitForLoadState/waitForEvent('dialog'|'popup'|'download'|'filechooser'); point(observationId,x,y,'click'|'dblclick'|'hover',options?); upload(files); drop(target,{files?,data?}); screenshot(options?); pdf({filename?,save?}); keyboard.press/insertText/down/up; mouse.move/down/up/wheel.
locators: chain/filter/first/last/nth, count/waitFor/click/dblclick/hover/fill/clear/press/pressSequentially/check/uncheck/selectOption/dragTo/setInputFiles/focus/blur/scrollIntoViewIfNeeded/textContent/innerText/inputValue/getAttribute/isVisible/isEnabled/isChecked/evaluate. Files: {name,mimeType?,text|base64|url}; artifacts.read supplies existing file data. Event handles: chooser.isMultiple()/setFiles(files), dialog.type()/message()/defaultValue()/accept(prompt?)/dismiss(), popup is a page. Start event waits before the action, then await them.
browser: page(tabId); tabs.list()/open(url?)/select(tabId)/close(tabId); scripts.list()/read(id)/create(definition)/edit(id,changes)/setEnabled(id,enabled). Scripts use Chrome RegisteredUserScript fields including matches, js:[{code|file}], world:MAIN|USER_SCRIPT, runAt, allFrames, include/excludeGlobs/Matches, worldId. Persisted enablement is restored at startup/upgrade; Allow User Scripts must already be enabled.
browser.runIn({kind:'page',tabId,world:'MAIN'|'ISOLATED'|'USER_SCRIPT',frameId?,documentId?},codeBody): explicit execution domain. MAIN/ISOLATED root only; USER_SCRIPT supports Chrome frameId or documentId. Use frameLocator.evaluate for arbitrary supported frames. No automatic context substitution.
net.fetch({context:'page'|'extension',url,tabId?,init?}) returns {url,status,ok,headers,body}; no page-to-extension fallback. Page fetch obeys page origin/cookies/CORS; extension fetch uses extension host permissions. net.requests(options?,tabId?)/request(index,tabId?); net.responseBody(index,tabId?); net.console(options?,tabId?) read captured diagnostics.
protocol.sessions(tabId?) lists owned root/child CDP handles; protocol.send({tabId,sessionId?},method,params?): CDP Page/DOM/Runtime/Accessibility/Network/Log/Input only, in the bound window and known child sessions. No Browser/Target/permission APIs. Arbitrary JS/CDP/fetch are effectful; there is no readonly override. inspect.documentId is the local navigation generation; USER_SCRIPT documentId uses Chrome's native scripting document ID. File URL sources are fetched in extension context.
artifacts.read(id,{path?,offset?,limit?}); text(filename,text,mimeType?,save=false); save(id,filename?). Files and images stay internal unless the user requested download/export. emit(value) persists incremental output; check(condition,message?) records a verified assertion; sleep(ms) and signal support cancellation. Completed operations only confirm dispatch/return; verify application outcomes. Queued operations are not dispatched, uncertain effects must be inspected before continuing. Program computation uses a disposable opaque-origin sandbox Worker; browser capabilities are mediated by the Side Panel. Closing the panel cancels jobs and revokes capabilities; arbitrary program finally blocks are not guaranteed to run. Only records survive restart, never arbitrary JS stacks.`;
export const PROGRAM_TOOL_CONTEXT = `Available tools:\n${PROGRAM_TOOL_REGISTRY.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n")}\n\n${PROGRAM_API}`;

export function createProgramTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}): Record<string, ReturnType<typeof dynamicTool>> {
  return Object.fromEntries(PROGRAM_TOOL_REGISTRY.map((definition) => [definition.name, dynamicTool({
    description: definition.description, inputSchema: definition.inputSchema, needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => {
      const identity = options.conversationId ? options.logger?.toolIdentity(options.conversationId, toolCallId) : undefined;
      const context = { conversationId: options.conversationId, toolCallId, logIdentity: identity, visualEnabled: await options.visualEnabled?.() ?? false };
      try {
        const value = definition.inputSchema.parse(input);
        const result = definition.name === "inspect" ? await executor.inspect(value as any, abortSignal, context)
          : definition.name === "run" ? await executor.runProgram(value as any, abortSignal, context) : await executor.queryJobs(value as any, abortSignal, context);
        const failure = (result as any)?.ok === false ? (result as any).error ?? (result as any).failed?.error ?? (result as any).result?.error : undefined;
        const normalized = failure ? { ...result as object, error: { ...failure, retryable: false } } : result;
        return compactToolResult(normalized, { ...options, toolCallId, ...identity });
      } catch (error) {
        const failure = toolFailure(error); failure.error.retryable = false;
        if (!failure.artifact && options.logger && identity?.runId) {
          const artifact = await options.logger.toolArtifact(options.conversationId!, identity).catch(() => undefined);
          if (artifact) failure.artifact = artifact;
        }
        return failure;
      }
    },
  })]));
}

export function parseCommandInput(name: CommandName, input: unknown): Record<string, unknown> {
  return definitions[name].inputSchema.parse(input) as Record<string, unknown>;
}

export function normalizeCommandInput(name: string, input: unknown): unknown | undefined {
  if (name !== "mousewheel" || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if ((Object.hasOwn(value, "deltaX") && Object.hasOwn(value, "dx") && value.deltaX !== value.dx)
    || (Object.hasOwn(value, "deltaY") && Object.hasOwn(value, "dy") && value.deltaY !== value.dy)) return undefined;
  const { deltaX, deltaY, ...rest } = value;
  if (Object.hasOwn(value, "deltaX") && !Object.hasOwn(value, "dx")) rest.dx = deltaX;
  if (Object.hasOwn(value, "deltaY") && !Object.hasOwn(value, "dy")) rest.dy = deltaY;
  return rest;
}

const LARGE_RESULT_BYTES = 8 * 1024;

function hasScreenshot(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("screenshot" in value && (typeof (value as any).screenshot?.data === "string" || Number.isSafeInteger((value as any).screenshot?.artifactId)) || Object.values(value).some(hasScreenshot)));
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, part) => current !== null && typeof current === "object" ? (current as any)[part] : undefined, value);
}

function readablePathOf(value: unknown): Array<string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const path of [["snapshot"], ["observation", "snapshot"], ["text"], ["html"]] as const) {
    const selected = valueAt(value, path);
    if (typeof selected === "string" || Array.isArray(selected)) return [...path];
  }
  const key = Object.keys(value).find((candidate) => typeof (value as Record<string, unknown>)[candidate] === "string" || Array.isArray((value as Record<string, unknown>)[candidate]));
  return key ? [key] : undefined;
}

function previewOf(value: unknown, path?: readonly (string | number)[]): unknown {
  const selected = path ? valueAt(value, path) : value;
  if (typeof selected === "string") return selected.slice(0, 4000);
  if (Array.isArray(selected)) return selected.slice(0, 50);
  if (selected && typeof selected === "object") return Object.fromEntries(Object.entries(selected).slice(0, 16));
  return selected;
}

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string; runId?: string; toolCallIdCanonical?: boolean }): Promise<unknown> {
  if ((value && typeof value === "object" && ("$ref" in value || (value as any).ok === false || (value as any).type === "tool-error")) || !options.logger || hasScreenshot(value)) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (serialized === undefined) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, runId: options.runId, toolCallIdCanonical: options.toolCallIdCanonical, content: { bytes }, output: value });
  if (!event) throw new Error("Could not save large tool result");
  const path = readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const access = { id: event.id, ...(path ? { path } : {}), ...(typeof selected === "string" ? { offset: 0, limit: 4000 } : Array.isArray(selected) ? { offset: 0, limit: 50 } : {}) };
  return { $ref: event.id, bytes, preview: previewOf(value, path), access, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value };
}

function toolFailure(error: unknown): { ok: false; error: { code: string; message: string; retryable: boolean; effectUnknown?: boolean }; artifact?: unknown } {
  const message = error instanceof Error || error instanceof DOMException ? error.message : String(error);
  const code = error instanceof DOMException && error.name === "AbortError" ? "aborted"
    : error instanceof DOMException && error.name === "TimeoutError" ? "timeout"
    : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
    : /(?:Command|Automation)Error\[([^\]]+)\]/.exec(message)?.[1] ?? "tool-error";
  const effectUnknown = Boolean(error && typeof error === "object" && "effectUnknown" in error && error.effectUnknown);
  return { ok: false, error: { code, message, retryable: code === "timeout" && !effectUnknown, ...(effectUnknown ? { effectUnknown: true } : {}) }, ...(error && typeof error === "object" && "artifact" in error ? { artifact: error.artifact } : {}) };
}

export function createCommandTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}): Record<string, ReturnType<typeof dynamicTool>> {
  const context = async (toolCallId: string) => {
    const logIdentity = options.conversationId ? options.logger?.toolIdentity(options.conversationId, toolCallId) : undefined;
    return { conversationId: options.conversationId, toolCallId, logIdentity, visualEnabled: await options.visualEnabled?.() ?? false };
  };
  const run = async (operation: () => Promise<unknown>, toolCallId: string, compact = true) => {
    const identity = options.conversationId ? options.logger?.toolIdentity(options.conversationId, toolCallId) : undefined;
    try {
      const raw = await operation();
      const failure = raw && typeof raw === "object" && (raw as any).ok === false ? (raw as any).error ?? (raw as any).failed?.error : undefined;
      const result = failure
        ? { ...(raw as Record<string, unknown>), error: { ...failure, retryable: failure.retryable ?? (failure.code === "timeout" && !failure.effectUnknown) } }
        : raw;
      return compact ? compactToolResult(result, { ...options, toolCallId, ...identity }) : result;
    } catch (error) {
      const failure = toolFailure(error);
      if (!failure.artifact && options.logger && identity?.runId) {
        const artifact = await options.logger.toolArtifact(options.conversationId!, identity).catch(() => undefined);
        if (artifact) failure.artifact = artifact;
      }
      return failure;
    }
  };
  return Object.fromEntries(TOOL_REGISTRY.map((definition) => [definition.name, dynamicTool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      needsApproval: false,
      execute: async (input, { abortSignal, toolCallId }) => run(async () => {
        const value = definition.inputSchema.parse(input);
        if (definition.kind === "command") return executor.executeCommand(definition.name as CommandName, value as Record<string, unknown>, abortSignal, await context(toolCallId));
        if (definition.kind === "userscript") {
          const fields = value as { id?: string; script?: unknown; changes?: unknown; enabled?: boolean };
          const args = definition.name === "userscript-list" ? [] : definition.name === "userscript-read" ? [fields.id]
            : definition.name === "userscript-create" ? [fields.script] : [fields];
          return callUserScriptTool(definition.method, args, abortSignal);
        }
        return executor.executeBrowser({ mode: definition.kind === "batch" ? "act" : "result", ...(value as object) } as BrowserInput, abortSignal, await context(toolCallId));
      }, toolCallId, definition.kind !== "result"),
    })]));
}

export const repairCommandToolCall: ToolCallRepairFunction<Record<string, ReturnType<typeof dynamicTool>>> = async ({ toolCall, tools }) => {
  const normalize = (value: string) => value.toLowerCase().replace(/_/g, "-");
  let toolName = toolCall.toolName;
  if (!Object.hasOwn(tools, toolName)) {
    const matches = Object.keys(tools).filter((name) => normalize(name) === normalize(toolName));
    if (matches.length !== 1) return null;
    toolName = matches[0]!;
  }
  let input: unknown;
  try {
    input = JSON.parse(toolCall.input);
    if (typeof input === "string") input = JSON.parse(input);
    if (toolName === "act" && input && typeof input === "object" && typeof (input as any).steps === "string") {
      input = { ...(input as Record<string, unknown>), steps: JSON.parse((input as any).steps) };
    }
  } catch { return null; }
  input = normalizeCommandInput(toolName, input);
  if (input === undefined) return null;
  const repaired = JSON.stringify(input);
  return toolName === toolCall.toolName && repaired === toolCall.input ? null : { ...toolCall, toolName, input: repaired };
};

type ScreenshotSource = { mediaType: string; data?: string; artifactId?: number };

function scrubScreenshots(value: unknown, found: ScreenshotSource[]): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubScreenshots(item, found));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "screenshot" && item && typeof item === "object") {
      const screenshot = item as Record<string, unknown>;
      if (typeof screenshot.data === "string") {
        found.push({ mediaType: typeof screenshot.mediaType === "string" ? screenshot.mediaType : "image/png", data: screenshot.data });
        return [key, { ...screenshot, data: "[stored in canonical event log]" }];
      }
      if (Number.isSafeInteger(screenshot.artifactId)) found.push({ mediaType: typeof screenshot.mediaType === "string" ? screenshot.mediaType : "image/png", artifactId: Number(screenshot.artifactId) });
    }
    return [key, scrubScreenshots(item, found)];
  }));
}

export async function prepareToolMessages(messages: any[], stepNumber: number, browserContext?: string, readArtifact?: (id: number) => Promise<unknown>, legacyCatalog = true): Promise<any[]> {
  const inject = stepNumber > 0 && messages.at(-1)?.role === "tool";
  const current: ScreenshotSource[] = [];
  const firstUser = messages.findIndex((message) => message.role === "user");
  const hasCatalog = messages.some((message) => typeof message.content === "string" ? message.content.includes("Available tools:\n")
    : Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && typeof part.text === "string" && part.text.includes("Available tools:\n")));
  const withTools = !legacyCatalog || firstUser < 0 || hasCatalog ? messages : messages.map((message, index) => {
    if (index !== firstUser) return message;
    if (typeof message.content === "string") return message.content.includes("Available tools:\n")
      ? message : { ...message, content: `${message.content}\n\n${TOOL_CONTEXT}` };
    if (!Array.isArray(message.content) || message.content.some((part: any) => part.type === "text" && typeof part.text === "string" && part.text.includes("Available tools:\n"))) return message;
    return { ...message, content: [...message.content, { type: "text", text: TOOL_CONTEXT }] };
  });
  const prepared = withTools.map((message, index) => message.role !== "tool" ? message : { ...message, content: message.content.map((part: any) => {
    if (part.type !== "tool-result" || part.output?.type !== "json") return part;
    const found: ScreenshotSource[] = [];
    const value = scrubScreenshots(part.output.value, found);
    if (inject && index === withTools.length - 1) current.push(...found);
    return { ...part, output: { ...part.output, value } };
  }) });
  const source = current.at(-1);
  const stored = source?.artifactId !== undefined && readArtifact ? await readArtifact(source.artifactId) as { base64?: unknown; mimeType?: unknown } : undefined;
  const screenshot = source && (source.data || typeof stored?.base64 === "string") ? {
    mediaType: typeof stored?.mimeType === "string" ? stored.mimeType : source.mediaType,
    data: source.data ?? stored!.base64 as string,
  } : undefined;
  const content = [
    ...(browserContext ? [{ type: "text", text: browserContext }] : []),
    ...(screenshot ? [{ type: "file", mediaType: screenshot.mediaType, data: { type: "data", data: screenshot.data } }] : []),
  ];
  return content.length ? [...prepared, { role: "user", content }] : prepared;
}
