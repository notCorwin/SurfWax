import { SNAPSHOT_CANDIDATE_CONTEXT, type CandidateAssociation } from "./candidate-context";
import { logIO } from "../log-io";
import { normalizationExceedsBudget, normalizeResultEnvelope, TOOL_RESULT_BYTES } from "../tool-result-values";
import { isArrayBuffer } from "../log-graph";
import { dynamicTool, type ToolCallRepairFunction } from "ai";
import { z } from "zod";
import { safeDiagnosticError, safeDiagnosticText } from "../diagnostic-error";
import type { EventLogger } from "../logging";
import type { ChromeExecutor } from "./executor";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";
import type { ToolScheduler } from "./tool-scheduler";
import { jobResultReferenceInfo, readDiagnosticPagination, sourcePaginationOf, SOURCE_PAGINATION_NOTE } from "./job-result";
import { elementTargetSchema } from "./element-target";
import { SNAPSHOT_DELIVERY_COMMIT, type SnapshotDeliveryLease } from "./snapshot-wire";
import { createDeadline } from "../deadline";
import { ARTIFACT_READ_NOTE, artifactReadSelection, nativeArtifactPageLimit as nativePageLimit } from "../artifact-selection";

const timeoutMs = z.number().int().positive().optional();
export const PROGRAM_CATALOG_VERSION = "atomic-tools-v56";
export const inspectInputSchema = z.object({ timeoutMs, since: z.string().min(1).max(256).optional().describe("Compare with this completely delivered observation ID from the same tab, run and scope. Omit to reuse the latest valid baseline automatically."), full: z.boolean().optional().describe("Request a complete new baseline instead of an automatic delta when prior rows are unavailable."), tabId: z.number().int().nonnegative().optional(), region: z.union([z.string().min(1), elementTargetSchema]).optional().describe("Restrict inspection to one matching element. To inspect a frame use region:{by:\"css\",value:\"html\",frame:{ref:\"frameRef\"}}; frame is not a top-level inspect_page field. Prefer a structured target. A plain string is a CSS selector, except supported locator expressions such as getByRole('button', {name:'Save'})."),
  fields: z.array(z.enum(["text", "state", "actions"])).min(1).optional().describe("Fields to include; defaults to visible text, state and measured layout. IDs are always present; actionable=true identifies a single element usable as target:{id}. Request actions for supported action hints."), budget: z.number().int().min(100).max(1000000).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), depth: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).max(256).optional() }).strict()
  .refine((input) => input.cursor === undefined || [input.region, input.fields, input.depth, input.offset, input.full, input.since].every((value) => value === undefined),
    "cursor cannot be combined with region, fields, depth, offset, full, or since")
  .refine(input => input.full === undefined || input.since === undefined, "full cannot be combined with since")
  .meta({ allOf: [...["region", "fields", "depth", "offset", "full", "since"].map((field) => ({ not: { required: ["cursor", field] } })), { not: { required: ["full", "since"] } }] });
const findElementsInputSchema = z.object({ target: elementTargetSchema, tabId: z.number().int().nonnegative().optional(), timeoutMs,
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).optional() }).strict();
const listFramesInputSchema = z.object({ tabId: z.number().int().nonnegative().optional(), timeoutMs,
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).optional() }).strict();
const listJobsInputSchema = z.object({ timeoutMs, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const getJobInputSchema = z.object({ timeoutMs, jobId: z.string().min(1), after: z.number().int().nonnegative().optional().describe("Pass nextCursor from the previous get_job response to read subsequent receipts."), limit: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }).strict();
const cancelJobInputSchema = z.object({ timeoutMs, jobId: z.string().min(1) }).strict();
const listDownloadsInputSchema = z.object({ timeoutMs, downloadId: z.number().int().nonnegative().optional(), state: z.enum(["in_progress", "interrupted", "complete"]).optional(), limit: z.number().int().min(0).max(2_147_483_647).optional() }).strict();
const subscribeEventInputSchema = z.object({ tabId: z.number().int().nonnegative().optional(), kind: z.enum(["dialog", "popup", "download", "filechooser", "request", "response", "console"]), timeoutMs }).strict();
const waitEventInputSchema = z.object({ timeoutMs, subscriptionId: z.string().min(1), after: z.number().int().nonnegative().optional().describe("Pass cursor from subscribe_event or nextCursor from the previous wait_event response to read subsequent events."), limit: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }).strict();
const unsubscribeEventInputSchema = z.object({ timeoutMs, subscriptionId: z.string().min(1) }).strict();
const handleDialogInputSchema = z.object({ timeoutMs, dialogId: z.string().min(1), accept: z.boolean(), prompt: z.string().optional() }).strict()
  .refine((input) => input.accept || input.prompt === undefined, "prompt requires accept=true")
  .meta({ anyOf: [{ not: { required: ["prompt"] } }, { properties: { accept: { const: true } }, required: ["accept"] }] });

type ToolDefinition = { name: string; inputSchema: z.ZodType<any>; summary: string; description: string; program?: (input: any) => { code: string; timeoutMs?: number; defaultTimeoutMs?: number; background?: boolean } };
// These calls manage stored data or coordinate work, rather than operate a page.
// In particular they must remain usable while a background job holds the queue.
const NO_PAGE_CAPTURE = new Set(["list_file_choosers", "inspect_page", "read_artifact", "list_jobs", "subscribe_event", "wait_event", "unsubscribe_event", "list_downloads"]);
export const PROGRAM_TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze([
  { name: "inspect_page", inputSchema: inspectInputSchema, summary: "Read compact visible page content and measured layout", description: "Inspect currently visible structured page items. Every item has an id. Items marked actionable=true bind a single real element: use target:{id:item.id} in click, fill, hover or other element tools. IDs already identify their frame; do not combine an id with a locator or frame. IDs are scoped to the tab, document and run, and input revalidates node identity, visibility, enabled state and hit target; stale IDs must be reacquired rather than guessed. Non-actionable text, count groups and path ancestry are observation data, not action targets. Actionable elements are never combined into count/path groups. role/name are observed semantics, not proof of globally unique business identity. nameUnknown, valueUnknown and partial=true mark uncertain evidence; a proven label fragment may coexist with nameUnknown. Partial snapshots cannot establish complete coverage. Read-only recovery on continuously changing pages samples the root viewport in one synchronous DOM read, excludes embedded documents and may still return actionable IDs for its actual elements. fields defaults to text and state; IDs and actionability are always included. actions adds role-derived hints, not a guarantee an operation succeeds. box and textBox use per-document viewport CSS pixels; layout boxes can extend beyond clipped paint. DOM order and textParts order are structural, not visual reading order. Use list_frames frameRef as target.frame.ref for locator targets, or region:{by:\"css\",value:\"html\",frame:{ref:\"...\"}} to inspect a frame. Scroll to discover offscreen content. The default timeout is 15 seconds and inspection waits for complete page load. Default full/delta selection reuses only a completely delivered baseline; full=true starts a fresh full snapshot. Finish nextCursor before using a snapshot as a baseline. Continuations read a frozen observation; actionable continuations revalidate document and geometry. Pass nextCursor as cursor with only tabId, budget, limit or timeoutMs; continuation metadata may be omitted. Oversized name/value/textParts text can continue across pages; join each fragment.field in order. budget counts UTF-8 JSON bytes of items; the entire tool response is capped at 16 KiB. lookahead is sparse non-authoritative later context, not a delivered page or actionable target. Use find_elements for a specific element ID, read_value for current control value, or take_screenshot for visual evidence. Reused DOM nodes may still represent different business data despite unchanged identity; verify relevant page state before acting." },
  { name: "find_elements", inputSchema: findElementsInputSchema, summary: "Find candidates and return actionable IDs", description: "Find matching elements with id and actionable=true for actions. Candidate context links that ID to its current automatic pageSnapshot observation and nearest represented row/listitem (or group). visibleLabels contain only capture-proven visible fragments with itemId and optional pathIndex/textPartIndex provenance, even when the snapshot is delta or paged. Container references are observation data; scope:{id} is unsupported. status=unknown gives an unproved association; partial=true or labelsOmitted marks incomplete labels. This describes the current capture, and does not guarantee a business row stays unchanged. ID use checks the underlying role and identity, which may differ from visible text, but cannot prove business identity for reused nodes; verify relevant row and page state before acting. Older IDs may expire after later independent observations or searches. limit defaults to 25, max 100; repeat target and tab with nextCursor as cursor to page a fixed node list. Candidates may report detached, changed or identity-unknown without an actionable id. Details may change between pages; cursors expire on run or document changes or eviction." },
  { name: "list_frames", inputSchema: listFramesInputSchema, summary: "List frames and their document-bound refs", description: "List the selected tab's frame tree with refs usable as target.frame.ref. limit defaults to 25, max 100; pass nextCursor as cursor to continue a fixed snapshot. References and cursors expire on document or frame changes." },
  ...ATOMIC_TOOL_REGISTRY,
  { name: "list_downloads", inputSchema: listDownloadsInputSchema, summary: "Read Chrome's current download records", description: "List download metadata across the Chrome profile. limit defaults to 100; 0 requests all records. hasMore reports truncation. The list is live and Chrome's exists field may be stale; metadata does not provide file bytes." },
  { name: "list_file_choosers", inputSchema: z.object({ timeoutMs, tabId: z.number().int().nonnegative().optional() }).strict(), summary: "List live file choosers", description: "List file choosers currently observed in this run, optionally filtered by tabId. Each chooserId can be passed to upload_file_chooser. The source and frameId identify where it opened; an observed chooser is not necessarily caused by the last action. Handles expire on replacement, navigation, handling, or run end." },
  { name: "subscribe_event", inputSchema: subscribeEventInputSchema, summary: "Subscribe to browser events before triggering them", description: "Subscribe to a tab's dialog, popup, download, filechooser, request, response or console events. Returns a run-scoped subscription and cursor. Filechooser events include a chooserId for upload_file_chooser." },
  { name: "wait_event", inputSchema: waitEventInputSchema, summary: "Read or wait for subscribed events", description: "Read events after a subscription cursor, or wait up to waitMs. Pass the returned nextCursor as after on the next call; hasMore indicates unread events. Overflow, truncation and closure are explicit; a closed tab's bounded unread events remain available until unsubscribe or run end." },
  { name: "unsubscribe_event", inputSchema: unsubscribeEventInputSchema, summary: "Stop a browser event subscription", description: "Stop a subscription and release its resources." },
  { name: "handle_dialog", inputSchema: handleDialogInputSchema, summary: "Accept or dismiss a captured browser dialog", description: "Respond to a captured dialog by ID. prompt is allowed only when accepting a prompt dialog. An uncertain response must not be blindly retried." },
  { name: "list_jobs", inputSchema: listJobsInputSchema, summary: "List this conversation's jobs in pages", description: "List jobs in creation order in a fixed snapshot. limit defaults to 25, max 100. If hasMore, pass nextCursor as cursor to continue; cursor expires on log maintenance. Job state is as of the first page; get_job reads current state." },
  { name: "get_job", inputSchema: getJobInputSchema, summary: "Read a job's status and receipts", description: "Read status and paginated receipts for a job. Pass the previous response's nextCursor as after to read subsequent receipts. waitMs waits for receipts after the supplied canonical event cursor or for completion; unread receipts return immediately. A terminal event with outputAt:'result' or 'resultAccess' refers to that top-level field. A running job is not complete." },
  { name: "cancel_job", inputSchema: cancelJobInputSchema, summary: "Request cancellation of a job", description: "Cancel a job in the current conversation. Cancellation does not roll back dispatched effects." },
]);
export const PROGRAM_TOOL_CONTEXT = `Available tools:\n${PROGRAM_TOOL_REGISTRY.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n")}\nAn element target {id} already identifies its frame; do not combine it with frame. To use a frameRef, supply a locator target with by, value and frame:{ref}. Byte counts describe the expanded page. A snapshot marked partial=true includes uncertain content and is not complete evidence; inspect the relevant area to verify it. Snapshot lookahead is sparse, non-authoritative context without actionability; use a locator or continue nextCursor to reconstruct items. Use background=true for long operations or actions that may block on a browser event. Use get_job with after set to the previous nextCursor for incremental receipts and bounded waits, or cancel_job to cancel. Continue until terminal; cancellation never rolls back completed effects. Restart preserves job records, not running work. A foreground action blocked by a native dialog may return state=blocked with jobId and blockedBy.dialogId. Use handle_dialog, then check the job until terminal. To upload files, use upload_file with the file input target and existing artifact IDs. If a file chooser must be triggered instead, check fileChoosers in the action result or call list_file_choosers, then use upload_file_chooser with the chooserId. An observed chooser may come from another page event; verify its source before uploading. Handles expire on replacement, navigation, handling, or run end. Event subscriptions belong to this run. Every tool result includes evidenceId for citing that actual result in complete_goal. A snapshot with mode=delta applies added/updated/removed/moved items to the fully delivered baseObservationId; after identifies the previous row (null means first). Unchanged visible rows remain in that baseline. A new full snapshot replaces it; inspect_page full=true requests a fresh complete baseline, while since pins a specific fully delivered observation from this run and scope. Finish every nextCursor before using a snapshot as a baseline. pageSnapshot.actionContexts links only delivered actionable targetId values to same-capture observed container labels; these are not business identity or persistence guarantees. Container and label itemId fields are observation addresses, not action targets; their labels may come from outside this page in the frozen capture. omitted counts associations excluded by the bounded delivery budget; absent associations are unknown. Each completed operation includes pageSnapshot when available; use inspect_page with its nextCursor as cursor and the same tabId to continue a truncated snapshot. pageSnapshotStatus describes missing or self-delivered observations: captured is the inspect_page result at capture time; frozen is a cursor continuation, not a new capture. pending, unavailable and not-captured have freshness=unknown; older observations may be stale. Pending can mean handed-off work has not been observed terminal, not that it is still running. Use inspect_page for current page state when browser work permits. resultType=undefined marks an undefined result. undefinedPaths, holePaths, numberPaths and bigintPaths are relative to result; numberPaths entries hold {path,value} for NaN, Infinity, -Infinity or -0, and bigintPaths hold decimal strings. These replace values with null. typePaths marks non-JSON types: date is ISO or null for invalid; array-buffer and typed-array are base64 bytes (typed-array name identifies the view); regexp is {source,flags,lastIndex}; map is key/value pairs; set is an array. Apply the other sidecars first, then typePaths from deepest path to shallowest. Large results provide paged sidecar access. If envelopeWrapped=true, reconstruct the original tool envelope from result and its sidecars; outer fields summarize status.`;

export function createProgramTools(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; callId?: () => string | undefined; visualEnabled?: () => Promise<boolean>; scheduler?: ToolScheduler; runSignal?: AbortSignal } = {}): Record<string, ReturnType<typeof dynamicTool>> {
  return Object.fromEntries(PROGRAM_TOOL_REGISTRY.map((definition) => [definition.name, dynamicTool({
    description: definition.description, inputSchema: definition.inputSchema, needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => {
      abortSignal?.throwIfAborted();
      const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const program = definition.program?.(input);
      const operationTimeout = program?.timeoutMs ?? program?.defaultTimeoutMs
        ?? (typeof value.timeoutMs === "number" && value.timeoutMs > 0 ? value.timeoutMs : undefined)
        ?? (definition.name === "inspect_page" ? 15_000 : 40_000);
      const timeout = Math.max(operationTimeout, typeof value.waitMs === "number" ? value.waitMs + 1_000 : 0);
      const parent = abortSignal && options.runSignal ? AbortSignal.any([abortSignal, options.runSignal]) : abortSignal ?? options.runSignal;
      const deadline = createDeadline(timeout, parent, `Tool ${definition.name}`);
      abortSignal = deadline.signal;
      try {
        const identity = options.conversationId ? options.logger?.toolIdentity(options.conversationId, toolCallId) : undefined;
        const callId = options.callId?.();
        const startedAt = performance.now();
        let failureCause: unknown;
        let artifactLookup: Promise<{ id: number } | undefined> | undefined;
        let observedTerminalJob: string | undefined;
        let resultPending = false;
        const observationStatus = (output: Record<string, unknown>) => pageObservationStatus(output, definition.name,
          resultPending || (executor.pendingBackgroundJobs?.() ?? []).some(id => id !== observedTerminalJob), abortSignal?.aborted === true);
        if (options.logger) {
          const started = await logIO(options.logger.append({ type: "tool.started", conversationId: options.conversationId,
            content: { callId, toolName: definition.name }, input, toolCallId, ...identity }), "记录工具启动", Math.min(timeout, 10_000), abortSignal);
          if (!started) throw new DOMException("日志维护已阻止工具启动。", "AbortError");
        }
        let terminal: Promise<unknown> | undefined;
        const finish = (output: unknown): Promise<unknown> => terminal ??= (async () => {
          const record = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : { result: output };
          const status = observationStatus(record);
          const decorated: Record<string, unknown> = { ...record, ...(status ? { pageSnapshotStatus: status } : {}) };
          const { pageSnapshot, ...core } = decorated;
          const ownInspection = definition.name === "inspect_page" && typeof record.observationId === "string" && Array.isArray(record.items) && record.ok !== false;
          const compaction = { ...options, toolCallId, ...identity,
            preserveJobStatus: definition.name === "get_job" || definition.name === "cancel_job",
            preserveSearchStatus: definition.name === "find_elements" || definition.name === "list_frames",
            preserveDiagnosticStatus: definition.name === "list_requests" || definition.name === "read_console" || Boolean(core.sourcePagination),
            preserveEventStatus: definition.name === "wait_event", preserveVerification: definition.name === "verify_state" };
          const jobRef = jobResultReferenceInfo(core.result);
          if (definition.name === "read_artifact")
            output = core.ok === false && core.error ? { ...core, error: boundedError(core.error) } : core;
          else if (ownInspection) output = core;
          else if (jobRef) {
            const resultAccess = { artifactId: jobRef.id, path: ["result"], ...(jobRef.info.limit === undefined ? {} : { offset: 0, limit: jobRef.info.limit }) };
            const access = jobRef.info.page ? { artifactId: jobRef.id, path: jobRef.info.page.path, offset: 0, limit: jobRef.info.page.limit } : resultAccess;
            const reference = { $ref: jobRef.id, resultAccess, access, sidecarsDeferred: true,
              readNote: ARTIFACT_READ_NOTE, pathsNote: "Shared or cyclic object identity is not exposed.",
              ...(jobRef.info.error ? { error: recoveryError(jobRef.info.error, definition.name), errorAccess: { artifactId: jobRef.id, path: ["result", "error"] } } : {}),
              ...(jobRef.info.artifact ? { artifact: jobRef.info.artifact, artifactAccess: { artifactId: jobRef.id, path: ["result", "artifact"] } } : {}),
              ...(jobRef.info.screenshot ? { ...jobRef.info.visualContext, screenshot: { ...jobRef.info.screenshot, ...(jobRef.info.inlineScreenshot ? { artifactId: jobRef.id, artifactPath: ["result", "screenshot"] } : {}) }, visualAccess: { artifactId: jobRef.id, path: ["result"] } } : {}) };
            const reservedBytes = previewEncoder.encode(JSON.stringify({ ...reference, evidenceId: identity?.toolCallId ?? toolCallId })).byteLength;
            const { result: _result, ...rest } = core;
            const compact = normalizationExceedsBudget(rest)
              ? await storeUnnormalizedResult(rest, compaction)
              : await compactToolResult(normalizeResultEnvelope(rest), { ...compaction, reservedBytes });
            const visible = compact as Record<string, unknown>;
            const { access: receiptsAccess, oversizedItem: receiptsOversizedItem, ...visibleEnvelope } = visible;
            output = { ...visibleEnvelope, ...(visible.$ref ? { receiptsArtifactId: visible.$ref, receiptsAccess, ...(receiptsOversizedItem ? { receiptsOversizedItem } : {}) } : {}), ...reference };
          } else if (normalizationExceedsBudget(core)) output = await storeUnnormalizedResult(core, compaction);
          else {
            const normalized = normalizeResultEnvelope(core);
            const originalResult = normalized.envelopeWrapped === true ? core : Object.hasOwn(core, "result") ? core.result : undefined;
            const hasResult = Object.hasOwn(normalized, "result");
            output = await compactToolResult(normalized, { ...compaction, preserveArtifactValue: hasResult, ...(hasResult ? { originalResult } : {}) });
          }
          output = { ...output as object, ...(pageSnapshot ? { pageSnapshot } : {}), evidenceId: identity?.toolCallId ?? toolCallId };
          if (options.logger) {
            const failed = Boolean(output && typeof output === "object" && "ok" in output && output.ok === false);
            const interrupted = failed && parent?.aborted === true;
            const error = failed ? (output as { error?: unknown }).error : undefined;
            const effectUnknown = Boolean(error && typeof error === "object" && "effectUnknown" in error && error.effectUnknown);
            const latencyMs = Math.max(0, performance.now() - startedAt);
            const terminal = await logIO(options.logger.append({ type: failed ? "tool.failed" : "tool.finished", conversationId: options.conversationId,
              content: { callId, toolName: definition.name, ...(failureCause === undefined ? {} : { failureCause }), ...(interrupted ? { status: "interrupted", effectUnknown } : {}) },
              input, output, toolCallId, ...identity, ...(failed ? { error } : {}),
              ...(interrupted ? { abort: { reason: Object.assign(new Error(String(abortSignal?.reason ?? "Operation aborted")), { name: "AbortError" }) } } : {}),
              latencyMs }), "记录工具结果");
            if (!terminal) throw new DOMException("日志维护已阻止工具结果保存。", "AbortError");
          }
          return output;
        })();
        const failureFor = async (error: unknown, executing: boolean) => {
          failureCause = safeDiagnosticError(error);
          const cause = abortSignal?.aborted && !(error instanceof Error) && !(error instanceof DOMException)
            ? new DOMException(abortSignal.reason instanceof Error ? abortSignal.reason.message : String(abortSignal.reason ?? error ?? "Operation aborted"), "AbortError")
            : error;
          const failure = toolFailure(cause);
          if (definition.name === "inspect_page" && cause && typeof cause === "object" && "detail" in cause && cause.detail && typeof cause.detail === "object" && "reason" in cause.detail && cause.detail.reason === "frame-region-no-match" && "recovery" in cause.detail && typeof cause.detail.recovery === "string") {
            failure.error = { ...failure.error, recovery: cause.detail.recovery };
          }
          const chooserUpload = definition.name === "upload_file_chooser";
          if (executing && !chooserUpload && definition.name !== "read_artifact" && abortSignal?.aborted && definition.program && !READ_ONLY_TOOLS.has(definition.name)) {
            const dispatched = executor.programEffectUnknown?.(identity?.toolCallId ?? toolCallId);
            failure.error.effectUnknown = failure.error.effectUnknown === true || (dispatched ?? failure.error.effectUnknown ?? true);
          }
          failure.error = recoveryError(failure.error, definition.name);
          if (!failure.artifact && options.logger && identity?.runId) {
            const artifact = await (artifactLookup ??= logIO(options.logger.toolArtifact(options.conversationId!, identity), "读取工具产物", Math.min(1000, timeout)).catch(() => undefined));
            if (artifact) failure.artifact = artifact;
          }
          return failure;
        };
        let entered = false;
        const work = async () => {
          entered = true;
          let output: unknown;
          let executing = false;
          let inspectionDelivery: SnapshotDeliveryLease | undefined;
          let openedTabId: number | undefined;
          let recentRefs: string[] = [];
          try {
            abortSignal?.throwIfAborted();
            const context = { conversationId: options.conversationId, toolCallId, logIdentity: identity, runSignal: options.runSignal, visualEnabled: await options.visualEnabled?.() ?? false };
            abortSignal?.throwIfAborted();
            const value = definition.inputSchema.parse(input);
            executing = true;
            const result = definition.name === "inspect_page" ? await executor.inspect({ ...value, wire: { maxBytes: INSPECTION_RESULT_BYTES - INSPECTION_STATUS_BYTES, evidenceId: identity?.toolCallId ?? toolCallId } } as any, abortSignal, context)
              : definition.name === "find_elements" ? await executor.findElements(value as any, abortSignal, context)
              : definition.name === "list_frames" ? await executor.listFrames(value as any, abortSignal, context)
              : definition.name === "list_tabs" ? await executor.listTabs(abortSignal, value.timeoutMs)
              : definition.name === "switch_tab" ? await executor.switchTab(value.tabId, abortSignal, value.timeoutMs)
              : definition.name === "list_downloads" ? await executor.listDownloads(value, abortSignal)
              : definition.name === "read_console" && value.mode === "retained" ? await executor.readRetainedConsole(value as any, abortSignal, context)
              : definition.name === "read_artifact" ? await executor.readArtifact(value, abortSignal, context, observationStatus({}))
              : definition.name === "list_file_choosers" ? await executor.listFileChoosers(value, abortSignal, context)
              : definition.name === "subscribe_event" ? await executor.subscribeEvent(value, abortSignal, context)
              : definition.name === "wait_event" ? await executor.waitEvent(value, abortSignal, context)
              : definition.name === "unsubscribe_event" ? await executor.unsubscribeEvent(value, abortSignal, context)
              : definition.name === "handle_dialog" ? await executor.handleDialog(value, abortSignal, context)
              : definition.name === "upload_file_chooser" ? await executor.uploadChooser(value, abortSignal, context)
              : definition.name === "list_jobs" ? await executor.queryJobs({ action: "list", limit: value.limit, cursor: value.cursor }, abortSignal, context)
              : definition.name === "get_job" ? await executor.queryJobs({ action: value.waitMs ? "wait" : "status", id: value.jobId, after: value.after, limit: value.limit, waitMs: value.waitMs }, abortSignal, context)
              : definition.name === "cancel_job" ? await executor.queryJobs({ action: "cancel", id: value.jobId }, abortSignal, context)
              : await executor.runProgram(program!, abortSignal, context);
            resultPending = (result as any)?.complete === false || ((definition.name === "get_job" || definition.name === "cancel_job") && (result as any)?.terminal !== true);
            if ((definition.name === "get_job" || definition.name === "cancel_job") && (result as any)?.terminal === true && typeof (result as any).id === "string") observedTerminalJob = (result as any).id;
            if (definition.name === "open_tab" && Number.isSafeInteger((result as any)?.result?.tabId)) openedTabId = (result as any).result.tabId;
            if (definition.name === "find_elements" && Array.isArray((result as any)?.elements))
              recentRefs = (result as any).elements.flatMap((element: any) => typeof element?.id === "string" ? [element.id] : []);
            const jobRef = jobResultReferenceInfo((result as any)?.result);
            const diagnosticTool = definition.name === "read_console" || definition.name === "list_requests";
            const pagination = jobRef && options.logger && options.conversationId
              ? await readDiagnosticPagination(options.logger, jobRef.id, ["result"], options.conversationId, abortSignal)
              : diagnosticTool ? sourcePaginationOf((result as any)?.result ?? result) : undefined;
            const presentation = diagnosticPaginationPresentation(pagination, diagnosticTool ? definition.name : undefined, value);
            const failure = (result as any)?.ok === false ? (result as any).error ?? (result as any).failed?.error ?? jobRef?.info.error ?? (result as any).result?.error : undefined;
            const artifact = (result as any)?.result?.artifact;
            const baseEnvelope = failure ? { ...result as object, ...(artifact ? { artifact } : {}), error: recoveryError(failure, definition.name) } : result;
            const skippedCapture = definition.name !== "inspect_page" && (NO_PAGE_CAPTURE.has(definition.name) || definition.name === "read_console" && value.mode === "retained");
            const skippedStatus = skippedCapture ? observationStatus(baseEnvelope as Record<string, unknown>) : undefined;
            const envelope = pagination || skippedStatus ? { ...baseEnvelope as object, ...presentation, ...(skippedStatus ? { pageSnapshotStatus: skippedStatus } : {}) } : baseEnvelope;
            if (definition.name === "inspect_page" && envelope && typeof envelope === "object"
              && Object.hasOwn(envelope, "observationId") && Object.hasOwn(envelope, "items"))
              inspectionDelivery = inspectionPageDelivery(result, identity?.toolCallId ?? toolCallId, value.cursor !== undefined);
            output = envelope;
          } catch (error) {
            output = await failureFor(error, executing);
          }
          // Capture before releasing the scheduler slot, so a later action in the
          // same model response cannot change the page first. Management calls
          // must never wait behind a still-running job occupying the browser queue.
          if (executing && !(definition.name === "read_console" && value.mode === "retained") && !NO_PAGE_CAPTURE.has(definition.name) && typeof executor.inspect === "function" && !abortSignal?.aborted) {
            const pending = executor.pendingBackgroundJobs?.() ?? [];
            const otherPending = pending.some((id) => id !== observedTerminalJob);
            let pageEvidence: Record<string, unknown>;
            if (resultPending || otherPending) {
              pageEvidence = { pageSnapshotStatus: { state: "pending", reason: "browser-job-unobserved-terminal" } };
            } else {
              try {
                const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
                // close_tab invalidates its argument; switch_tab changes the binding.
                const tabId = openedTabId ?? (definition.name !== "close_tab" && typeof value.tabId === "number" ? value.tabId : undefined);
                const context = { conversationId: options.conversationId, toolCallId, logIdentity: identity, runSignal: options.runSignal, visualEnabled: false };
                const pageSnapshot = await executor.inspect({ ...(recentRefs.length ? { recentRefs } : {}), ...(tabId === undefined ? {} : { tabId }),
                  wire: { maxBytes: INSPECTION_RESULT_BYTES, evidenceId: identity?.toolCallId ?? toolCallId } }, abortSignal, context);
                inspectionDelivery = inspectionPageDelivery(pageSnapshot, identity?.toolCallId ?? toolCallId, false);
                if (definition.name === "find_elements" && output && typeof output === "object" && Array.isArray((output as any).elements)) {
                  const associations = (pageSnapshot as any)[SNAPSHOT_CANDIDATE_CONTEXT] as Map<string, CandidateAssociation> | undefined;
                  output = { ...output, elements: (output as any).elements.map((element: any) => {
                    const association = associations?.get(element.id);
                    if (association?.invalid) {
                      const { id: _id, actionable: _actionable, ...rest } = element;
                      return { ...rest, status: "changed", context: association.context };
                    }
                    return { ...element, context: association?.context ?? { status: "unknown", observationId: (pageSnapshot as any).observationId, reason: "not-represented" } };
                  }) };
                }
                pageEvidence = { pageSnapshot };
              } catch (error) {
                pageEvidence = { pageSnapshotStatus: { state: "unavailable", error: toolFailure(error).error } };
              }
            }
            output = output && typeof output === "object" && !Array.isArray(output)
              ? { ...output, ...pageEvidence } : { result: output, ...pageEvidence };
          }
          if (inspectionDelivery) {
            try {
              abortSignal?.throwIfAborted();
              if (!inspectionDelivery.begin()) throw new Error("AutomationError[stale-observation]: Snapshot changed before delivery");
            } catch (error) {
              inspectionDelivery.cancel();
              inspectionDelivery = undefined;
              if (definition.name === "inspect_page") output = await failureFor(error, true);
              else {
                const { pageSnapshot: _pageSnapshot, ...rest } = output as Record<string, unknown>;
                output = { ...rest, ...(definition.name === "find_elements" && Array.isArray(rest.elements) ? {
                  elements: rest.elements.map((element: any) => {
                    const { id: _id, actionable: _actionable, context: _context, ...candidate } = element;
                    return { ...candidate, status: "identity-unknown" };
                  }),
                } : {}), pageSnapshotStatus: { state: "unavailable", error: toolFailure(error).error } };
              }
            }
          }
          let saved: unknown;
          try {
            if (definition.name === "find_elements" && output && typeof output === "object" && !(output as any).pageSnapshot && Array.isArray((output as any).elements))
              output = { ...output, elements: (output as any).elements.map((element: any) => {
                const { context: _context, ...rest } = element;
                return { ...rest, context: { status: "unknown", reason: "snapshot-unavailable" } };
              }) };
            saved = await finish(output);
            if (!abortSignal?.aborted) inspectionDelivery?.finish();
            else inspectionDelivery?.cancel();
          } catch (error) {
            inspectionDelivery?.cancel();
            throw error;
          }
          if (observedTerminalJob && options.logger && options.conversationId) executor.acknowledgeBackgroundJob(observedTerminalJob, options.conversationId);
          return saved;
        };
        try {
          return await deadline.wait(options.scheduler ? options.scheduler.run(toolCallId, work, abortSignal) : work());
        } catch (error) {
          if (entered && !abortSignal.aborted) throw error; // A canonical write failure must stop the run.
          if (entered) await executor.settleAbortedWork?.();
          return finish(await failureFor(error, entered));
        }
      } finally { deadline.dispose(); }
    },
  })]));
}

const LARGE_RESULT_BYTES = TOOL_RESULT_BYTES;
const INSPECTION_RESULT_BYTES = 16 * 1024;
const INSPECT_CURRENT_GUIDANCE = "Use inspect_page for current page state; previous observations may be stale.";
const PENDING_OBSERVATION_GUIDANCE = "Use get_job for handed-off work, then inspect_page for current page state.";
const FROZEN_OBSERVATION_STATUS = { state: "frozen", freshness: "frozen", guidance: "Use inspect_page without cursor for a new observation." };
const observationEncoder = new TextEncoder();
const INSPECTION_STATUS_BYTES = observationEncoder.encode(JSON.stringify({ pageSnapshotStatus: FROZEN_OBSERVATION_STATUS })).byteLength;

/** Describe this result's observation without consulting or asserting an old baseline. */
function pageObservationStatus(output: Record<string, unknown>, toolName: string, unobservedJob: boolean, interrupted: boolean): Record<string, unknown> | undefined {
  if (output.pageSnapshot && typeof output.pageSnapshot === "object") return undefined;
  if (toolName === "inspect_page" && typeof output.observationId === "string" && Array.isArray(output.items) && output.ok !== false)
    return output.continuation === true ? FROZEN_OBSERVATION_STATUS : { state: "captured", freshness: "at-capture" };
  const existing = output.pageSnapshotStatus;
  if (interrupted || output.ok === false)
    return { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
      state: "unavailable", reason: interrupted ? "tool-interrupted" : "tool-failed", freshness: "unknown", guidance: INSPECT_CURRENT_GUIDANCE };
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const status = existing as Record<string, unknown>;
    return { ...status, freshness: "unknown", guidance: status.state === "pending" ? PENDING_OBSERVATION_GUIDANCE : INSPECT_CURRENT_GUIDANCE };
  }
  return unobservedJob
    ? { state: "pending", reason: "browser-job-unobserved-terminal", freshness: "unknown", guidance: PENDING_OBSERVATION_GUIDANCE }
    : { state: "not-captured", reason: "tool-does-not-capture-page", freshness: "unknown", guidance: INSPECT_CURRENT_GUIDANCE };
}

function observationMetadata(record: Record<string, unknown> | undefined, artifactId: number, prefix: (string | number)[] = []): Record<string, unknown> {
  if (!record?.pageSnapshotStatus || typeof record.pageSnapshotStatus !== "object") return {};
  const status = record.pageSnapshotStatus as Record<string, unknown>;
  return { pageSnapshotStatus: { ...status, ...(Object.hasOwn(status, "error") ? { error: boundedError(status.error),
    errorAccess: { artifactId, path: [...prefix, "pageSnapshotStatus", "error"] } } : {}) } };
}
// Only the native, already-paginated inspection envelope gets the larger
// allowance. Unknown wrappers and additional fields retain artifact handling.
const inspectionInteger = z.number().int().nonnegative();
const snapshotBoundsSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const inspectionItemFields = {
  depth: inspectionInteger.optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  nameUnknown: z.literal(true).optional(),
  box: snapshotBoundsSchema.optional(),
  textBox: snapshotBoundsSchema.optional(),
  textParts: z.array(z.object({ text: z.string(), box: snapshotBoundsSchema.optional() }).strict()).optional(),
  coordinates: z.literal("frame-viewport").optional(),
  value: z.string().optional(),
  valueUnknown: z.literal(true).optional(),
  placeholder: z.string().optional(),
  selected: z.array(z.string()).optional(),
  frameRef: z.string().optional(),
  ownerUnrepresented: z.literal(true).optional(),
  actionable: z.literal(true).optional(),
  actions: z.array(z.string()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  count: inspectionInteger.optional(),
  boxes: z.array(z.union([
    z.object({ box: snapshotBoundsSchema }).strict(),
    z.object({ first: snapshotBoundsSchema, step: snapshotBoundsSchema, count: z.number().int().positive() }).strict(),
  ])).optional(),
  path: z.array(z.record(z.string(), z.unknown())).optional(),
  change: z.enum(["added", "updated", "removed", "moved"]).optional(),
  after: z.string().nullable().optional(),
  fragment: z.object({
    index: inspectionInteger, field: z.string().min(1), start: inspectionInteger, end: inspectionInteger, total: inspectionInteger,
  }).strict().optional(),
};
const contextAddressSchema = z.object({ itemId: z.string(), pathIndex: inspectionInteger.optional(), textPartIndex: inspectionInteger.optional() });
const observedContextSchema = z.object({
  status: z.enum(["unknown", "verified"]), observationId: z.string(), snapshotItemId: z.string().optional(), reason: z.string().optional(),
  container: contextAddressSchema.extend({ role: z.enum(["row", "listitem", "group"]) }).strict().optional(),
  visibleLabels: z.array(contextAddressSchema.extend({ text: z.string(), fragment: z.boolean(), source: z.enum(["StaticText", "textFragments"]) }).strict()).max(12).optional(),
  partial: z.boolean().optional(), unknownLabels: z.array(contextAddressSchema.strict()).max(12).optional(), labelsOmitted: z.literal(true).optional(),
}).strict();
const inspectionPageSchema = z.object({
  observationId: z.string(), tabId: inspectionInteger, documentId: inspectionInteger,
  url: z.string().optional(), title: z.string().optional(), continuation: z.literal(true).optional(),
  viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), scale: z.number() }).strict(),
  limitations: z.string().optional(),
  mode: z.enum(["full", "delta"]), baseObservationId: z.string().optional(), partial: z.literal(true).optional(), reset: z.enum(["previous-output-truncated", "previous-output-partial", "current-output-partial"]).optional(),
  items: z.array(z.object({ id: z.string(), ...inspectionItemFields }).strict()),
  lookahead: z.object({ nonAuthoritative: z.literal(true), items: z.array(z.object({
    index: inspectionInteger, id: z.string(), depth: inspectionInteger.optional(), role: z.string().optional(),
    name: z.string().optional(), value: z.string().optional(),
  }).strict()) }).strict().optional(),
  actionContexts: z.object({ targets: z.array(z.object({ targetId: z.string(), context: observedContextSchema }).strict()), omitted: inspectionInteger.optional() }).strict().optional(),
  nextCursor: z.string().optional(),
  truncation: z.object({ truncated: z.boolean(), total: inspectionInteger, returned: inspectionInteger,
    offset: inspectionInteger, charOffset: inspectionInteger, nextOffset: inspectionInteger, nextCharOffset: inspectionInteger,
    budget: inspectionInteger, used: inspectionInteger, withLookahead: inspectionInteger.optional(), reason: z.enum(["budget", "slice"]).optional(),
    baselineComplete: z.boolean(), requiredBudget: inspectionInteger.optional(),
  }).strict(),
}).strict().refine((page) => !page.actionContexts || new TextEncoder().encode(JSON.stringify(page.actionContexts)).byteLength <= 3072
  && new Set(page.actionContexts.targets.map(pair => pair.targetId)).size === page.actionContexts.targets.length
  && page.actionContexts.targets.every(pair => pair.context.observationId === page.observationId
    && page.items.some(item => item.id === pair.targetId && item.actionable && item.change !== "removed")))
  .refine((page) => !page.limitations || page.partial === true)
  .refine((page) => !page.partial || page.mode === "full" && !page.truncation.baselineComplete)
  .refine((page) => page.continuation === true
  ? page.url === undefined && page.title === undefined : typeof page.url === "string" && typeof page.title === "string")
  .refine((page) => page.truncation.returned === page.items.length).refine((page) => {
  if (!page.lookahead) return page.truncation.withLookahead === undefined;
  const size = new TextEncoder().encode(JSON.stringify({ items: page.items, lookahead: page.lookahead })).byteLength;
  return page.mode === "full" && page.truncation.truncated && Boolean(page.nextCursor)
    && page.lookahead.items.length > 0 && page.truncation.withLookahead === size && size <= page.truncation.budget
    && page.lookahead.items.every((item, index, all) => item.index > page.truncation.nextOffset
      && (index === 0 || item.index > all[index - 1]!.index)
      && (item.name?.length ?? 0) <= 512 && (item.value?.length ?? 0) <= 512);
});

/** Validate the complete inline snapshot and retain its internal delivery lease. */
function inspectionPageDelivery(value: unknown, evidenceId: string, continuation: boolean): SnapshotDeliveryLease {
  const parsed = inspectionPageSchema.safeParse(value);
  if (!parsed.success || (parsed.data.continuation === true) !== continuation)
    throw new Error("AutomationError[snapshot-delivery-invalid]: Invalid snapshot page cannot be delivered safely");
  const serialized = JSON.stringify({ ...value as Record<string, unknown>, evidenceId });
  if (new TextEncoder().encode(serialized).byteLength > INSPECTION_RESULT_BYTES)
    throw new Error("AutomationError[snapshot-envelope-too-large]: Snapshot page cannot be delivered inline within the response limit");
  const delivery = (value as { [SNAPSHOT_DELIVERY_COMMIT]?: unknown })[SNAPSHOT_DELIVERY_COMMIT];
  if (!delivery || typeof delivery !== "object" || !("begin" in delivery) || typeof delivery.begin !== "function"
    || !("finish" in delivery) || typeof delivery.finish !== "function" || !("cancel" in delivery) || typeof delivery.cancel !== "function")
    throw new Error("AutomationError[snapshot-delivery-invalid]: Snapshot delivery lease is missing");
  return delivery as SnapshotDeliveryLease;
}

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
/** Keep complete candidate/context pairs; generic previews truncate nested provenance. */
function candidateContextPreview(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(record.elements) || !record.elements.some(element => element?.context)) return undefined;
  const elements: unknown[] = [];
  let bytes = 2;
  for (const element of record.elements) {
    const size = previewEncoder.encode(JSON.stringify(element)).byteLength + 1;
    if (bytes + size > PREVIEW_BYTES) break;
    elements.push(element); bytes += size;
  }
  return { elements, ...(elements.length < record.elements.length ? { elementsTruncated: true } : {}) };
}

function searchMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["tabId", "documentId", "total"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) result[field] = record[field];
  if (typeof record.hasMore === "boolean") result.hasMore = record.hasMore;
  const cursor = exactText(record.nextCursor, 512); if (cursor !== undefined) result.nextCursor = cursor;
  return result;
}
function diagnosticPaginationPresentation(pagination: Record<string, unknown> | undefined, toolName?: string, input: Record<string, any> = {}): Record<string, unknown> {
  if (!pagination) return {};
  return { sourcePagination: pagination, sourcePaginationNote: SOURCE_PAGINATION_NOTE,
    ...(toolName && pagination.hasMore === true && (input.mode === "retained" ? typeof pagination.nextCursor === "string" : Number.isSafeInteger(pagination.nextOffset)) ? {
      sourceContinuation: { tool: toolName, input: input.mode === "retained"
        ? { mode: "retained", tabId: input.tabId, cursor: pagination.nextCursor, ...(input.limit === undefined ? {} : { limit: input.limit }) }
        : { ...input, offset: pagination.nextOffset } },
    } : {}),
    ...(input.mode === "retained" ? { scanNote: "An empty messages array only describes this scanned window. Continue sourceContinuation while hasMore=true, including empty windows; rangeComplete only finishes the fixed high-water range. Uncaptured history and overflow remain unknown." } : {}) };
}
function diagnosticPresentationMetadata(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const pagination = sourcePaginationOf(record?.sourcePagination);
  if (!pagination) return {};
  return { sourcePagination: pagination, sourcePaginationNote: SOURCE_PAGINATION_NOTE,
    ...(record?.sourceContinuation ? { sourceContinuation: record.sourceContinuation } : {}),
    ...(record?.scanNote ? { scanNote: record.scanNote } : {}) };
}
function retainedConsoleMetadata(record: Record<string, unknown> | undefined, artifactId: number, prefix: (string | number)[] = []): Record<string, unknown> {
  if (record?.mode !== "retained") return {};
  const { mode, tabId, captureStatus, integrity, overflow, reason, scope, scanned, hasMore, rangeComplete, nextCursor } = record;
  return { mode, tabId, captureStatus, integrity, overflow, reason, scope, scanned, hasMore, rangeComplete, nextCursor,
    messagesAccess: { artifactId, path: [...prefix, "messages"], offset: 0, limit: 100 },
    boundariesAccess: { artifactId, path: [...prefix, "boundaries"], offset: 0, limit: 100 },
    captureFailuresAccess: { artifactId, path: [...prefix, "captureFailures"], offset: 0, limit: 100 } };
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
function inspectionMetadata(record: Record<string, unknown>, artifactId: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (record.partial === true) result.partial = true;
  for (const field of ["observationId", "mode", "nextCursor", "reset"]) { const value = exactText(record[field], 512); if (value !== undefined) result[field] = value; }
  for (const field of ["tabId", "documentId"]) if (Number.isSafeInteger(record[field]) && Number(record[field]) >= 0) result[field] = record[field];
  if (Array.isArray(record.items)) result.cursorNote = "Read all items from this artifact before advancing nextCursor or reconstructing a baseline for since.";
  if (record.truncation && typeof record.truncation === "object" && !Array.isArray(record.truncation)) {
    const source = record.truncation as Record<string, unknown>; const truncation: Record<string, unknown> = {};
    for (const field of ["truncated", "baselineComplete"]) if (typeof source[field] === "boolean") truncation[field] = source[field];
    for (const field of ["total", "returned", "offset", "charOffset", "nextOffset", "nextCharOffset", "budget", "used", "withLookahead", "requiredBudget"]) if (Number.isSafeInteger(source[field]) && Number(source[field]) >= 0) truncation[field] = source[field];
    const reason = exactText(source.reason, 128); if (reason !== undefined) truncation.reason = reason;
    result.truncation = truncation;
  }
  const lookahead = record.lookahead;
  if (lookahead && typeof lookahead === "object" && !Array.isArray(lookahead)) {
    const preview = lookahead as Record<string, unknown>;
    if (preview.nonAuthoritative === true && Array.isArray(preview.items)) {
      const read = artifactAccess(artifactId, ["lookahead", "items"], preview.items);
      result.lookaheadNonAuthoritative = true;
      result.lookaheadCount = preview.items.length;
      result.lookaheadAccess = read.access;
      if (read.oversizedItem) result.lookaheadOversizedItem = read.oversizedItem;
    }
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
  if (typeof record.recovery === "string") result.recovery = excerpt(record.recovery, 512).value;
  return result;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, part) => current !== null && typeof current === "object" ? (current as any)[part] : undefined, value);
}

function isPageable(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) || value instanceof Map || value instanceof Set || isArrayBuffer(value) || ArrayBuffer.isView(value);
}

function pageValue(nativeValue: unknown, normalizedValue: unknown): unknown {
  return nativeValue instanceof Map || nativeValue instanceof Set || isArrayBuffer(nativeValue) || ArrayBuffer.isView(nativeValue)
    ? nativeValue : normalizedValue;
}

async function readablePathOf(value: unknown): Promise<Array<string | number> | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const path of [["result", "snapshot"], ["result", "actual"], ["result"], ["snapshot"], ["observation", "snapshot"], ["text"], ["html"]] as const) {
    const selected = valueAt(value, path);
    if (isPageable(selected)) return [...path];
    if (selected && typeof selected === "object") {
      const nested = await artifactReadSelection(selected, path);
      if (isPageable(nested.value)) return nested.path;
    }
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
    : inspection && Array.isArray(inspection.items) ? ["items"] : await readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const access = (selectedPath: readonly (string | number)[] | undefined, item: unknown) => ({ artifactId: event.id,
    ...(selectedPath ? { path: selectedPath } : {}), ...(nativePageLimit(item) !== undefined ? { offset: 0, limit: nativePageLimit(item) } : {}) });
  const failure = root?.ok === false || root?.type === "tool-error";
  const errorPath = root && Object.hasOwn(root, "error") ? ["error"] : ["result", "error"];
  const error = failure ? valueAt(value, errorPath) : undefined;
  return { $ref: event.id, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    access: access(path, selected), sidecarsDeferred: true, readNote: ARTIFACT_READ_NOTE,
    pathsNote: "Read a bounded slice with read_artifact; its type sidecars are relative to that slice. For oversized items, select a nested path. Shared or cyclic object identity is not exposed.",
    ...(root && Object.hasOwn(root, "result") ? { resultAccess: access(["result"], root.result) } : {}),
    ...(job ? jobMetadata(job) : {}), ...(search ? { ...searchMetadata(search), ...candidateContextPreview(search) } : {}),
    ...(inspection ? inspectionMetadata(inspection, event.id) : {}), ...(browserEvents ? eventMetadata(browserEvents) : {}),
    ...retainedConsoleMetadata(root, event.id),
    ...observationMetadata(root, event.id),
    ...(options.preserveDiagnosticStatus ? diagnosticPresentationMetadata(root) : {}),
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
    guidance: "The first item exceeds the recommended byte budget. Use read_artifact with a nested path and offset and limit to read its fields or bounded substrings.",
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

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string; runId?: string; toolCallIdCanonical?: boolean; reservedBytes?: number; preserveVerification?: boolean; preserveJobStatus?: boolean; preserveSearchStatus?: boolean; preserveInspectionStatus?: boolean; preserveDiagnosticStatus?: boolean; preserveEventStatus?: boolean; preserveArtifactValue?: boolean; originalResult?: unknown }): Promise<unknown> {
  if ((value && typeof value === "object" && "$ref" in value) || !options.logger) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (serialized === undefined) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const reservedBytes = options.reservedBytes ?? (options.toolCallId ? previewEncoder.encode(JSON.stringify({ evidenceId: options.toolCallId })).byteLength : 0);
  if (bytes + reservedBytes <= LARGE_RESULT_BYTES) return value;
  if (options.preserveInspectionStatus && bytes <= INSPECTION_RESULT_BYTES && inspectionPageSchema.safeParse(value).success
    && previewEncoder.encode(JSON.stringify({ ...value as Record<string, unknown>, evidenceId: options.toolCallId ?? "" })).byteLength <= INSPECTION_RESULT_BYTES) return value;
  const storedValue = Object.hasOwn(options, "originalResult") && value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, result: options.originalResult } : value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, runId: options.runId, toolCallIdCanonical: options.toolCallIdCanonical, content: { bytes }, output: storedValue });
  if (!event) throw new Error("Could not save large tool result");
  const root = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const job = options.preserveJobStatus ? root : undefined;
  const search = options.preserveSearchStatus ? root : undefined;
  const candidatePreview = search ? candidateContextPreview(search) : undefined;
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
    : inspection && Array.isArray(inspection.items) ? [...prefix, "items"] : await readablePathOf(value);
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
  return { $ref: event.id, bytes, readNote: ARTIFACT_READ_NOTE, preview: candidatePreview ? undefined : job ? { eventCount: Array.isArray(job.events) ? job.events.length : 0 } : handoff || visual && typeof selected !== "string" ? undefined : previewOf(value, path), access, ...(oversizedItem ? { oversizedItem } : {}), type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    ...(root?.envelopeWrapped === true ? { envelopeWrapped: true } : {}),
    ...(job ? jobMetadata(job) : {}),
    ...(search ? searchMetadata(search) : {}),
    ...candidatePreview,
    ...(inspection ? inspectionMetadata(inspection, event.id) : {}),
    ...(browserEvents ? eventMetadata(browserEvents) : {}),
    ...retainedConsoleMetadata(original, event.id, prefix),
    ...observationMetadata(original, event.id, prefix),
    ...(options.preserveDiagnosticStatus ? diagnosticPresentationMetadata(original) : {}),
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

const READ_ONLY_TOOLS = new Set([
  "inspect_page", "find_elements", "list_frames", "read_text", "read_value", "read_attribute", "read_checked", "read_elements", "count_elements", "get_page_info", "verify_state", "wait_for_url", "list_tabs", "list_downloads", "read_artifact", "list_requests", "read_response", "read_console", "list_scripts", "read_script", "list_jobs", "wait_event", "list_file_choosers",
]);

function recoveryError<T extends Record<string, any>>(error: T, toolName: string): T & { recovery?: string } {
  if (error.code === "stale-ref" || error.code === "ref-unavailable") error = { ...error,
    code: error.code === "stale-ref" ? "stale-id" : "id-unavailable",
    ...(typeof error.message === "string" ? { message: error.message.replace(/stale-ref/g, "stale-id").replace(/ref-unavailable/g, "id-unavailable").replace(/"ref":/g, '"id":') } : {}) };
  if (error.effectUnknown === true) return { ...error, retryable: false, recovery: "Effect unknown. Inspect the current state and verify the outcome before deciding whether to act again." };
  if (toolName === "read_console" && ["invalid-tab-id", "bound-tab-closed", "tab-closed", "window-closed", "target-closed"].includes(error.code))
    return { ...error, retryable: false, recovery: "For previously captured console history, use read_console with mode=retained and the original tabId. It reads only this conversation/run's canonical captures without reopening the page; missing capture remains unknown. Continue every returned cursor while hasMore=true." };
  if (["window-closed", "bound-tab-closed", "no-bound-tab"].includes(error.code))
    return { ...error, retryable: false, recovery: "Use list_tabs to find an available tab, then switch_tab to select it before continuing." };
  if (toolName === "inspect_page" && error.code === "not-found" && error.recovery)
    return { ...error, retryable: false };
  if (["not-found", "strict-mode", "frame-not-found"].includes(error.code))
    return { ...error, retryable: false, recovery: "Use list_frames and specify the target frame, or inspect_page/find_elements and use a unique observed element ID." };
  if (typeof error.code === "string" && /stale|expired|detached|identity-unknown/.test(error.code))
    return { ...error, retryable: false, recovery: "Observe the current state and locate the target again before continuing." };
  if (error.code === "timeout" && READ_ONLY_TOOLS.has(toolName))
    return { ...error, retryable: true, recovery: "This read can be retried with the same parameters; adjust the timeout if needed." };
  if (!READ_ONLY_TOOLS.has(toolName)) return { ...error, retryable: false,
    recovery: "Inspect the current state before repeating this action. Use the observed outcome to choose a safe recovery path." };
  return error;
}

function toolFailure(error: unknown): { ok: false; error: { code: string; message: string; retryable?: boolean; effectUnknown?: boolean; recovery?: string }; artifact?: unknown } {
  const message = safeDiagnosticText(error instanceof Error || error instanceof DOMException ? error.message : String(error));
  const restrictedPage = /^Cannot access a chrome:\/\/ URL$/i.test(message);
  const code = error instanceof DOMException && error.name === "AbortError" ? "aborted"
    : error instanceof DOMException && error.name === "TimeoutError" ? "timeout"
    : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
    : restrictedPage ? "restricted-page" : /(?:Command|Automation)Error\[([^\]]+)\]/.exec(message)?.[1] ?? "tool-error";
  const effectUnknown = error && typeof error === "object" && "effectUnknown" in error && typeof error.effectUnknown === "boolean" ? error.effectUnknown : undefined;
  return { ok: false, error: { code, message: restrictedPage ? "Chrome 不允许扩展访问此浏览器内部页面。请切换到普通网页后重试。" : message, ...(restrictedPage ? { retryable: false } : {}), ...(effectUnknown === undefined ? {} : { effectUnknown }) }, ...(error && typeof error === "object" && "artifact" in error ? { artifact: error.artifact } : {}) };
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

type ScreenshotSource = { mediaType: string; data?: string; artifactId?: number; artifactPath?: Array<string | number> };

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
      if (Number.isSafeInteger(screenshot.artifactId) && Number(screenshot.artifactId) > 0) found.push({ mediaType: typeof screenshot.mediaType === "string" ? screenshot.mediaType : "image/png", artifactId: Number(screenshot.artifactId),
        ...(Array.isArray(screenshot.artifactPath) && screenshot.artifactPath.length <= 20 && screenshot.artifactPath.every((part) => typeof part === "string" || Number.isSafeInteger(part) && part >= 0) ? { artifactPath: screenshot.artifactPath } : {}) });
    }
    return [key, scrubScreenshots(item, found)];
  }));
}

export async function prepareToolMessages(messages: any[], stepNumber: number, browserContext?: string, readArtifact?: (id: number, selection?: { path: Array<string | number> }) => Promise<unknown>, injectImages = true): Promise<any[]> {
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
  const stored = source?.artifactId !== undefined && readArtifact ? await (source.artifactPath ? readArtifact(source.artifactId, { path: source.artifactPath }) : readArtifact(source.artifactId)) as { base64?: unknown; data?: unknown; mimeType?: unknown; mediaType?: unknown } : undefined;
  const storedData = source?.artifactPath ? stored?.data : stored?.base64;
  const screenshot = source && (source.data || typeof storedData === "string") ? {
    mediaType: typeof stored?.mimeType === "string" ? stored.mimeType : typeof stored?.mediaType === "string" ? stored.mediaType : source.mediaType,
    data: source.data ?? storedData as string,
  } : undefined;
  const content = [
    ...(browserContext ? [{ type: "text", text: browserContext }] : []),
    ...(screenshot ? [{ type: "file", mediaType: screenshot.mediaType, data: { type: "data", data: screenshot.data } }] : []),
  ];
  return content.length ? [...prepared, { role: "user", content }] : prepared;
}
