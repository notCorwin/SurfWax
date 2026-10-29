import { normalizationExceedsBudget, normalizeResultEnvelope } from "../tool-result-values";
import { isArrayBuffer, viewLayout } from "../log-graph";
import { dynamicTool, type ToolCallRepairFunction } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { ChromeExecutor } from "./executor";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";
import type { ToolScheduler } from "./tool-scheduler";

const timeoutMs = z.number().int().positive().optional();
const elementTargetObject = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.union([z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(), z.object({ ref: z.string().min(1) }).strict()]).optional() }).strict(),
]);
export const PROGRAM_CATALOG_VERSION = "atomic-tools-v18";
export const inspectInputSchema = z.object({ timeoutMs, tabId: z.number().int().nonnegative().optional(), region: z.union([z.string().min(1), elementTargetObject]).optional(),
  fields: z.array(z.enum(["text", "state", "ref", "actions"])).min(1).optional(), budget: z.number().int().min(100).max(1000000).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), depth: z.number().int().nonnegative().optional(),
  since: z.string().min(1).optional(), cursor: z.string().min(1).max(256).optional() }).strict()
  .refine((input) => input.cursor === undefined || [input.region, input.fields, input.depth, input.since, input.offset].every((value) => value === undefined),
    "cursor cannot be combined with region, fields, depth, since, or offset");
const findElementsInputSchema = z.object({ target: elementTargetObject, tabId: z.number().int().nonnegative().optional(), timeoutMs,
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).optional() }).strict();
const listFramesInputSchema = z.object({ tabId: z.number().int().nonnegative().optional(), timeoutMs,
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).optional() }).strict();
export const runInputSchema = z.object({ code: z.string().min(1), background: z.boolean().optional(), timeoutMs }).strict();
const emptyInputSchema = z.object({}).strict();
const listJobsInputSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const getJobInputSchema = z.object({ jobId: z.string().min(1), after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }).strict();
const cancelJobInputSchema = z.object({ jobId: z.string().min(1) }).strict();
const listDownloadsInputSchema = z.object({ downloadId: z.number().int().nonnegative().optional(), state: z.enum(["in_progress", "interrupted", "complete"]).optional(), limit: z.number().int().min(0).max(2_147_483_647).optional() }).strict();
const subscribeEventInputSchema = z.object({ tabId: z.number().int().nonnegative().optional(), kind: z.enum(["dialog", "popup", "download", "filechooser", "request", "response", "console"]), timeoutMs }).strict();
const waitEventInputSchema = z.object({ subscriptionId: z.string().min(1), after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }).strict();
const unsubscribeEventInputSchema = z.object({ subscriptionId: z.string().min(1) }).strict();
const handleDialogInputSchema = z.object({ dialogId: z.string().min(1), accept: z.boolean(), prompt: z.string().optional() }).strict()
  .refine((input) => input.accept || input.prompt === undefined, "prompt requires accept=true");

type ToolDefinition = { name: string; inputSchema: z.ZodType<any>; summary: string; description: string; program?: (input: any) => { code: string; timeoutMs?: number; background?: boolean } };
export const PROGRAM_TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze([
  { name: "inspect_page", inputSchema: inspectInputSchema, summary: "Read the semantic page and element refs", description: "Inspect semantic items with id, line and optional ref. For since, remove removed ids and upsert added, updated or moved items immediately after their after id (null means first). Reassemble split items using their UTF-16 fragment offsets before applying changes. Ref use checks visible role/name, but a DOM node may be reused for different business data with the same name; verify relevant row and page state before acting. Older refs may expire after later independent observations or searches; an affected continuation returns stale-observation. region and fields narrow results. budget limits UTF-8 JSON items bytes. Continue a frozen snapshot with nextCursor using cursor, tabId, budget and limit only. Use take_screenshot for visual input." },
  { name: "find_elements", inputSchema: findElementsInputSchema, summary: "Find candidates and return element refs", description: "Find matching elements with refs for actions. Ref use checks visible role/name but cannot prove business identity for reused nodes; verify relevant row and page state before acting. Older refs may expire after later independent observations or searches. limit defaults to 25, max 100; repeat target and tab with nextCursor to page a fixed node list. Candidates may report detached, changed or identity-unknown without a ref. Details may change between pages; cursors expire on run or document changes or eviction." },
  { name: "list_frames", inputSchema: listFramesInputSchema, summary: "List frames and their document-bound refs", description: "List the selected tab's frame tree with refs usable as target.frame.ref. limit defaults to 25, max 100; pass nextCursor to continue a fixed snapshot. References and cursors expire on document or frame changes." },
  ...ATOMIC_TOOL_REGISTRY,
  { name: "list_downloads", inputSchema: listDownloadsInputSchema, summary: "Read Chrome's current download records", description: "List download metadata across the Chrome profile. limit defaults to 100; 0 requests all records. hasMore reports truncation. The list is live and Chrome's exists field may be stale; metadata does not provide file bytes." },
  { name: "subscribe_event", inputSchema: subscribeEventInputSchema, summary: "Subscribe to browser events before triggering them", description: "Subscribe to a tab's dialog, popup, download, filechooser, request, response or console events. Returns a run-scoped subscription and cursor. Filechooser events include a chooserId for upload_file." },
  { name: "wait_event", inputSchema: waitEventInputSchema, summary: "Read or wait for subscribed events", description: "Read events after a subscription cursor, or wait up to waitMs. Use nextCursor and hasMore. Overflow, truncation and closure are explicit; a closed tab's bounded unread events remain available until unsubscribe or run end." },
  { name: "unsubscribe_event", inputSchema: unsubscribeEventInputSchema, summary: "Stop a browser event subscription", description: "Stop a subscription and release its resources." },
  { name: "handle_dialog", inputSchema: handleDialogInputSchema, summary: "Accept or dismiss a captured browser dialog", description: "Respond to a captured dialog by ID. prompt is allowed only when accepting a prompt dialog. An uncertain response must not be blindly retried." },
  { name: "read_api_reference", inputSchema: emptyInputSchema, summary: "Read the advanced program API reference", description: "Read the available execute_program capabilities and usage details." },
  { name: "execute_program", inputSchema: runInputSchema, summary: "Execute a composable async JavaScript program", description: "Execute an async JavaScript body with page, browser, net, protocol, artifacts, emit, check, sleep and signal. Use for loops, conditions, event subscriptions and complex multi-step tasks. Call read_api_reference for the complete API. background=true starts a job. Set timeoutMs to accommodate the entire program. Effects are not automatically retried; inspect uncertain outcomes." },
  { name: "list_jobs", inputSchema: listJobsInputSchema, summary: "List this conversation's jobs in pages", description: "List jobs in creation order in a fixed snapshot. limit defaults to 25, max 100. If hasMore, pass nextCursor to continue; cursor expires on log maintenance. Job state is as of the first page; get_job reads current state." },
  { name: "get_job", inputSchema: getJobInputSchema, summary: "Read a job's status and receipts", description: "Read status and paginated receipts for a job. waitMs waits for receipts after the supplied canonical event cursor or for completion; unread receipts return immediately. A terminal event with outputAt:'result' refers to the top-level result rather than repeating it. A running job is not complete." },
  { name: "cancel_job", inputSchema: cancelJobInputSchema, summary: "Request cancellation of a job", description: "Cancel a job in the current conversation. Cancellation does not roll back dispatched effects." },
]);
export const PROGRAM_API = `execute_program API (async JavaScript body; no function wrapper required):
page: tabId; inspect(options?, regionLocator?); snapshot(); observe('semantic'|'visual'); ref/locator/frameLocator/frameRef/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId; goto/reload/goBack/goForward; url/title; evaluate(functionOrString,arg?); waitForURL/waitForLoadState/waitForEvent('dialog'|'popup'|'download'|'filechooser'); point(observationId,x,y,'click'|'dblclick'|'hover',options?); upload(files); drop(target,{files?,data?}); screenshot(options?); pdf({filename?,save?}); keyboard.press/insertText/down/up; mouse.move/down/up/wheel. inspect, snapshot and semantic observe return items with AX ids. For delta remove removed ids; upsert added/updated/moved immediately after after (null=first). Reassemble split items using UTF-16 fragment offsets before applying. Ref use checks visible role/name, but reused DOM nodes can still represent different business data. Older refs may expire after later independent observations or searches; affected continuations return stale-observation. waitForLoadState throws load-state-unknown when lifecycle cannot be verified after attaching; inspect the target element or wait for a new navigation.
locators: chain/filter/first/last/nth, count/waitFor/click/dblclick/hover/fill/clear/press/pressSequentially/check/uncheck/selectOption/dragTo/setInputFiles/focus/blur/scrollIntoViewIfNeeded/textContent/innerText/inputValue/getAttribute/isVisible/isEnabled/isChecked/readCondition/evaluate. readCondition takes text, value, visible, enabled or checked and returns present and actual for one bound node. pressSequentially inserts characters without keydown or keyup events. Ref composition requires a shared JavaScript execution context; cross-context combinations fail explicitly. Chained and filtered role/name matching uses DOM-derived semantics. dragTo supports pointer drags; native HTML5 draggable sources are unavailable while the interaction blocker is active. Files: {name,mimeType?,text|base64|url}; artifacts.read supplies existing file data. Event handles: chooser.isMultiple()/setFiles(files), dialog.type()/message()/defaultValue()/accept(prompt?)/dismiss(), popup is a page. Start event waits before the action, then await them.
browser: page(tabId); tabs.list()/open(url?)/select(tabId)/close(tabId); scripts.list()/read(id)/create(definition)/edit(id,changes)/setEnabled(id,enabled)/delete(id). Scripts use Chrome RegisteredUserScript fields including matches, js:[{code|file}], world:MAIN|USER_SCRIPT, runAt, allFrames, include/excludeGlobs/Matches, worldId. Persisted enablement is restored at startup/upgrade; Allow User Scripts must already be enabled.
browser.runIn({kind:'page',tabId,world:'MAIN'|'ISOLATED'|'USER_SCRIPT',frameId?,documentId?},codeBody): explicit execution domain. MAIN/ISOLATED root only; USER_SCRIPT supports Chrome frameId or documentId. Use frameLocator.evaluate for arbitrary supported frames. No automatic context substitution.
net.fetch({context:'page'|'extension',url,tabId?,init?}) returns {url,status,ok,headers,body}; no page-to-extension fallback. Page fetch obeys page origin/cookies/CORS; extension fetch uses extension host permissions. net.requests(options?,tabId?) returns {requests,integrity,hasMore,nextOffset?} for captured history (not all traffic); net.console(options?,tabId?) returns the same metadata with messages instead of requests. hasMore can be null when unknown and offsets refer to a live list. net.request(requestRef,tabId?) and net.responseBody(requestRef,tabId?) read captured requests.
protocol.sessions(tabId?) lists root/child CDP handles; protocol.send({tabId,sessionId?},method,params?) sends any Chrome CDP method available to the extension. Arbitrary JS/CDP/fetch are effectful; there is no readonly override. inspect.documentId is the local navigation generation; USER_SCRIPT documentId uses Chrome's native scripting document ID. File URL sources are fetched in extension context.
artifacts.read(id,{path?,offset?,limit?}) pages arrays/strings, Map/Set entries, ArrayBuffer/DataView bytes and TypedArray elements; a numeric path segment selects a Map's [key,value] pair or a Set's item. Native artifacts and page/locator evaluate preserve supported cycles, shared references and binary backing buffers. Own enumerable string properties are preserved, except TypedArray named properties; put such metadata in a containing object. Enumerable symbol properties, custom prototypes and Error subclasses, shared/resizable buffers, DOM nodes, URL and Blob are unsupported; convert them to supported data. Error values from another realm are unsupported. evaluate requires intact page built-ins. text(filename,text,mimeType?,save=false); save(id,filename?). Files and images stay internal unless the user requested download/export. emit(value) persists incremental output; check(condition,message?) records a verified assertion; sleep(ms) and signal support cancellation. Functions cannot be serialized as data; evaluate accepts a function as its first argument. Completed operations only confirm dispatch/return; verify application outcomes. Queued operations are not dispatched, uncertain effects must be inspected before continuing. Program computation uses a disposable opaque-origin sandbox Worker; browser capabilities are mediated by the Side Panel. Closing the panel cancels jobs and revokes capabilities; arbitrary program finally blocks are not guaranteed to run. Only records survive restart, never arbitrary JS stacks.`;
export const PROGRAM_TOOL_CONTEXT = `Available tools:\n${PROGRAM_TOOL_REGISTRY.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n")}\nresultType=undefined marks an undefined result. undefinedPaths, holePaths, numberPaths and bigintPaths are relative to result; numberPaths entries hold {path,value} for NaN, Infinity, -Infinity or -0, and bigintPaths hold decimal strings. These replace values with null. typePaths marks non-JSON types: date is ISO or null for invalid; array-buffer and typed-array are base64 bytes (typed-array name identifies the view); regexp is {source,flags,lastIndex}; map is key/value pairs; set is an array. Apply the other sidecars first, then typePaths from deepest path to shallowest. Large results provide paged sidecar access. If envelopeWrapped=true, reconstruct the original tool envelope from result and its sidecars; outer fields summarize status.`;

export function createProgramTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; callId?: () => string | undefined; visualEnabled?: () => Promise<boolean>; scheduler?: ToolScheduler; runSignal?: AbortSignal } = {}): Record<string, ReturnType<typeof dynamicTool>> {
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
      const finish = async (output: unknown) => {
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
      };
      const failureFor = async (error: unknown, executing: boolean) => {
        const cause = abortSignal?.aborted && !(error instanceof Error)
          ? new DOMException(abortSignal.reason instanceof Error ? abortSignal.reason.message : String(abortSignal.reason ?? error ?? "Operation aborted"), "AbortError")
          : error;
        const failure = toolFailure(cause); failure.error.retryable = false;
        const chooserUpload = definition.name === "upload_file" && input && typeof input === "object" && "chooserId" in input && typeof input.chooserId === "string";
        if (executing && !chooserUpload && definition.name !== "read_artifact" && abortSignal?.aborted && (definition.name === "execute_program" || definition.program) && !failure.error.effectUnknown) failure.error.effectUnknown = true;
        if (!failure.artifact && options.logger && identity?.runId) {
          const artifact = await options.logger.toolArtifact(options.conversationId!, identity).catch(() => undefined);
          if (artifact) failure.artifact = artifact;
        }
        return failure;
      };
      let entered = false;
      const work = async () => {
        entered = true;
        let output: unknown;
        let executing = false;
        let observedTerminalJob: string | undefined;
        try {
          abortSignal?.throwIfAborted();
          const context = { conversationId: options.conversationId, toolCallId, logIdentity: identity, runSignal: options.runSignal, visualEnabled: await options.visualEnabled?.() ?? false };
          abortSignal?.throwIfAborted();
          const value = definition.inputSchema.parse(input);
          executing = true;
          const result = definition.name === "read_api_reference" ? { reference: PROGRAM_API }
            : definition.name === "inspect_page" ? await executor.inspect(value as any, abortSignal, context)
            : definition.name === "find_elements" ? await executor.findElements(value as any, abortSignal, context)
            : definition.name === "list_frames" ? await executor.listFrames(value as any, abortSignal, context)
            : definition.name === "execute_program" ? await executor.runProgram(value as any, abortSignal, context)
            : definition.name === "list_tabs" ? await executor.listTabs(abortSignal, value.timeoutMs)
            : definition.name === "switch_tab" ? await executor.switchTab(value.tabId, abortSignal, value.timeoutMs)
            : definition.name === "list_downloads" ? await executor.listDownloads(value, abortSignal)
            : definition.name === "read_artifact" ? await executor.readArtifact(value, abortSignal, context)
            : definition.name === "subscribe_event" ? await executor.subscribeEvent(value, abortSignal, context)
            : definition.name === "wait_event" ? await executor.waitEvent(value, abortSignal, context)
            : definition.name === "unsubscribe_event" ? await executor.unsubscribeEvent(value, abortSignal, context)
            : definition.name === "handle_dialog" ? await executor.handleDialog(value, abortSignal, context)
            : definition.name === "upload_file" && value.chooserId ? await executor.uploadChooser(value, abortSignal, context)
            : definition.name === "list_jobs" ? await executor.queryJobs({ action: "list", limit: value.limit, cursor: value.cursor }, abortSignal, context)
            : definition.name === "get_job" ? await executor.queryJobs({ action: value.waitMs ? "wait" : "status", id: value.jobId, after: value.after, limit: value.limit, waitMs: value.waitMs }, abortSignal, context)
            : definition.name === "cancel_job" ? await executor.queryJobs({ action: "cancel", id: value.jobId }, abortSignal, context)
            : await executor.runProgram(definition.program!(value), abortSignal, context);
          const failure = (result as any)?.ok === false ? (result as any).error ?? (result as any).failed?.error ?? (result as any).result?.error : undefined;
          const artifact = (result as any)?.result?.artifact;
          const envelope = failure ? { ...result as object, ...(artifact ? { artifact } : {}), error: { ...failure, retryable: false } } : result;
          if (normalizationExceedsBudget(envelope)) {
            output = await storeUnnormalizedResult(envelope, { ...options, toolCallId, ...identity,
              preserveJobStatus: definition.name === "get_job" || definition.name === "cancel_job",
              preserveSearchStatus: definition.name === "find_elements" || definition.name === "list_frames",
              preserveInspectionStatus: definition.name === "inspect_page", preserveEventStatus: definition.name === "wait_event",
              preserveDiagnosticStatus: definition.name === "list_requests" || definition.name === "read_console", preserveVerification: definition.name === "verify_state" });
          } else {
            const normalized = envelope && typeof envelope === "object" && !Array.isArray(envelope)
              ? normalizeResultEnvelope(envelope as Record<string, unknown>) : envelope;
            const originalResult = normalized && typeof normalized === "object" && "envelopeWrapped" in normalized && normalized.envelopeWrapped === true
              ? envelope : envelope && typeof envelope === "object" && Object.hasOwn(envelope, "result") ? (envelope as Record<string, unknown>).result : undefined;
            const hasResult = Boolean(normalized && typeof normalized === "object" && Object.hasOwn(normalized, "result"));
            output = await compactToolResult(normalized, { ...options, toolCallId, ...identity, preserveVerification: definition.name === "verify_state", preserveJobStatus: definition.name === "get_job" || definition.name === "cancel_job", preserveSearchStatus: definition.name === "find_elements" || definition.name === "list_frames", preserveInspectionStatus: definition.name === "inspect_page", preserveDiagnosticStatus: definition.name === "list_requests" || definition.name === "read_console", preserveEventStatus: definition.name === "wait_event", preserveArtifactValue: hasResult, ...(hasResult ? { originalResult } : {}) });
          }
          if ((definition.name === "get_job" || definition.name === "cancel_job") && (result as any)?.terminal === true && typeof (result as any).id === "string") observedTerminalJob = (result as any).id;
        } catch (error) {
          output = await failureFor(error, executing);
        }
        const saved = await finish(output);
        if (observedTerminalJob && options.logger && options.conversationId) executor.acknowledgeBackgroundJob(observedTerminalJob, options.conversationId);
        return saved;
      };
      try {
        return options.scheduler ? await options.scheduler.run(toolCallId, work, abortSignal) : await work();
      } catch (error) {
        if (entered) throw error; // A terminal log failure must stop the run, not be rewritten as another result.
        return finish(await failureFor(error, false));
      }
    },
  })]));
}

const LARGE_RESULT_BYTES = 8 * 1024;

type VisualEvidence = { screenshot: Record<string, unknown>; context: Record<string, unknown>; path: Array<string | number> };

function exactText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" && value.length <= maxBytes && previewEncoder.encode(JSON.stringify(value)).byteLength <= maxBytes ? value : undefined;
}
function excerpt(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const text = previewString(value, 2000, maxBytes - 4);
  return { value: text.length < value.length ? `${text}…` : text, truncated: text.length < value.length };
}
function geometry(value: unknown, fields: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(fields.flatMap((field) => typeof record[field] === "number" && Number.isFinite(record[field]) ? [[field, record[field] as number]] : []));
}
function artifactMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of ["id", "byteLength", "downloadId"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) result[field] = record[field];
  if (typeof record.saved === "boolean") result.saved = record.saved;
  for (const field of ["filename", "mimeType"]) if (typeof record[field] === "string") {
    const fieldValue = excerpt(record[field] as string, field === "filename" ? 512 : 256);
    result[field] = fieldValue.value;
    if (fieldValue.truncated) result[`${field}Truncated`] = true;
  }
  return result;
}
function visualContext(record: Record<string, unknown>): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  const observationId = exactText(record.observationId, 512);
  if (observationId !== undefined) context.observationId = observationId;
  for (const field of ["tabId", "documentId"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) context[field] = record[field];
  const viewport = geometry(record.viewport, ["x", "y", "width", "height", "scale"]);
  if (viewport) context.viewport = viewport;
  if (record.page && typeof record.page === "object" && !Array.isArray(record.page)) {
    const page = record.page as Record<string, unknown>; const result: Record<string, unknown> = {};
    for (const field of ["url", "title"]) if (typeof page[field] === "string") {
      const fieldValue = excerpt(page[field] as string, field === "url" ? 1024 : 512);
      result[field] = fieldValue.value;
      if (fieldValue.truncated) result[`${field}Truncated`] = true;
    }
    context.page = result;
  }
  const artifact = artifactMetadata(record.artifact);
  if (artifact) context.artifact = artifact;
  return context;
}
function screenshotMetadata(image: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = typeof image.data === "string" && image.data.length ? image.data : undefined;
  const artifactId = Number.isSafeInteger(image.artifactId) && Number(image.artifactId) > 0 ? image.artifactId : undefined;
  if (data === undefined && artifactId === undefined) return undefined;
  const mediaType = exactText(image.mediaType, 128);
  const screenshot: Record<string, unknown> = { ...(data === undefined ? {} : { data }), ...(artifactId === undefined ? {} : { artifactId }), ...(mediaType === undefined ? {} : { mediaType }) };
  for (const field of ["width", "height", "scale"]) if (typeof image[field] === "number" && Number.isFinite(image[field])) screenshot[field] = image[field];
  const origin = geometry(image.origin, ["x", "y"]);
  if (origin) screenshot.origin = origin;
  return screenshot;
}
/** Preserve the last usable screenshot, matching prepareToolMessages' image selection. */
function visualEvidence(value: unknown): VisualEvidence | undefined {
  let found: VisualEvidence | undefined;
  const visit = (item: unknown, path: Array<string | number>): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach((entry, index) => visit(entry, [...path, index])); return; }
    const record = item as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (key === "screenshot" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        const screenshot = screenshotMetadata(entry as Record<string, unknown>);
        if (screenshot) { found = { screenshot, context: visualContext(record), path }; continue; }
      }
      visit(entry, [...path, key]);
    }
  };
  visit(value, []);
  return found;
}

function jobMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["id", "state"]) {
    const value = exactText(record[field], 512); if (value !== undefined) result[field] = value;
  }
  for (const field of ["terminal", "ok", "hasMore"]) if (typeof record[field] === "boolean") result[field] = record[field];
  if (Number.isSafeInteger(record.nextCursor) && Number(record.nextCursor) >= 0) result.nextCursor = record.nextCursor;
  return result;
}
function searchMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["tabId", "documentId", "total"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) result[field] = record[field];
  if (typeof record.hasMore === "boolean") result.hasMore = record.hasMore;
  const cursor = exactText(record.nextCursor, 512); if (cursor !== undefined) result.nextCursor = cursor;
  return result;
}
function eventMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["subscriptionId", "closed"]) { const value = exactText(record[field], 512); if (value !== undefined) result[field] = value; }
  for (const field of ["hasMore", "timedOut"]) if (typeof record[field] === "boolean") result[field] = record[field];
  if (Number.isSafeInteger(record.nextCursor) && Number(record.nextCursor) >= 0) result.nextCursor = record.nextCursor;
  if (Array.isArray(record.events)) {
    result.eventCount = record.events.length;
    result.cursorNote = "Read all events from the artifact before advancing nextCursor.";
  }
  if (record.overflow && typeof record.overflow === "object" && !Array.isArray(record.overflow)) {
    const overflow = record.overflow as Record<string, unknown>;
    if (Number.isSafeInteger(overflow.from) && Number(overflow.from) >= 0 && Number.isSafeInteger(overflow.through) && Number(overflow.through) >= Number(overflow.from))
      result.overflow = { from: overflow.from, through: overflow.through };
  }
  return result;
}
function inspectionMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["observationId", "mode", "nextCursor", "reset"]) { const value = exactText(record[field], 512); if (value !== undefined) result[field] = value; }
  for (const field of ["tabId", "documentId"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) result[field] = record[field];
  if (record.truncation && typeof record.truncation === "object" && !Array.isArray(record.truncation)) {
    const source = record.truncation as Record<string, unknown>; const truncation: Record<string, unknown> = {};
    for (const field of ["truncated", "baselineComplete"]) if (typeof source[field] === "boolean") truncation[field] = source[field];
    for (const field of ["total", "returned", "offset", "charOffset", "nextOffset", "nextCharOffset", "budget", "used", "requiredBudget"]) if (Number.isSafeInteger(source[field]) && Number(source[field]) >= 0) truncation[field] = source[field];
    const reason = exactText(source.reason, 128); if (reason !== undefined) truncation.reason = reason;
    result.truncation = truncation;
  }
  return result;
}
function failureMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["jobId", "state", "timeoutSource"]) {
    const value = exactText(record[field], 512); if (value !== undefined) result[field] = value;
  }
  if (Number.isSafeInteger(record.timeoutMs) && Number(record.timeoutMs) >= 0) result.timeoutMs = record.timeoutMs;
  const receipt = record.receipts;
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
    const source = receipt as Record<string, unknown>; const output: Record<string, unknown> = {};
    for (const field of ["tool", "jobId"]) { const value = exactText(source[field], 512); if (value !== undefined) output[field] = value; }
    if (Number.isSafeInteger(source.after) && Number(source.after) >= 0) output.after = source.after;
    result.receipts = output;
  }
  return result;
}
function blockerMetadata(blocked: unknown): Record<string, unknown> | undefined {
  if (!blocked || typeof blocked !== "object" || Array.isArray(blocked)) return undefined;
  const record = blocked as Record<string, unknown>; const result: Record<string, unknown> = {};
  for (const field of ["kind", "dialogId", "type"]) { const value = exactText(record[field], 512); if (value !== undefined) result[field] = value; }
  if (Number.isSafeInteger(record.evidenceId) && Number(record.evidenceId) >= 0) result.evidenceId = record.evidenceId;
  if (record.source && typeof record.source === "object" && !Array.isArray(record.source)) {
    const source = record.source as Record<string, unknown>; const sanitized: Record<string, unknown> = {};
    if (Number.isSafeInteger(source.tabId) && Number(source.tabId) >= 0) sanitized.tabId = source.tabId;
    const sessionId = exactText(source.sessionId, 512); if (sessionId !== undefined) sanitized.sessionId = sessionId;
    result.source = sanitized;
  }
  return result;
}

function boundedError(error: unknown): unknown {
  if (typeof error === "string") return excerpt(error, 2048).value;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>; const result: Record<string, unknown> = {};
  for (const field of ["code", "name"]) {
    const value = exactText(record[field], 256);
    if (value !== undefined) result[field] = value;
  }
  if (typeof record.message === "string") {
    const message = excerpt(record.message, 2048); result.message = message.value;
    if (message.truncated) result.messageTruncated = true;
  }
  for (const field of ["retryable", "effectUnknown"]) if (typeof record[field] === "boolean") result[field] = record[field];
  return result;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, part) => current !== null && typeof current === "object" ? (current as any)[part] : undefined, value);
}

function isPageable(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) || value instanceof Map || value instanceof Set || isArrayBuffer(value) || ArrayBuffer.isView(value);
}

function nativePageLimit(value: unknown): number | undefined {
  if (value instanceof Map || value instanceof Set || Array.isArray(value)) return 25;
  if (isArrayBuffer(value)) return 3072;
  if (ArrayBuffer.isView(value)) {
    const { byteLength, length } = viewLayout(value);
    return Math.max(1, Math.floor(3072 / (length ? byteLength / length : 1)));
  }
  return undefined;
}

function pageValue(nativeValue: unknown, normalizedValue: unknown): unknown {
  return nativeValue instanceof Map || nativeValue instanceof Set || isArrayBuffer(nativeValue) || ArrayBuffer.isView(nativeValue)
    ? nativeValue : normalizedValue;
}

function readablePathOf(value: unknown): Array<string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const path of [["result", "snapshot"], ["result", "actual"], ["result"], ["snapshot"], ["observation", "snapshot"], ["text"], ["html"]] as const) {
    const selected = valueAt(value, path);
    if (isPageable(selected)) return [...path];
  }
  const key = Object.keys(value).find((candidate) => isPageable((value as Record<string, unknown>)[candidate]));
  return key ? [key] : undefined;
}

const PREVIEW_BYTES = 4096;
const previewEncoder = new TextEncoder();

/** Persist the native value before constructing potentially enormous sidecars. */
async function storeUnnormalizedResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string; runId?: string; toolCallIdCanonical?: boolean; preserveJobStatus?: boolean; preserveSearchStatus?: boolean; preserveInspectionStatus?: boolean; preserveEventStatus?: boolean; preserveDiagnosticStatus?: boolean; preserveVerification?: boolean }): Promise<unknown> {
  if (!options.logger) throw new Error("Large result requires a canonical event log for paged access");
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, runId: options.runId, toolCallIdCanonical: options.toolCallIdCanonical, content: { sidecarsDeferred: true }, output: value });
  if (!event) throw new Error("Could not save large tool result");
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const job = options.preserveJobStatus ? root : undefined;
  const search = options.preserveSearchStatus ? root : undefined;
  const inspection = options.preserveInspectionStatus ? root : undefined;
  const browserEvents = options.preserveEventStatus ? root : undefined;
  const diagnostic = options.preserveDiagnosticStatus && root?.result && typeof root.result === "object" && !Array.isArray(root.result) ? root.result as Record<string, unknown> : undefined;
  const verification = options.preserveVerification && root?.result && typeof root.result === "object" && !Array.isArray(root.result) ? root.result as Record<string, unknown> : undefined;
  const handoff = root?.accepted === true && root.complete === false && typeof root.jobId === "string" ? root : undefined;
  const blocked = handoff?.blockedBy;
  const visualRecord = [root?.result, root].find((item) => item && typeof item === "object" && !Array.isArray(item)
    && (item as Record<string, unknown>).screenshot && typeof (item as Record<string, unknown>).screenshot === "object") as Record<string, unknown> | undefined;
  const screenshot = visualRecord ? screenshotMetadata(visualRecord.screenshot as Record<string, unknown>) : undefined;
  const visualPath = visualRecord === root ? [] : ["result"];
  const path = diagnostic && Array.isArray(diagnostic.requests) ? ["result", "requests"] : diagnostic && Array.isArray(diagnostic.messages) ? ["result", "messages"]
    : browserEvents && Array.isArray(browserEvents.events) ? ["events"] : job && Array.isArray(job.events) ? ["events"]
    : search && Array.isArray(search.elements) ? ["elements"] : search && Array.isArray(search.frames) ? ["frames"]
    : inspection && Array.isArray(inspection.items) ? ["items"] : readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const access = (selectedPath: readonly (string | number)[] | undefined, item: unknown) => ({ artifactId: event.id,
    ...(selectedPath ? { path: selectedPath } : {}), ...(nativePageLimit(item) !== undefined ? { offset: 0, limit: nativePageLimit(item) } : typeof item === "string" ? { offset: 0, limit: 1000 } : {}) });
  const failure = root?.ok === false || root?.type === "tool-error";
  const errorPath = root && Object.hasOwn(root, "error") ? ["error"] : ["result", "error"];
  const error = failure ? valueAt(value, errorPath) : undefined;
  return { $ref: event.id, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    access: access(path, selected), sidecarsDeferred: true,
    pathsNote: "Read a bounded slice with read_artifact; its type sidecars are relative to that slice. Shared or cyclic objects and views with backing buffers require artifacts.read in execute_program to inspect their native identity. For oversized items, select a nested path or use artifacts.read in execute_program.",
    ...(root && Object.hasOwn(root, "result") ? { resultAccess: access(["result"], root.result) } : {}),
    ...(job ? jobMetadata(job) : {}), ...(search ? searchMetadata(search) : {}),
    ...(inspection ? inspectionMetadata(inspection) : {}), ...(browserEvents ? eventMetadata(browserEvents) : {}),
    ...(diagnostic ? { ...(diagnostic.integrity === "complete" || diagnostic.integrity === "incomplete" ? { integrity: diagnostic.integrity } : {}),
      ...(typeof diagnostic.hasMore === "boolean" || diagnostic.hasMore === null ? { hasMore: diagnostic.hasMore } : {}),
      ...(Number.isSafeInteger(diagnostic.nextOffset) && Number(diagnostic.nextOffset) >= 0 ? { nextOffset: diagnostic.nextOffset } : {}),
      ...(exactText(diagnostic.reason, 128) !== undefined ? { reason: diagnostic.reason } : {}) } : {}),
    ...(failure ? { ...(root?.ok === false ? { ok: false } : {}), ...(root?.type === "tool-error" ? { type: "tool-error" } : {}),
      ...failureMetadata(root!), ...(Object.hasOwn(root!, "receipts") ? { receiptsAccess: { artifactId: event.id, path: ["receipts"] } } : {}),
      ...(error === undefined ? {} : { error: boundedError(error), errorAccess: { artifactId: event.id, path: errorPath } }) } : {}),
    ...(screenshot && visualRecord ? { ...visualContext(visualRecord), screenshot, visualAccess: { artifactId: event.id, path: visualPath } } : {}),
    ...(root && Object.hasOwn(root, "artifact") ? { artifact: artifactMetadata(root.artifact), artifactAccess: { artifactId: event.id, path: ["artifact"] } } : {}),
    ...(handoff ? { accepted: true, complete: false, ...failureMetadata(handoff),
      ...(blocked && typeof blocked === "object" ? { blockedBy: blockerMetadata(blocked), blockedByAccess: { artifactId: event.id, path: ["blockedBy"] } } : {}) } : {}),
    ...(typeof verification?.verified === "boolean" ? { verification: { verified: verification.verified,
      ...(typeof verification.timedOut === "boolean" ? { timedOut: verification.timedOut } : {}),
      ...(typeof verification.present === "boolean" ? { present: verification.present } : {}) } } : {}) };
}
function previewString(value: string, maxCharacters: number, maxBytes: number): string {
  let low = 0, high = Math.min(value.length, maxCharacters);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (previewEncoder.encode(JSON.stringify(value.slice(0, middle))).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Recommend a slice small enough for a normal tool-result envelope as well. */
function artifactAccess(artifactId: number, path: readonly (string | number)[] | undefined, value: unknown): {
  access: { artifactId: number; path?: readonly (string | number)[]; offset?: number; limit?: number };
  oversizedItem?: { path: readonly (string | number)[]; guidance: string };
} {
  const access: { artifactId: number; path?: readonly (string | number)[]; offset?: number; limit?: number } = { artifactId, ...(path ? { path } : {}) };
  if (value instanceof Map || value instanceof Set || isArrayBuffer(value) || ArrayBuffer.isView(value))
    return { access: { ...access, offset: 0, limit: nativePageLimit(value) } };
  if (typeof value === "string") {
    let length = previewString(value, 4000, PREVIEW_BYTES).length;
    if (length && length < value.length && /[\uD800-\uDBFF]/.test(value[length - 1]!) && /[\uDC00-\uDFFF]/.test(value[length]!)) length -= 1;
    return { access: { ...access, offset: 0, limit: length === value.length ? 4000 : length } };
  }
  if (!Array.isArray(value)) return { access };
  let used = 2, count = 0;
  for (const item of value.slice(0, 50)) {
    // JSON arrays encode undefined values as null; count the actual wire bytes.
    const bytes = previewEncoder.encode(JSON.stringify(item) ?? "null").byteLength;
    if (used + (count ? 1 : 0) + bytes > PREVIEW_BYTES) break;
    used += (count ? 1 : 0) + bytes;
    count += 1;
  }
  const limit = count === value.length ? 50 : Math.max(1, count);
  if (count || value.length === 0) return { access: { ...access, offset: 0, limit } };
  return { access: { ...access, offset: 0, limit: 1 }, oversizedItem: {
    path: [...(path ?? []), 0],
    guidance: "The first item exceeds the recommended byte budget. Use execute_program with artifacts.read on this item and return only selected fields or bounded substrings; do not return the entire item.",
  } };
}
function previewOf(value: unknown, path?: readonly (string | number)[]): unknown {
  const selected = path ? valueAt(value, path) : value;
  if (typeof selected === "string") return previewString(selected, 4000, PREVIEW_BYTES);
  let remaining = 60;
  const visit = (item: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 4) return "[truncated]";
    if (typeof item === "string") return item.length > 256 ? `${item.slice(0, 256)}…` : item;
    if (Array.isArray(item)) return item.slice(0, 10).map((entry) => visit(entry, depth + 1));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).slice(0, 10).map(([key, entry]) => [key, visit(entry, depth + 1)]));
    return item;
  };
  const preview = visit(selected, 0);
  const json = JSON.stringify(preview);
  if (json !== undefined && previewEncoder.encode(json).byteLength > PREVIEW_BYTES)
    return { truncated: true, sample: previewString(json, 2000, PREVIEW_BYTES - 64) };
  return preview;
}

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string; runId?: string; toolCallIdCanonical?: boolean; preserveVerification?: boolean; preserveJobStatus?: boolean; preserveSearchStatus?: boolean; preserveInspectionStatus?: boolean; preserveDiagnosticStatus?: boolean; preserveEventStatus?: boolean; preserveArtifactValue?: boolean; originalResult?: unknown }): Promise<unknown> {
  if ((value && typeof value === "object" && "$ref" in value) || !options.logger) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (serialized === undefined) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const storedValue = Object.hasOwn(options, "originalResult") && value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, result: options.originalResult } : value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, runId: options.runId, toolCallIdCanonical: options.toolCallIdCanonical, content: { bytes }, output: storedValue });
  if (!event) throw new Error("Could not save large tool result");
  const root = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const job = options.preserveJobStatus ? root : undefined;
  const search = options.preserveSearchStatus ? root : undefined;
  const inspection = options.preserveInspectionStatus ? root : undefined;
  const browserEvents = options.preserveEventStatus ? root : undefined;
  const original = root?.envelopeWrapped === true && root.result && typeof root.result === "object" && !Array.isArray(root.result) ? root.result as Record<string, unknown> : root;
  const prefix = original !== root ? ["result"] : [];
  const diagnostic = options.preserveDiagnosticStatus && original?.result && typeof original.result === "object" && !Array.isArray(original.result) ? original.result as Record<string, unknown> : undefined;
  const visual = visualEvidence(value);
  const failure = root?.ok === false || root?.type === "tool-error";
  const errorPath = original && Object.hasOwn(original, "error") ? [...prefix, "error"] : [...prefix, "result", "error"];
  const error = failure ? valueAt(value, errorPath) : undefined;
  const path = diagnostic && Array.isArray(diagnostic.requests) ? [...prefix, "result", "requests"] : diagnostic && Array.isArray(diagnostic.messages) ? [...prefix, "result", "messages"] : browserEvents && Array.isArray(browserEvents.events) ? [...prefix, "events"] : job && Array.isArray(job.events) ? [...prefix, "events"] : search && Array.isArray(search.elements) ? [...prefix, "elements"] : search && Array.isArray(search.frames) ? [...prefix, "frames"]
    : inspection && Array.isArray(inspection.items) ? [...prefix, "items"] : readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const { access, oversizedItem } = artifactAccess(event.id, path, pageValue(path ? valueAt(storedValue, path) : storedValue, selected));
  const resultRead = root && Object.hasOwn(root, "result") ? artifactAccess(event.id, ["result"], pageValue(valueAt(storedValue, ["result"]), root.result)) : undefined;
  const undefinedPaths = options.preserveArtifactValue && Array.isArray(root?.undefinedPaths) ? root.undefinedPaths : undefined;
  const holePaths = options.preserveArtifactValue && Array.isArray(root?.holePaths) ? root.holePaths : undefined;
  const numberPaths = options.preserveArtifactValue && Array.isArray(root?.numberPaths) ? root.numberPaths : undefined;
  const bigintPaths = options.preserveArtifactValue && Array.isArray(root?.bigintPaths) ? root.bigintPaths : undefined;
  const typePaths = options.preserveArtifactValue && Array.isArray(root?.typePaths) ? root.typePaths : undefined;
  const undefinedPathsRead = undefinedPaths?.length ? artifactAccess(event.id, ["undefinedPaths"], undefinedPaths) : undefined;
  const holePathsRead = holePaths?.length ? artifactAccess(event.id, ["holePaths"], holePaths) : undefined;
  const numberPathsRead = numberPaths?.length ? artifactAccess(event.id, ["numberPaths"], numberPaths) : undefined;
  const bigintPathsRead = bigintPaths?.length ? artifactAccess(event.id, ["bigintPaths"], bigintPaths) : undefined;
  const typePathsRead = typePaths?.length ? artifactAccess(event.id, ["typePaths"], typePaths) : undefined;
  const verificationEnvelope = !options.preserveVerification ? undefined
    : root?.envelopeWrapped === true && root.result && typeof root.result === "object" ? root.result as Record<string, unknown> : root;
  const verification = verificationEnvelope && "result" in verificationEnvelope
    ? verificationEnvelope.result as { verified?: unknown; timedOut?: unknown; present?: unknown } | undefined : undefined;
  const handoff = value && typeof value === "object" && (value as any).accepted === true && (value as any).complete === false && typeof (value as any).jobId === "string" ? value as Record<string, any> : undefined;
  const blocked = handoff?.blockedBy;
  return { $ref: event.id, bytes, preview: job ? { eventCount: Array.isArray(job.events) ? job.events.length : 0 } : handoff || visual && typeof selected !== "string" ? undefined : previewOf(value, path), access, ...(oversizedItem ? { oversizedItem } : {}), type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    ...(root?.envelopeWrapped === true ? { envelopeWrapped: true } : {}),
    ...(job ? jobMetadata(job) : {}),
    ...(search ? searchMetadata(search) : {}),
    ...(inspection ? inspectionMetadata(inspection) : {}),
    ...(browserEvents ? eventMetadata(browserEvents) : {}),
    ...(diagnostic ? { ...(diagnostic.integrity === "complete" || diagnostic.integrity === "incomplete" ? { integrity: diagnostic.integrity } : {}),
      ...(typeof diagnostic.hasMore === "boolean" || diagnostic.hasMore === null ? { hasMore: diagnostic.hasMore } : {}),
      ...(Number.isSafeInteger(diagnostic.nextOffset) && Number(diagnostic.nextOffset) >= 0 ? { nextOffset: diagnostic.nextOffset } : {}),
      ...(exactText(diagnostic.reason, 128) !== undefined ? { reason: diagnostic.reason } : {}) } : {}),
    ...(resultRead ? { resultAccess: resultRead.access, ...(resultRead.oversizedItem ? { resultOversizedItem: resultRead.oversizedItem } : {}) } : {}),
    ...(undefinedPathsRead ? { undefinedCount: undefinedPaths!.length, undefinedPathsAccess: undefinedPathsRead.access,
      ...(undefinedPathsRead.oversizedItem ? { undefinedPathsOversizedItem: undefinedPathsRead.oversizedItem } : {}) } : {}),
    ...(holePathsRead ? { holeCount: holePaths!.length, holePathsAccess: holePathsRead.access,
      ...(holePathsRead.oversizedItem ? { holePathsOversizedItem: holePathsRead.oversizedItem } : {}) } : {}),
    ...(numberPathsRead ? { numberCount: numberPaths!.length, numberPathsAccess: numberPathsRead.access,
      ...(numberPathsRead.oversizedItem ? { numberPathsOversizedItem: numberPathsRead.oversizedItem } : {}) } : {}),
    ...(bigintPathsRead ? { bigintCount: bigintPaths!.length, bigintPathsAccess: bigintPathsRead.access,
      ...(bigintPathsRead.oversizedItem ? { bigintPathsOversizedItem: bigintPathsRead.oversizedItem } : {}) } : {}),
    ...(typePathsRead ? { typeCount: typePaths!.length, typePathsAccess: typePathsRead.access,
      ...(typePathsRead.oversizedItem ? { typePathsOversizedItem: typePathsRead.oversizedItem } : {}) } : {}),
    ...(undefinedPaths?.length || holePaths?.length || numberPaths?.length || bigintPaths?.length || typePaths?.length ? { pathsNote: "Paths are relative to this returned result, including its requested slice; read the sidecars before interpreting values." } : {}),
    ...(failure ? { ...(root?.ok === false ? { ok: false } : {}), ...(root?.type === "tool-error" ? { type: "tool-error" } : {}),
      ...failureMetadata(root!),
      ...(Object.hasOwn(root!, "receipts") ? { receiptsAccess: { artifactId: event.id, path: ["receipts"] } } : {}),
      ...(error === undefined ? {} : { error: boundedError(error), errorAccess: { artifactId: event.id, path: errorPath } }) } : {}),
    ...(visual ? { ...visual.context, screenshot: visual.screenshot,
      visualAccess: { artifactId: event.id, ...(visual.path.length <= 20 && previewEncoder.encode(JSON.stringify(visual.path)).byteLength <= 2048 ? { path: visual.path } : {}) } } : {}),
    ...(root && Object.hasOwn(root, "artifact") ? { artifact: artifactMetadata(root.artifact), artifactAccess: { artifactId: event.id, path: ["artifact"] } } : {}),
    ...(handoff ? { accepted: true, complete: false, ...failureMetadata(handoff),
      ...(blocked && typeof blocked === "object" ? { blockedBy: blockerMetadata(blocked), blockedByAccess: { artifactId: event.id, path: ["blockedBy"] } } : {}) } : {}),
    ...(typeof verification?.verified === "boolean" ? { verification: { verified: verification.verified,
      ...(typeof verification.timedOut === "boolean" ? { timedOut: verification.timedOut } : {}),
      ...(typeof verification.present === "boolean" ? { present: verification.present } : {}) } } : {}) };
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
      if (typeof screenshot.data === "string" && screenshot.data.length > 0) {
        found.push({ mediaType: typeof screenshot.mediaType === "string" ? screenshot.mediaType : "image/png", data: screenshot.data });
        return [key, { ...screenshot, data: "[stored in canonical event log]" }];
      }
      if (Number.isSafeInteger(screenshot.artifactId) && Number(screenshot.artifactId) > 0) found.push({ mediaType: typeof screenshot.mediaType === "string" ? screenshot.mediaType : "image/png", artifactId: Number(screenshot.artifactId) });
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
