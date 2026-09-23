import { dynamicTool, type ToolCallRepairFunction } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { BrowserInput } from "../types";
import type { ChromeExecutor } from "./executor";

export const COMMAND_NAMES = [
  "goto", "type", "click", "dblclick", "fill", "drag", "drop", "hover", "select", "upload", "check", "uncheck", "snapshot", "find", "eval", "dialog-accept", "dialog-dismiss", "resize", "delete-data",
  "go-back", "go-forward", "reload", "press", "keydown", "keyup", "mousemove", "mousedown", "mouseup", "mousewheel", "screenshot", "pdf",
  "tab-list", "tab-new", "tab-close", "tab-select", "state-save", "state-load", "cookie-list", "cookie-get", "cookie-set", "cookie-delete", "cookie-clear",
  "localstorage-list", "localstorage-get", "localstorage-set", "localstorage-delete", "localstorage-clear", "sessionstorage-list", "sessionstorage-get", "sessionstorage-set", "sessionstorage-delete", "sessionstorage-clear",
  "requests", "request", "request-headers", "request-body", "response-headers", "response-body", "route", "route-list", "unroute", "network-state-set", "console", "run-code",
  "recording-start", "recording-stop", "tracing-start", "tracing-stop", "video-start", "video-stop", "video-chapter", "video-show-actions", "video-hide-actions", "artifact-save", "generate-locator", "highlight",
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

const timeoutMs = z.number().int().positive().max(300_000).optional();
const common = { timeoutMs };
const save = z.boolean().optional();
const button = z.enum(["left", "right", "middle"]).optional();
const modifiers = z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional();
const targetObject = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional() }).strict(),
  z.object({ point: z.object({ observationId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }).strict() }).strict(),
]);
export const commandTargetSchema = z.union([z.string().min(1), targetObject]);
const file = z.object({ name: z.string().min(1), mimeType: z.string().min(1).optional(), text: z.string().optional(), base64: z.string().optional(), url: z.string().url().optional(), artifactId: z.number().int().positive().optional() }).strict()
  .refine((value) => [value.text, value.base64, value.url, value.artifactId].filter((item) => item !== undefined).length === 1, "Exactly one of text, base64, url, or artifactId is required");
const files = z.array(file).min(1);
const browserStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }).strict(),
  ...(["click", "doubleClick", "hover"] as const).map((kind) => z.object({ type: z.literal(kind), target: targetObject }).strict()),
  z.object({ type: z.literal("fill"), target: targetObject, value: z.string() }).strict(),
  z.object({ type: z.literal("clear"), target: targetObject }).strict(),
  z.object({ type: z.literal("press"), target: targetObject.optional(), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("insertText"), target: targetObject.optional(), text: z.string() }).strict(),
  z.object({ type: z.literal("select"), target: targetObject, values: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("check"), target: targetObject, checked: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("drag"), from: targetObject, to: targetObject }).strict(),
  z.object({ type: z.literal("upload"), target: targetObject, files }).strict(),
  z.object({
    type: z.literal("expect"), target: targetObject.optional(),
    state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked"]).optional(),
    text: z.string().optional(), value: z.string().optional(), url: z.string().optional(),
  }).strict().refine((value) => Boolean(value.url || value.target && (value.state || value.text !== undefined || value.value !== undefined)), "expect requires url or a target condition"),
]);
export const actInputSchema = z.object({
  observationId: z.string().min(1).optional(), steps: z.array(browserStepSchema).min(1).max(100), timeoutMs,
}).strict();
export const resultInputSchema = z.object({
  id: z.number().int().positive(), path: z.union([z.string(), z.array(z.union([z.string(), z.number().int()]))]).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().nonnegative().optional(),
}).strict();
const empty = () => z.object(common).strict();
const target = (required = true) => required ? commandTargetSchema : commandTargetSchema.optional();
const index = z.number().int().nonnegative();
const requestIndex = z.number().int().positive();
const filename = z.string().min(1).optional();

type Definition = { description: string; inputSchema: z.ZodTypeAny };
const definitions: Record<CommandName, Definition> = {
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
  snapshot: { description: "Capture an accessibility snapshot with stable element refs. filename stores an internal artifact; set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, target: target(false), depth: z.number().int().nonnegative().optional(), boxes: z.boolean().optional(), filename, save }).strict() },
  find: { description: "Find matching text in a fresh accessibility snapshot.", inputSchema: z.object({ ...common, text: z.string().optional() }).strict() },
  eval: { description: "Evaluate a JavaScript function in the page or on a target element. filename stores an internal artifact; set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, func: z.string().min(1), target: target(false), filename, save }).strict() },
  "dialog-accept": { description: "Accept the active dialog, optionally with prompt text.", inputSchema: z.object({ ...common, prompt: z.string().optional() }).strict() },
  "dialog-dismiss": { description: "Dismiss the active dialog.", inputSchema: empty() },
  resize: { description: "Resize the current page viewport.", inputSchema: z.object({ ...common, width: z.number().int().positive(), height: z.number().int().positive() }).strict() },
  "delete-data": { description: "Delete browsing data for origins visited in the current browser target.", inputSchema: empty() },
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
  screenshot: { description: "Capture a viewport, full-page, or element screenshot as an internal artifact. Set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, target: target(false), filename, save, type: z.enum(["png", "jpeg", "webp"]).optional(), fullPage: z.boolean().optional(), hires: z.boolean().optional() }).strict() },
  pdf: { description: "Print the current page to an internal PDF artifact. Set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, filename, save }).strict() },
  "tab-list": { description: "List tabs in the current Chrome window using zero-based indices.", inputSchema: empty() },
  "tab-new": { description: "Open and select a new tab.", inputSchema: z.object({ ...common, url: z.string().url().optional() }).strict() },
  "tab-close": { description: "Close a tab by zero-based index, or the current tab.", inputSchema: z.object({ ...common, index: index.optional() }).strict() },
  "tab-select": { description: "Select a tab by zero-based index.", inputSchema: z.object({ ...common, index }).strict() },
  "state-save": { description: "Save cookies and visited-origin localStorage internally by filename. Set save only when the user explicitly requested a local JSON file.", inputSchema: z.object({ ...common, filename, save }).strict() },
  "state-load": { description: "Restore a previously saved named storage state.", inputSchema: z.object({ ...common, filename: z.string().min(1) }).strict() },
  "cookie-list": { description: "List cookies, optionally filtered by domain or path.", inputSchema: z.object({ ...common, domain: z.string().optional(), path: z.string().optional() }).strict() },
  "cookie-get": { description: "Get a cookie by name.", inputSchema: z.object({ ...common, name: z.string().min(1) }).strict() },
  "cookie-set": { description: "Set a cookie.", inputSchema: z.object({ ...common, name: z.string().min(1), value: z.string(), domain: z.string().optional(), path: z.string().optional(), expires: z.number().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(), sameSite: z.enum(["Strict", "Lax", "None"]).optional() }).strict() },
  "cookie-delete": { description: "Delete a cookie by name.", inputSchema: z.object({ ...common, name: z.string().min(1) }).strict() },
  "cookie-clear": { description: "Clear cookies for visited origins.", inputSchema: empty() },
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
  request: { description: "Read full request and response details by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "request-headers": { description: "Read request headers by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "request-body": { description: "Read request body by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "response-headers": { description: "Read response headers by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  "response-body": { description: "Read response body by one-based request index. filename stores an internal artifact; save requires an explicit user request.", inputSchema: z.object({ ...common, index: requestIndex, filename, save }).strict() },
  route: { description: "Fulfill or rewrite requests matching a URL glob.", inputSchema: z.object({ ...common, pattern: z.string().min(1), status: z.number().int().min(100).max(599).optional(), body: z.string().optional(), contentType: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), removeHeaders: z.array(z.string()).optional() }).strict() },
  "route-list": { description: "List active network routes.", inputSchema: empty() },
  unroute: { description: "Remove one matching route or every route.", inputSchema: z.object({ ...common, pattern: z.string().optional() }).strict() },
  "network-state-set": { description: "Set the current tab online or offline.", inputSchema: z.object({ ...common, state: z.enum(["online", "offline"]) }).strict() },
  console: { description: "List captured console messages at or above a level.", inputSchema: z.object({ ...common, minLevel: z.enum(["debug", "info", "warning", "error"]).optional(), clear: z.boolean().optional() }).strict() },
  "run-code": { description: "Run one async function expression receiving the current Playwright-style page facade. Set save only when the user explicitly requested chrome.downloads.download().", inputSchema: z.object({ ...common, code: z.string().min(1), save }).strict() },
  "recording-start": { description: "Start recording user page actions.", inputSchema: empty() },
  "recording-stop": { description: "Stop recording and return generated Playwright-style code.", inputSchema: empty() },
  "tracing-start": { description: "Start a Chrome DevTools trace.", inputSchema: empty() },
  "tracing-stop": { description: "Stop and store the active Chrome DevTools trace internally. Set save only when the user explicitly requested local files.", inputSchema: z.object({ ...common, filename, save }).strict() },
  "video-start": { description: "Start a WebM screencast of the current tab.", inputSchema: z.object({ ...common, filename, width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).strict() },
  "video-stop": { description: "Stop and store the active WebM screencast internally. Set save only when the user explicitly requested a local file.", inputSchema: z.object({ ...common, save }).strict() },
  "video-chapter": { description: "Add a chapter card to the active screencast.", inputSchema: z.object({ ...common, title: z.string().min(1), description: z.string().optional(), durationMs: z.number().int().positive().max(30_000).optional() }).strict() },
  "video-show-actions": { description: "Annotate subsequent commands in the active screencast.", inputSchema: z.object({ ...common, durationMs: z.number().int().positive().optional(), position: z.enum(["top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right"]).optional(), cursor: z.enum(["pointer", "none"]).optional() }).strict() },
  "video-hide-actions": { description: "Stop annotating screencast actions.", inputSchema: empty() },
  "artifact-save": { description: "Save an existing internal artifact to Downloads only when the user explicitly requested it.", inputSchema: z.object({ ...common, id: z.number().int().positive(), filename }).strict() },
  "generate-locator": { description: "Generate a Playwright-style locator for a target.", inputSchema: z.object({ ...common, target: target() }).strict() },
  highlight: { description: "Show or hide a non-interactive highlight around a target.", inputSchema: z.object({ ...common, target: target(false), style: z.string().optional(), hide: z.boolean().optional() }).strict() },
};

const ACT_DESCRIPTION = "Execute 1-100 deterministic browser steps as one batch. Prefer a dedicated command for one action; use act for two or more related actions and include expect steps for outcomes.";
const RESULT_DESCRIPTION = "Read an exact slice or path from a large tool result stored in the canonical event log. Use the access object returned with $ref.";

export const TOOL_SUMMARY = [
  ...COMMAND_NAMES.map((name) => `- ${name}: ${definitions[name].description}`),
  `- act: ${ACT_DESCRIPTION}`,
  `- result: ${RESULT_DESCRIPTION}`,
].join("\n");
const TOOL_CONTEXT = `Available tools:\n${TOOL_SUMMARY}`;

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

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string }): Promise<unknown> {
  if ((value && typeof value === "object" && "$ref" in value) || !options.logger || hasScreenshot(value)) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (serialized === undefined) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, content: { bytes }, output: value });
  if (!event) throw new Error("Could not save large tool result");
  const path = readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const access = { id: event.id, ...(path ? { path } : {}), ...(typeof selected === "string" ? { offset: 0, limit: 4000 } : Array.isArray(selected) ? { offset: 0, limit: 50 } : {}) };
  return { $ref: event.id, bytes, preview: previewOf(value, path), access, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value };
}

function toolFailure(error: unknown): { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof DOMException && error.name === "AbortError" ? "aborted" : /(?:Command|Automation)Error\[([^\]]+)\]/.exec(message)?.[1] ?? "tool-error";
  return { ok: false, error: { code, message, retryable: code === "timeout" } };
}

export function createCommandTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}) {
  const context = async (toolCallId: string) => ({
    conversationId: options.conversationId, toolCallId, visualEnabled: await options.visualEnabled?.() ?? false,
  });
  const run = async (operation: () => Promise<unknown>, toolCallId: string, compact = true) => {
    try {
      const raw = await operation();
      const result = raw && typeof raw === "object" && (raw as any).ok === false && (raw as any).error
        ? { ...(raw as Record<string, unknown>), error: { ...(raw as any).error, retryable: (raw as any).error.retryable ?? (raw as any).error.code === "timeout" } }
        : raw;
      return compact ? compactToolResult(result, { ...options, toolCallId }) : result;
    } catch (error) {
      return toolFailure(error);
    }
  };
  const commands = Object.fromEntries(COMMAND_NAMES.map((name) => {
    const definition = definitions[name];
    return [name, dynamicTool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      needsApproval: false,
      execute: async (input, { abortSignal, toolCallId }) => run(
        async () => executor.executeCommand(name, parseCommandInput(name, input), abortSignal, await context(toolCallId)), toolCallId,
      ),
    })];
  }));
  return {
    ...commands,
    act: dynamicTool({
      description: ACT_DESCRIPTION,
      inputSchema: actInputSchema, needsApproval: false,
      execute: async (input, { abortSignal, toolCallId }) => run(async () => executor.executeBrowser({ mode: "act", ...actInputSchema.parse(input) } as BrowserInput, abortSignal, await context(toolCallId)), toolCallId),
    }),
    result: dynamicTool({
      description: RESULT_DESCRIPTION,
      inputSchema: resultInputSchema, needsApproval: false,
      execute: async (input, { abortSignal, toolCallId }) => run(async () => executor.executeBrowser({ mode: "result", ...resultInputSchema.parse(input) } as BrowserInput, abortSignal, await context(toolCallId)), toolCallId, false),
    }),
  };
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

export async function prepareToolMessages(messages: any[], stepNumber: number, browserContext?: string, readArtifact?: (id: number) => Promise<unknown>): Promise<any[]> {
  const inject = stepNumber > 0 && messages.at(-1)?.role === "tool";
  const current: ScreenshotSource[] = [];
  const firstUser = messages.findIndex((message) => message.role === "user");
  const withTools = firstUser < 0 ? messages : messages.map((message, index) => {
    if (index !== firstUser) return message;
    if (typeof message.content === "string") return message.content.includes(TOOL_CONTEXT)
      ? message : { ...message, content: `${message.content}\n\n${TOOL_CONTEXT}` };
    if (!Array.isArray(message.content) || message.content.some((part: any) => part.type === "text" && part.text === TOOL_CONTEXT)) return message;
    return { ...message, content: [...message.content, { type: "text", text: TOOL_CONTEXT }] };
  });
  const prepared = withTools.map((message, index) => message.role !== "tool" || stepNumber > 0 && index !== withTools.length - 1 ? message : { ...message, content: message.content.map((part: any) => {
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
