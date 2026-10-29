/** A model response reserves call slots before the SDK starts executing them concurrently. */
export type ScheduledToolCall = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  invalid?: boolean;
  providerExecuted?: boolean;
};

type DialogFence = { failed: boolean; failedSignal: Promise<void>; fail: () => void };

type Slot = {
  call: ScheduledToolCall;
  previous: Promise<void>;
  release: () => void;
  invoked: boolean;
  settled: boolean;
  dialogFence?: DialogFence;
  dialogDependencies: readonly DialogFence[];
};

type Batch = {
  slots: Map<string, Slot>;
  bypassIds: Set<string>;
  fatal?: Error;
  boundTabId?: number;
  bindingFailed: boolean;
  backgroundJobId?: string;
  failed: Set<string>;
  allFailed: boolean;
  abort?: () => void;
  signal?: AbortSignal;
};

const bypass = new Set(["list_jobs", "get_job", "cancel_job", "read_api_reference", "wait_event", "unsubscribe_event"]);
const reads = new Set([
  "inspect_page", "find_elements", "list_frames", "read_text", "read_table", "read_value", "read_attribute", "read_checked", "verify_state", "wait_for_url", "take_screenshot",
  "list_tabs", "list_downloads", "read_download", "read_artifact", "read_events", "list_requests", "read_response", "read_console", "list_scripts", "read_script", "list_cdp_sessions", "subscribe_event",
]);
// Releasing held input must stay possible after an earlier action failed.
const cleanup = new Set(["key_up", "release_pointer"]);

function inputOf(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return {}; }
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function resource(call: ScheduledToolCall, batch: Batch): string {
  const name = call.toolName ?? "";
  const input = inputOf(call.input);
  if (name === "execute_program") return "*";
  if (name === "list_tabs" || name === "open_tab") return "browser";
  if (name.endsWith("_script") || name === "list_scripts") {
    const definition = inputOf(input.definition);
    return `script:${String(input.scriptId ?? definition.id ?? "*")}`;
  }
  if (["read_artifact", "create_text_artifact", "save_artifact"].includes(name)) return `artifact:${String(input.artifactId ?? "*")}`;
  if (name === "fetch" && input.context === "extension") return "extension";
  const explicit = typeof input.tabId === "number" ? input.tabId : undefined;
  return `tab:${String(explicit ?? batch.boundTabId ?? "unbound")}`;
}

function failed(batch: Batch, call: ScheduledToolCall): void {
  const key = resource(call, batch);
  if (key === "*") batch.allFailed = true;
  else batch.failed.add(key);
  if (call.toolName === "switch_tab") batch.bindingFailed = true;
}

function blocked(batch: Batch, call: ScheduledToolCall): boolean {
  if (reads.has(call.toolName ?? "") || cleanup.has(call.toolName ?? "")) return false;
  const input = inputOf(call.input);
  const usesBinding = input.tabId === undefined && resource(call, batch).startsWith("tab:");
  return batch.allFailed || batch.failed.has(resource(call, batch)) || (usesBinding && batch.bindingFailed);
}

function completed(batch: Batch, call: ScheduledToolCall): void {
  const input = inputOf(call.input);
  if (call.toolName === "switch_tab" && typeof input.tabId === "number") {
    batch.boundTabId = input.tabId;
    batch.bindingFailed = false;
  } else if (call.toolName === "close_tab" && input.tabId === batch.boundTabId) {
    batch.boundTabId = undefined;
  }
}

function finish(slot: Slot): void {
  if (slot.settled) return;
  slot.settled = true;
  slot.release();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(String(signal.reason ?? "Operation aborted"), "AbortError");
}

async function waitFor<T>(previous: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return previous;
  signal.throwIfAborted();
  let listener!: () => void;
  try {
    const result = await Promise.race([previous, new Promise<never>((_resolve, reject) => {
      listener = () => reject(abortError(signal));
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    })]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

/** Call once for each complete model response, before starting tool execution. */
export class ToolScheduler {
  private batch?: Batch;
  private readonly names: Set<string>;

  constructor(registeredNames: Iterable<string>, private readonly pendingBackgroundJobs: () => readonly string[] = () => []) {
    this.names = new Set(registeredNames);
  }

  private pendingJob(): string | undefined {
    const ids = this.pendingBackgroundJobs();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) throw new Error("Unable to determine pending background jobs");
    return ids[0];
  }

  prepare(content: readonly ScheduledToolCall[], boundTabId?: number, signal?: AbortSignal): Error | undefined {
    if (this.batch?.abort && this.batch.signal) this.batch.signal.removeEventListener("abort", this.batch.abort);
    const batch: Batch = { slots: new Map(), bypassIds: new Set(), boundTabId, bindingFailed: false, failed: new Set(), allFailed: false, signal };
    this.batch = batch;
    // The model has not seen the current response's tool results yet: even if a
    // get_job in this response reads a terminal status, later preplanned browser
    // calls must wait until the next response to act on that knowledge.
    try { batch.backgroundJobId = this.pendingJob(); }
    catch (error) {
      batch.fatal = Object.assign(new Error("Unable to determine pending background jobs", { cause: error }), { code: "background-job-state-unavailable" });
      return batch.fatal;
    }
    const calls = content.filter((part) => part.type === "tool-call");
    const ids = new Set<string>();
    for (const call of calls) {
      if (typeof call.toolCallId !== "string" || !call.toolCallId.trim() || ids.has(call.toolCallId)) {
        batch.fatal = Object.assign(new Error("Missing or duplicate tool call ID; no calls from this response can be safely executed"), { code: "invalid-tool-call-id" });
        return batch.fatal;
      }
      ids.add(call.toolCallId);
    }
    let tail = Promise.resolve();
    let dialogTail = Promise.resolve();
    const dialogDependencies: DialogFence[] = [];
    for (const call of calls) {
      if (call.providerExecuted) continue;
      if (bypass.has(call.toolName ?? "") && !call.invalid && call.toolName && this.names.has(call.toolName)) {
        batch.bypassIds.add(call.toolCallId!);
        continue;
      }
      let release!: () => void;
      const done = new Promise<void>((resolve) => { release = resolve; });
      const isDialog = call.toolName === "handle_dialog";
      let dialogFence: DialogFence | undefined;
      if (isDialog) {
        let notifyFailure!: () => void;
        const failedSignal = new Promise<void>((resolve) => { notifyFailure = resolve; });
        dialogFence = { failed: false, failedSignal, fail() { if (!this.failed) { this.failed = true; notifyFailure(); } } };
      }
      const slot: Slot = { call, previous: isDialog ? dialogTail : tail, release, invoked: false, settled: false,
        dialogDependencies: isDialog ? [] : [...dialogDependencies], ...(dialogFence ? { dialogFence } : {}) };
      if (dialogFence) {
        // Dialog handling must run even while the prior browser call is waiting
        // for that dialog. Later browser calls must observe both completions.
        dialogTail = done;
        tail = Promise.all([tail, done]).then(() => undefined);
        dialogDependencies.push(dialogFence);
      } else tail = done;
      if (call.invalid || !call.toolName || !this.names.has(call.toolName)) {
        // SDK does not call invalid tools. Advance without waiting for a callback,
        // while retaining the failure boundary at its exact position.
        void slot.previous.then(() => { if (slot.dialogFence) slot.dialogFence.fail(); else failed(batch, call); finish(slot); });
      } else batch.slots.set(call.toolCallId!, slot);
    }
    if (signal) {
      batch.abort = () => {
        for (const slot of batch.slots.values()) if (!slot.invoked && !slot.settled) {
          slot.invoked = true;
          void slot.previous.then(() => { if (slot.dialogFence) slot.dialogFence.fail(); else failed(batch, slot.call); finish(slot); });
        }
      };
      signal.addEventListener("abort", batch.abort, { once: true });
      if (signal.aborted) batch.abort();
    }
    return undefined;
  }

  async run<T>(toolCallId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const batch = this.batch;
    if (!batch) throw Object.assign(new Error("Tool response was not registered"), { code: "unregistered-tool-response" });
    if (batch.fatal) throw batch.fatal;
    const activeSignal = signal ?? batch.signal;
    const slot = batch.slots.get(toolCallId);
    // Nonblocking management operations are intentionally not on the browser queue.
    if (!slot) {
      if (batch.bypassIds.delete(toolCallId)) { activeSignal?.throwIfAborted(); return task(); }
      throw Object.assign(new Error("Tool call was not registered or was already consumed"), { code: "unregistered-tool-call" });
    }
    if (slot.invoked) {
      if (activeSignal?.aborted) throw abortError(activeSignal);
      throw Object.assign(new Error("Tool call was already consumed"), { code: "duplicate-tool-execution" });
    }
    slot.invoked = true;
    try {
      const precedingDialogFailed = await waitFor(Promise.race([
        slot.previous.then(() => false),
        ...slot.dialogDependencies.map((fence) => fence.failedSignal.then(() => true)),
      ]), activeSignal);
      if (precedingDialogFailed || slot.dialogDependencies.some((fence) => fence.failed)) {
        throw Object.assign(new Error("A prior dialog response failed; this call was not dispatched"), { code: "dialog-response-failed" });
      }
    } catch (error) {
      if (slot.dialogFence) slot.dialogFence.fail();
      void slot.previous.then(() => { if (!slot.dialogFence) failed(batch, slot.call); finish(slot); });
      throw error;
    }
    try {
      const pendingJob = slot.dialogFence ? undefined : batch.backgroundJobId ?? this.pendingJob();
      if (pendingJob) throw Object.assign(new Error(`A background job may still occupy the browser queue (${pendingJob}); inspect its status or handle its events before dispatching more browser work`), { code: "background-job-pending" });
      if (!slot.dialogFence && blocked(batch, slot.call)) throw Object.assign(new Error("A previous action on this resource failed; this action was not dispatched"), { code: "prior-action-failed" });
      const result = await task();
      const verification = slot.call.toolName === "verify_state" && result && typeof result === "object"
        ? "result" in result ? result.result : "verification" in result ? result.verification : undefined : undefined;
      const unsuccessful = result && typeof result === "object" && "ok" in result && result.ok === false
        || verification && typeof verification === "object" && "verified" in verification && verification.verified === false;
      if (unsuccessful) {
        if (slot.dialogFence) slot.dialogFence.fail(); else failed(batch, slot.call);
      } else {
        if (result && typeof result === "object" && "accepted" in result && result.accepted === true
          && "complete" in result && result.complete === false && "jobId" in result && typeof result.jobId === "string") batch.backgroundJobId = result.jobId;
        completed(batch, slot.call);
      }
      return result;
    } catch (error) {
      if (slot.dialogFence) slot.dialogFence.fail(); else failed(batch, slot.call);
      throw error;
    } finally {
      finish(slot);
    }
  }
}
