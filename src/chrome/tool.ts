import { dynamicTool } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { ChromeExecutor } from "./executor";

export const COMMAND_NAMES = [
  "open", "attach", "close", "detach", "goto", "type", "click", "dblclick", "fill", "drag", "drop", "hover", "select", "upload", "check", "uncheck", "snapshot", "find", "eval", "dialog-accept", "dialog-dismiss", "resize", "delete-data",
  "go-back", "go-forward", "reload", "press", "keydown", "keyup", "mousemove", "mousedown", "mouseup", "mousewheel", "screenshot", "pdf",
  "tab-list", "tab-new", "tab-close", "tab-select", "state-save", "state-load", "cookie-list", "cookie-get", "cookie-set", "cookie-delete", "cookie-clear",
  "localstorage-list", "localstorage-get", "localstorage-set", "localstorage-delete", "localstorage-clear", "sessionstorage-list", "sessionstorage-get", "sessionstorage-set", "sessionstorage-delete", "sessionstorage-clear",
  "requests", "request", "request-headers", "request-body", "response-headers", "response-body", "route", "route-list", "unroute", "network-state-set", "console", "run-code",
  "recording-start", "recording-stop", "tracing-start", "tracing-stop", "video-start", "video-stop", "video-chapter", "video-show-actions", "video-hide-actions", "show", "pause-at", "resume", "step-over", "generate-locator", "highlight",
  "install", "install-browser", "list", "close-all", "kill-all",
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

const session = z.string().min(1).optional().describe("Named browser session; defaults to default");
const timeoutMs = z.number().int().positive().max(300_000).optional();
const common = { session, timeoutMs };
const button = z.enum(["left", "right", "middle"]).optional();
const modifiers = z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional();
const targetObject = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional() }).strict(),
  z.object({ point: z.object({ observationId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }).strict() }).strict(),
]);
export const commandTargetSchema = z.union([z.string().min(1), targetObject]);
const file = z.object({ name: z.string().min(1), mimeType: z.string().min(1).optional(), text: z.string().optional(), base64: z.string().optional(), url: z.string().url().optional() }).strict()
  .refine((value) => [value.text, value.base64, value.url].filter((item) => item !== undefined).length === 1, "Exactly one of text, base64, or url is required");
const files = z.array(file).min(1);
const empty = () => z.object(common).strict();
const target = (required = true) => required ? commandTargetSchema : commandTargetSchema.optional();
const index = z.number().int().nonnegative();
const requestIndex = z.number().int().positive();
const filename = z.string().min(1).optional();

type Definition = { description: string; inputSchema: z.ZodTypeAny };
const definitions: Record<CommandName, Definition> = {
  open: { description: "Open a managed Chrome window, optionally at a URL.", inputSchema: z.object({ ...common, url: z.string().url().optional() }).strict() },
  attach: { description: "Attach a named session to an existing Chrome window returned by list.", inputSchema: z.object({ ...common, name: z.string().min(1) }).strict() },
  close: { description: "Close the current managed browser session.", inputSchema: empty() },
  detach: { description: "Detach the session without closing its Chrome window.", inputSchema: empty() },
  goto: { description: "Navigate the current tab to a URL.", inputSchema: z.object({ ...common, url: z.string().url() }).strict() },
  type: { description: "Type text into the focused element.", inputSchema: z.object({ ...common, text: z.string(), submit: z.boolean().optional() }).strict() },
  click: { description: "Click a target from snapshot ref, CSS, locator expression, or structured locator.", inputSchema: z.object({ ...common, target: target(), button, modifiers }).strict() },
  dblclick: { description: "Double-click a target.", inputSchema: z.object({ ...common, target: target(), button, modifiers }).strict() },
  fill: { description: "Clear and fill a target.", inputSchema: z.object({ ...common, target: target(), text: z.string(), submit: z.boolean().optional() }).strict() },
  drag: { description: "Drag one target onto another.", inputSchema: z.object({ ...common, startTarget: target(), endTarget: target() }).strict() },
  drop: { description: "Drop in-memory files or typed data onto a target.", inputSchema: z.object({ ...common, target: target(), files: files.optional(), data: z.record(z.string(), z.string()).optional() }).strict().refine((value) => Boolean(value.files?.length || value.data && Object.keys(value.data).length), "files or data is required") },
  hover: { description: "Hover over a target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  select: { description: "Select one or more option values.", inputSchema: z.object({ ...common, target: target(), values: z.array(z.string()).min(1) }).strict() },
  upload: { description: "Upload one or more in-memory files to the active file input or chooser.", inputSchema: z.object({ ...common, files, target: target(false) }).strict() },
  check: { description: "Check a checkbox or radio target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  uncheck: { description: "Uncheck a checkbox target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  snapshot: { description: "Capture an accessibility snapshot with stable element refs.", inputSchema: z.object({ ...common, target: target(false), depth: z.number().int().nonnegative().optional(), boxes: z.boolean().optional(), filename }).strict() },
  find: { description: "Find matching text in a fresh accessibility snapshot.", inputSchema: z.object({ ...common, text: z.string().optional() }).strict() },
  eval: { description: "Evaluate a JavaScript function in the page or on a target element.", inputSchema: z.object({ ...common, func: z.string().min(1), target: target(false), filename }).strict() },
  "dialog-accept": { description: "Accept the active dialog, optionally with prompt text.", inputSchema: z.object({ ...common, prompt: z.string().optional() }).strict() },
  "dialog-dismiss": { description: "Dismiss the active dialog.", inputSchema: empty() },
  resize: { description: "Resize the current page viewport.", inputSchema: z.object({ ...common, width: z.number().int().positive(), height: z.number().int().positive() }).strict() },
  "delete-data": { description: "Delete browsing data for origins visited by this session.", inputSchema: empty() },
  "go-back": { description: "Navigate back.", inputSchema: empty() },
  "go-forward": { description: "Navigate forward.", inputSchema: empty() },
  reload: { description: "Reload the current page.", inputSchema: empty() },
  press: { description: "Press a key or key chord.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  keydown: { description: "Hold a keyboard key down.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  keyup: { description: "Release a keyboard key.", inputSchema: z.object({ ...common, key: z.string().min(1) }).strict() },
  mousemove: { description: "Move the mouse to viewport CSS coordinates.", inputSchema: z.object({ ...common, x: z.number().finite(), y: z.number().finite() }).strict() },
  mousedown: { description: "Press a mouse button.", inputSchema: z.object({ ...common, button }).strict() },
  mouseup: { description: "Release a mouse button.", inputSchema: z.object({ ...common, button }).strict() },
  mousewheel: { description: "Scroll by viewport CSS deltas.", inputSchema: z.object({ ...common, dx: z.number().finite(), dy: z.number().finite() }).strict() },
  screenshot: { description: "Capture and download a viewport, full-page, or element screenshot.", inputSchema: z.object({ ...common, target: target(false), filename, type: z.enum(["png", "jpeg", "webp"]).optional(), fullPage: z.boolean().optional(), hires: z.boolean().optional() }).strict() },
  pdf: { description: "Print the current page to a downloaded PDF.", inputSchema: z.object({ ...common, filename }).strict() },
  "tab-list": { description: "List tabs in the session window using zero-based indices.", inputSchema: empty() },
  "tab-new": { description: "Open and select a new tab.", inputSchema: z.object({ ...common, url: z.string().url().optional() }).strict() },
  "tab-close": { description: "Close a tab by zero-based index, or the current tab.", inputSchema: z.object({ ...common, index: index.optional() }).strict() },
  "tab-select": { description: "Select a tab by zero-based index.", inputSchema: z.object({ ...common, index }).strict() },
  "state-save": { description: "Save cookies and visited-origin localStorage, download JSON, and retain it by filename.", inputSchema: z.object({ ...common, filename }).strict() },
  "state-load": { description: "Restore a previously saved named storage state.", inputSchema: z.object({ ...common, filename: z.string().min(1) }).strict() },
  "cookie-list": { description: "List cookies, optionally filtered by domain or path.", inputSchema: z.object({ ...common, domain: z.string().optional(), path: z.string().optional() }).strict() },
  "cookie-get": { description: "Get a cookie by name.", inputSchema: z.object({ ...common, name: z.string().min(1) }).strict() },
  "cookie-set": { description: "Set a cookie.", inputSchema: z.object({ ...common, name: z.string().min(1), value: z.string(), domain: z.string().optional(), path: z.string().optional(), expires: z.number().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(), sameSite: z.enum(["Strict", "Lax", "None"]).optional() }).strict() },
  "cookie-delete": { description: "Delete a cookie by name.", inputSchema: z.object({ ...common, name: z.string().min(1) }).strict() },
  "cookie-clear": { description: "Clear cookies for session origins.", inputSchema: empty() },
  "localstorage-list": { description: "List localStorage entries for the current page.", inputSchema: empty() },
  "localstorage-get": { description: "Get a localStorage value.", inputSchema: z.object({ ...common, key: z.string() }).strict() },
  "localstorage-set": { description: "Set a localStorage value.", inputSchema: z.object({ ...common, key: z.string(), value: z.string() }).strict() },
  "localstorage-delete": { description: "Delete a localStorage key.", inputSchema: z.object({ ...common, key: z.string() }).strict() },
  "localstorage-clear": { description: "Clear localStorage for the current page.", inputSchema: empty() },
  "sessionstorage-list": { description: "List sessionStorage entries for the current page.", inputSchema: empty() },
  "sessionstorage-get": { description: "Get a sessionStorage value.", inputSchema: z.object({ ...common, key: z.string() }).strict() },
  "sessionstorage-set": { description: "Set a sessionStorage value.", inputSchema: z.object({ ...common, key: z.string(), value: z.string() }).strict() },
  "sessionstorage-delete": { description: "Delete a sessionStorage key.", inputSchema: z.object({ ...common, key: z.string() }).strict() },
  "sessionstorage-clear": { description: "Clear sessionStorage for the current page.", inputSchema: empty() },
  requests: { description: "List captured requests since navigation.", inputSchema: z.object({ ...common, static: z.boolean().optional(), filter: z.string().optional(), clear: z.boolean().optional() }).strict() },
  request: { description: "Read full request and response details by one-based request index.", inputSchema: z.object({ ...common, index: requestIndex, filename }).strict() },
  "request-headers": { description: "Read request headers by one-based request index.", inputSchema: z.object({ ...common, index: requestIndex, filename }).strict() },
  "request-body": { description: "Read request body by one-based request index.", inputSchema: z.object({ ...common, index: requestIndex, filename }).strict() },
  "response-headers": { description: "Read response headers by one-based request index.", inputSchema: z.object({ ...common, index: requestIndex, filename }).strict() },
  "response-body": { description: "Read response body by one-based request index.", inputSchema: z.object({ ...common, index: requestIndex, filename }).strict() },
  route: { description: "Fulfill or rewrite requests matching a URL glob.", inputSchema: z.object({ ...common, pattern: z.string().min(1), status: z.number().int().min(100).max(599).optional(), body: z.string().optional(), contentType: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), removeHeaders: z.array(z.string()).optional() }).strict() },
  "route-list": { description: "List active network routes.", inputSchema: empty() },
  unroute: { description: "Remove one matching route or every route.", inputSchema: z.object({ ...common, pattern: z.string().optional() }).strict() },
  "network-state-set": { description: "Set the current session online or offline.", inputSchema: z.object({ ...common, state: z.enum(["online", "offline"]) }).strict() },
  console: { description: "List captured console messages at or above a level.", inputSchema: z.object({ ...common, minLevel: z.enum(["debug", "info", "warning", "error"]).optional(), clear: z.boolean().optional() }).strict() },
  "run-code": { description: "Run one async function expression receiving the current Playwright-style page facade.", inputSchema: z.object({ ...common, code: z.string().min(1) }).strict() },
  "recording-start": { description: "Start recording user page actions.", inputSchema: empty() },
  "recording-stop": { description: "Stop recording and return generated Playwright-style code.", inputSchema: empty() },
  "tracing-start": { description: "Start a Chrome DevTools trace.", inputSchema: empty() },
  "tracing-stop": { description: "Stop and download the active Chrome DevTools trace.", inputSchema: z.object({ ...common, filename }).strict() },
  "video-start": { description: "Start a WebM screencast of the current tab.", inputSchema: z.object({ ...common, filename, width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).strict() },
  "video-stop": { description: "Stop and download the active WebM screencast.", inputSchema: empty() },
  "video-chapter": { description: "Add a chapter card to the active screencast.", inputSchema: z.object({ ...common, title: z.string().min(1), description: z.string().optional(), durationMs: z.number().int().positive().max(30_000).optional() }).strict() },
  "video-show-actions": { description: "Annotate subsequent commands in the active screencast.", inputSchema: z.object({ ...common, durationMs: z.number().int().positive().optional(), position: z.enum(["top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right"]).optional(), cursor: z.enum(["pointer", "none"]).optional() }).strict() },
  "video-hide-actions": { description: "Stop annotating screencast actions.", inputSchema: empty() },
  show: { description: "Focus the session window and return its live tab dashboard.", inputSchema: empty() },
  "pause-at": { description: "Unavailable without a Playwright Test Runner process.", inputSchema: z.object({ ...common, location: z.string().min(1) }).strict() },
  resume: { description: "Unavailable without a Playwright Test Runner process.", inputSchema: empty() },
  "step-over": { description: "Unavailable without a Playwright Test Runner process.", inputSchema: empty() },
  "generate-locator": { description: "Generate a Playwright-style locator for a target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  highlight: { description: "Show or hide a non-interactive highlight around a target.", inputSchema: z.object({ ...common, target: target(false), style: z.string().optional(), hide: z.boolean().optional() }).strict() },
  install: { description: "Unavailable inside a Manifest V3 extension.", inputSchema: empty() },
  "install-browser": { description: "Unavailable inside a Manifest V3 extension.", inputSchema: z.object({ ...common, browser: z.string().optional() }).strict() },
  list: { description: "List Surf Wax sessions and Chrome windows available to attach.", inputSchema: empty() },
  "close-all": { description: "Close every Surf Wax-managed browser session.", inputSchema: empty() },
  "kill-all": { description: "Force cleanup and close every Surf Wax-managed browser session.", inputSchema: empty() },
};

export function parseCommandInput(name: CommandName, input: unknown): Record<string, unknown> {
  return definitions[name].inputSchema.parse(input) as Record<string, unknown>;
}

export function createCommandTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}) {
  return Object.fromEntries(COMMAND_NAMES.map((name) => {
    const definition = definitions[name];
    return [name, dynamicTool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      needsApproval: false,
      execute: async (input, { abortSignal, toolCallId }) => executor.executeCommand(name, parseCommandInput(name, input), abortSignal, {
        conversationId: options.conversationId,
        toolCallId,
        visualEnabled: await options.visualEnabled?.() ?? false,
      }),
    })];
  })) as Record<CommandName, ReturnType<typeof dynamicTool>>;
}

function scrubScreenshots(value: unknown, found: Array<{ mediaType: string; data: string }>): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubScreenshots(item, found));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "screenshot" && item && typeof item === "object" && typeof (item as any).data === "string") {
      found.push({ mediaType: (item as any).mediaType ?? "image/png", data: (item as any).data });
      return [key, { ...(item as any), data: "[stored in canonical event log]" }];
    }
    return [key, scrubScreenshots(item, found)];
  }));
}

export function prepareToolMessages(messages: any[], stepNumber: number): any[] {
  const inject = stepNumber > 0 && messages.at(-1)?.role === "tool";
  const current: Array<{ mediaType: string; data: string }> = [];
  const prepared = messages.map((message, index) => message.role !== "tool" ? message : { ...message, content: message.content.map((part: any) => {
    if (part.type !== "tool-result" || part.output?.type !== "json") return part;
    const found: Array<{ mediaType: string; data: string }> = [];
    const value = scrubScreenshots(part.output.value, found);
    if (inject && index === messages.length - 1) current.push(...found);
    return { ...part, output: { ...part.output, value } };
  }) });
  const screenshot = current.at(-1);
  return screenshot ? [...prepared, { role: "user", content: [{ type: "file", mediaType: screenshot.mediaType, data: { type: "data", data: screenshot.data } }] }] : prepared;
}
