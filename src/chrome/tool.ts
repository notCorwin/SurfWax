import { dynamicTool, type ToolCallRepairFunction } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { ChromeExecutor } from "./executor";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";

const timeoutMs = z.number().int().positive().optional();
const elementTargetObject = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional() }).strict(),
]);
export const PROGRAM_CATALOG_VERSION = "atomic-tools-v1";
export const inspectInputSchema = z.object({ timeoutMs, tabId: z.number().int().nonnegative().optional(), region: z.union([z.string().min(1), elementTargetObject]).optional(),
  fields: z.array(z.enum(["text", "state", "ref", "actions"])).min(1).optional(), budget: z.number().int().min(100).max(1000000).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), depth: z.number().int().nonnegative().optional(),
  since: z.string().min(1).optional() }).strict();
export const runInputSchema = z.object({ code: z.string().min(1), background: z.boolean().optional(), timeoutMs }).strict();
const listJobsInputSchema = z.object({}).strict();
const getJobInputSchema = z.object({ jobId: z.string().min(1), after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }).strict();
const cancelJobInputSchema = z.object({ jobId: z.string().min(1) }).strict();

type ToolDefinition = { name: string; inputSchema: z.ZodType<any>; summary: string; description: string; program?: (input: any) => { code: string; timeoutMs?: number } };
export const PROGRAM_TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze([
  { name: "inspect_page", inputSchema: inspectInputSchema, summary: "Read the semantic page with stable element refs", description: "Inspect semantic text and stable refs. region and fields narrow the result; budget and pagination limit output; since reads changes. Use take_screenshot for visual input." },
  ...ATOMIC_TOOL_REGISTRY,
  { name: "read_api_reference", inputSchema: listJobsInputSchema, summary: "Read the advanced program API reference", description: "Read the available execute_program capabilities and usage details." },
  { name: "execute_program", inputSchema: runInputSchema, summary: "Execute a composable async JavaScript program", description: "Execute an async JavaScript body with page, browser, net, protocol, artifacts, emit, check, sleep and signal. Use for loops, conditions, event subscriptions and complex multi-step tasks. Call read_api_reference for the complete API. background=true starts a job. Set timeoutMs to accommodate the entire program. Effects are not automatically retried; inspect uncertain outcomes." },
  { name: "list_jobs", inputSchema: listJobsInputSchema, summary: "List this conversation's program jobs", description: "List jobs belonging to the current conversation." },
  { name: "get_job", inputSchema: getJobInputSchema, summary: "Read a job's status and receipts", description: "Read status and paginated receipts for a job. waitMs waits for completion or a timeout; after is a canonical event cursor. A running job is not complete." },
  { name: "cancel_job", inputSchema: cancelJobInputSchema, summary: "Request cancellation of a job", description: "Cancel a job in the current conversation. Cancellation does not roll back dispatched effects." },
]);
export const PROGRAM_API = `execute_program API (async JavaScript body; no function wrapper required):
page: tabId; inspect(options?, regionLocator?); snapshot(); observe('semantic'|'visual'); ref/locator/frameLocator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId; goto/reload/goBack/goForward; url/title; evaluate(functionOrString,arg?); waitForURL/waitForLoadState/waitForEvent('dialog'|'popup'|'download'|'filechooser'); point(observationId,x,y,'click'|'dblclick'|'hover',options?); upload(files); drop(target,{files?,data?}); screenshot(options?); pdf({filename?,save?}); keyboard.press/insertText/down/up; mouse.move/down/up/wheel.
locators: chain/filter/first/last/nth, count/waitFor/click/dblclick/hover/fill/clear/press/pressSequentially/check/uncheck/selectOption/dragTo/setInputFiles/focus/blur/scrollIntoViewIfNeeded/textContent/innerText/inputValue/getAttribute/isVisible/isEnabled/isChecked/evaluate. Files: {name,mimeType?,text|base64|url}; artifacts.read supplies existing file data. Event handles: chooser.isMultiple()/setFiles(files), dialog.type()/message()/defaultValue()/accept(prompt?)/dismiss(), popup is a page. Start event waits before the action, then await them.
browser: page(tabId); tabs.list()/open(url?)/select(tabId)/close(tabId); scripts.list()/read(id)/create(definition)/edit(id,changes)/setEnabled(id,enabled)/delete(id). Scripts use Chrome RegisteredUserScript fields including matches, js:[{code|file}], world:MAIN|USER_SCRIPT, runAt, allFrames, include/excludeGlobs/Matches, worldId. Persisted enablement is restored at startup/upgrade; Allow User Scripts must already be enabled.
browser.runIn({kind:'page',tabId,world:'MAIN'|'ISOLATED'|'USER_SCRIPT',frameId?,documentId?},codeBody): explicit execution domain. MAIN/ISOLATED root only; USER_SCRIPT supports Chrome frameId or documentId. Use frameLocator.evaluate for arbitrary supported frames. No automatic context substitution.
net.fetch({context:'page'|'extension',url,tabId?,init?}) returns {url,status,ok,headers,body}; no page-to-extension fallback. Page fetch obeys page origin/cookies/CORS; extension fetch uses extension host permissions. net.requests(options?,tabId?)/request(index,tabId?); net.responseBody(index,tabId?); net.console(options?,tabId?) read captured diagnostics.
protocol.sessions(tabId?) lists root/child CDP handles; protocol.send({tabId,sessionId?},method,params?) sends any Chrome CDP method available to the extension. Arbitrary JS/CDP/fetch are effectful; there is no readonly override. inspect.documentId is the local navigation generation; USER_SCRIPT documentId uses Chrome's native scripting document ID. File URL sources are fetched in extension context.
artifacts.read(id,{path?,offset?,limit?}); text(filename,text,mimeType?,save=false); save(id,filename?). Files and images stay internal unless the user requested download/export. emit(value) persists incremental output; check(condition,message?) records a verified assertion; sleep(ms) and signal support cancellation. Completed operations only confirm dispatch/return; verify application outcomes. Queued operations are not dispatched, uncertain effects must be inspected before continuing. Program computation uses a disposable opaque-origin sandbox Worker; browser capabilities are mediated by the Side Panel. Closing the panel cancels jobs and revokes capabilities; arbitrary program finally blocks are not guaranteed to run. Only records survive restart, never arbitrary JS stacks.`;
export const PROGRAM_TOOL_CONTEXT = `Available tools:\n${PROGRAM_TOOL_REGISTRY.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n")}`;

export function createProgramTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; callId?: () => string | undefined; visualEnabled?: () => Promise<boolean> } = {}): Record<string, ReturnType<typeof dynamicTool>> {
  return Object.fromEntries(PROGRAM_TOOL_REGISTRY.map((definition) => [definition.name, dynamicTool({
    description: definition.description, inputSchema: definition.inputSchema, needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => {
      abortSignal?.throwIfAborted();
      const identity = options.conversationId ? options.logger?.toolIdentity(options.conversationId, toolCallId) : undefined;
      const callId = options.callId?.();
      if (options.logger) {
        const started = await options.logger.append({ type: "tool.started", conversationId: options.conversationId,
          content: { callId, toolName: definition.name }, input, toolCallId, ...identity });
        if (!started) throw new DOMException("日志维护已阻止工具启动。", "AbortError");
      }
      const startedAt = performance.now();
      let output: unknown;
      let executing = false;
      try {
        abortSignal?.throwIfAborted();
        const context = { conversationId: options.conversationId, toolCallId, logIdentity: identity, visualEnabled: await options.visualEnabled?.() ?? false };
        abortSignal?.throwIfAborted();
        const value = definition.inputSchema.parse(input);
        executing = true;
        const result = definition.name === "read_api_reference" ? { reference: PROGRAM_API }
          : definition.name === "inspect_page" ? await executor.inspect(value as any, abortSignal, context)
          : definition.name === "execute_program" ? await executor.runProgram(value as any, abortSignal, context)
          : definition.name === "list_tabs" ? await executor.listTabs(abortSignal, value.timeoutMs)
          : definition.name === "switch_tab" ? await executor.switchTab(value.tabId, abortSignal, value.timeoutMs)
          : definition.name === "list_jobs" ? await executor.queryJobs({ action: "list" }, abortSignal, context)
          : definition.name === "get_job" ? await executor.queryJobs({ action: value.waitMs ? "wait" : "status", id: value.jobId, after: value.after, limit: value.limit, waitMs: value.waitMs }, abortSignal, context)
          : definition.name === "cancel_job" ? await executor.queryJobs({ action: "cancel", id: value.jobId }, abortSignal, context)
          : await executor.runProgram(definition.program!(value), abortSignal, context);
        const failure = (result as any)?.ok === false ? (result as any).error ?? (result as any).failed?.error ?? (result as any).result?.error : undefined;
        const artifact = (result as any)?.result?.artifact;
        const normalized = failure ? { ...result as object, ...(artifact ? { artifact } : {}), error: { ...failure, retryable: false } } : result;
        output = await compactToolResult(normalized, { ...options, toolCallId, ...identity });
      } catch (error) {
        const cause = abortSignal?.aborted && !(error instanceof Error)
          ? new DOMException(abortSignal.reason instanceof Error ? abortSignal.reason.message : String(abortSignal.reason ?? error ?? "Operation aborted"), "AbortError")
          : error;
        const failure = toolFailure(cause); failure.error.retryable = false;
        // Cancellation can race a dispatched operation before the job records its terminal receipt.
        // Conservatively report uncertainty rather than inviting a duplicate side effect.
        if (executing && abortSignal?.aborted && (definition.name === "execute_program" || definition.program) && !failure.error.effectUnknown) failure.error.effectUnknown = true;
        if (!failure.artifact && options.logger && identity?.runId) {
          const artifact = await options.logger.toolArtifact(options.conversationId!, identity).catch(() => undefined);
          if (artifact) failure.artifact = artifact;
        }
        output = failure;
      }
      if (options.logger) {
        const failed = Boolean(output && typeof output === "object" && "ok" in output && output.ok === false);
        const interrupted = failed && abortSignal?.aborted;
        const error = failed ? (output as { error?: unknown }).error : undefined;
        const effectUnknown = Boolean(error && typeof error === "object" && "effectUnknown" in error && error.effectUnknown);
        const toolExecutionMs = Math.max(0, performance.now() - startedAt);
        const terminal = await options.logger.append({ type: failed ? "tool.failed" : "tool.finished", conversationId: options.conversationId,
          content: { callId, toolName: definition.name, toolExecutionMs, ...(interrupted ? { status: "interrupted", effectUnknown } : {}) },
          input, output, toolCallId, ...identity, ...(failed ? { error } : {}),
          ...(interrupted ? { abort: { reason: Object.assign(new Error(String(abortSignal?.reason ?? "Operation aborted")), { name: "AbortError" }) } } : {}),
          latencyMs: toolExecutionMs });
        if (!terminal) throw new DOMException("日志维护已阻止工具结果保存。", "AbortError");
      }
      return output;
    },
  })]));
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
  for (const path of [["result", "snapshot"], ["result"], ["snapshot"], ["observation", "snapshot"], ["text"], ["html"]] as const) {
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

export const repairProgramToolCall: ToolCallRepairFunction<Record<string, ReturnType<typeof dynamicTool>>> = async ({ toolCall, tools }) => {
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
  } catch { return null; }
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

export async function prepareToolMessages(messages: any[], stepNumber: number, browserContext?: string, readArtifact?: (id: number) => Promise<unknown>, injectImages = true): Promise<any[]> {
  const inject = stepNumber > 0 && messages.at(-1)?.role === "tool";
  const current: ScreenshotSource[] = [];
  const prepared = messages.map((message, index) => message.role !== "tool" ? message : { ...message, content: message.content.map((part: any) => {
    if (part.type !== "tool-result" || part.output?.type !== "json") return part;
    const found: ScreenshotSource[] = [];
    const value = scrubScreenshots(part.output.value, found);
    if (injectImages && inject && index === messages.length - 1) current.push(...found);
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
