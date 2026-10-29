import { fromLogValue, type EventLogger } from "../logging";

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
export type NetworkRecord = {
  index: number; requestRef: string; requestId: string; debuggee: Debuggee; method: string; url: string;
  requestHeaders: Record<string, string>; requestBody?: string; frameId?: string;
  loaderId?: string; superseded?: boolean;
  status?: number; statusText?: string; responseHeaders?: Record<string, string>; failed?: string; resourceType?: string;
};
export type ConsoleRecord = { index: number; level: string; text: string; timestamp?: number };
type PendingHeaders = { request?: Record<string, string>; response?: Record<string, string> };
type RequestList = { requests: Array<Record<string, unknown>>; integrity: "complete" | "incomplete"; hasMore: boolean | null; nextOffset?: number; reason?: string };
type CachedPage = { value: RequestList; logEpoch?: string; conversationId?: string; revision: number };
type State = { epoch: string; revision: number; nextRequest: number; nextConsole: number; network: NetworkRecord[]; console: ConsoleRecord[]; pendingHeaders: Map<string, PendingHeaders>;
  historical: Map<string, NetworkRecord>; pages: Map<string, CachedPage>; latest: Map<string, number>; invalidations: Map<string, number>; invalidBefore: number;
  replayComplete?: boolean; replayEpoch?: string };
const CACHE_LIMIT = 1000;
const HISTORY_CACHE_LIMIT = 128;
const PAGE_CACHE_LIMIT = 16;
const IDENTITY_LIMIT = 16_384;
const INVALIDATION_LIMIT = 4096;
const requestRef = (epoch: string, index: number) => `request:${epoch}:${index}`;
const sourceKey = (sessionId: string | undefined, requestId: string) => JSON.stringify([sessionId ?? null, requestId]);
function staleRequest(): Error {
  return Object.assign(new Error("Request reference is unavailable or belongs to an expired capture"), { code: "stale-request" });
}
function latestRequest(records: readonly NetworkRecord[], requestId: string, source: Debuggee): NetworkRecord | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const item = records[index]!;
    if (item.requestId === requestId && item.debuggee.sessionId === source.sessionId) return item;
  }
  return undefined;
}
async function waitFor<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    const value = await Promise.race([task, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException(String(signal.reason ?? "Operation aborted"), "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
    signal.throwIfAborted();
    return value;
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Disposable diagnostic caches. Raw CDP telemetry is best effort; history replay reports gaps explicitly. */
export class BrowserDiagnostics {
  private readonly tabs = new Map<number, State>();
  private readonly restorations = new WeakMap<State, { revision: number; conversationId: string; task: Promise<State> }>();
  private context: { conversationId?: string; toolCallId?: string; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } } = {};
  constructor(private readonly logger?: EventLogger) {}
  bind(context: typeof this.context): void {
    const oldRun = this.context.logIdentity?.runId, nextRun = context.logIdentity?.runId;
    if (this.context.conversationId !== undefined && this.context.conversationId !== context.conversationId
      || oldRun !== undefined && nextRun !== undefined && oldRun !== nextRun) this.tabs.clear();
    this.context = context;
  }
  private state(tabId: number): State {
    let state = this.tabs.get(tabId);
    if (!state) { state = { epoch: crypto.randomUUID(), revision: 0, nextRequest: 0, nextConsole: 0, network: [], console: [], pendingHeaders: new Map(), historical: new Map(), pages: new Map(), latest: new Map(), invalidations: new Map(), invalidBefore: 0 }; this.tabs.set(tabId, state); }
    return state;
  }
  remove(tabId: number): void { this.tabs.delete(tabId); }
  clear(): void { this.tabs.clear(); this.context = {}; }
  reset(tabId: number): void { this.tabs.delete(tabId); this.state(tabId); }
  handle(source: Debuggee, method: string, params: any): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Page.frameNavigated" && !source.sessionId && !params?.frame?.parentId) this.reset(tabId);
    const lifecycle = (method === "Page.frameNavigated" && (source.sessionId || params?.frame?.parentId))
      || method === "Page.frameDetached" || method === "Target.detachedFromTarget";
    if (!lifecycle && !method.startsWith("Network.") && method !== "Runtime.consoleAPICalled" && method !== "Log.entryAdded") return;
    const state = this.state(tabId);
    const existing = latestRequest(state.network, params.requestId, source);
    const index = method === "Network.requestWillBeSent" ? ++state.nextRequest
      : method === "Runtime.consoleAPICalled" || method === "Log.entryAdded" ? ++state.nextConsole : existing?.index;
    if (method === "Network.requestWillBeSent" && typeof params?.requestId === "string") {
      const identity = sourceKey(source.sessionId, params.requestId);
      state.latest.delete(identity); state.latest.set(identity, index!);
      while (state.latest.size > IDENTITY_LIMIT) state.latest.delete(state.latest.keys().next().value!);
    }
    const invalidation = method === "Page.frameNavigated" && typeof params?.frame?.id === "string" ? `frame:${params.frame.id}`
      : method === "Page.frameDetached" && typeof params?.frameId === "string" ? `frame:${params.frameId}`
      : method === "Target.detachedFromTarget" && typeof params?.sessionId === "string" ? `session:${params.sessionId}` : undefined;
    if (invalidation) {
      state.invalidations.delete(invalidation); state.invalidations.set(invalidation, state.nextRequest);
      while (state.invalidations.size > INVALIDATION_LIMIT) {
        const oldest = state.invalidations.keys().next().value!;
        state.invalidBefore = Math.max(state.invalidBefore, state.invalidations.get(oldest)!);
        state.invalidations.delete(oldest);
      }
    }
    state.revision += 1;
    state.pages.clear();
    // Cold references are reusable across unrelated traffic; invalidate only
    // entries whose request, frame, or debugger session may have changed.
    for (const [ref, record] of state.historical) {
      if ((params?.requestId === record.requestId && source.sessionId === record.debuggee.sessionId)
        || (method === "Page.frameNavigated" && params?.frame?.id === record.frameId)
        || (method === "Page.frameDetached" && params?.frameId === record.frameId)
        || (method === "Target.detachedFromTarget" && params?.sessionId === record.debuggee.sessionId)) state.historical.delete(ref);
    }
    this.logger?.record({ type: "browser.diagnostic", ...this.context, ...this.context.logIdentity, content: { tabId, source, method, epoch: state.epoch, revision: state.revision, index }, output: params });
    this.apply(state, source, method, params, index);
    if (state.network.length > CACHE_LIMIT) state.network.splice(0, state.network.length - CACHE_LIMIT);
    if (state.console.length > CACHE_LIMIT) state.console.splice(0, state.console.length - CACHE_LIMIT);
  }
  private apply(state: State, source: Debuggee, method: string, params: any, index?: number): void {
    if (method === "console.clear") { state.console = []; return; }
    if (method === "Page.frameNavigated" || method === "Page.frameDetached") {
      const frameId = method === "Page.frameNavigated" ? params?.frame?.id : params?.frameId;
      if (typeof frameId === "string") for (const record of state.network) if (record.frameId === frameId) record.superseded = true;
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params?.sessionId === "string") for (const record of state.network) if (record.debuggee.sessionId === params.sessionId) record.superseded = true;
      return;
    }
    const key = JSON.stringify([source.sessionId, params?.requestId]);
    const existing = latestRequest(state.network, params.requestId, source);
    if (method === "Network.requestWillBeSent") {
      // CDP deliberately reuses requestId across redirects. Each request event
      // needs its own identity: an earlier hop must never read the later body.
      if (existing) existing.superseded = true;
      const record: NetworkRecord = { index: index!, requestRef: requestRef(state.epoch, index!), requestId: params.requestId, debuggee: { ...source }, method: params.request.method, url: params.request.url, requestHeaders: {} };
      Object.assign(record, { method: params.request.method, url: params.request.url, requestHeaders: params.request.headers ?? {}, requestBody: params.request.postData, resourceType: params.type, frameId: params.frameId, loaderId: params.loaderId, responseHeaders: undefined });
      const headers = state.pendingHeaders.get(key);
      if (headers?.request) record.requestHeaders = headers.request;
      if (headers?.response) record.responseHeaders = headers.response;
      state.pendingHeaders.delete(key);
      state.network.push(record);
    } else if (method === "Network.responseReceived" && existing) {
      if (existing.loaderId && params.loaderId && existing.loaderId !== params.loaderId) return;
      Object.assign(existing, { status: params.response.status, statusText: params.response.statusText, responseHeaders: existing.responseHeaders ?? params.response.headers ?? {}, resourceType: params.type ?? existing.resourceType });
    } else if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
      const response = method === "Network.responseReceivedExtraInfo";
      if (existing) { if (response) existing.responseHeaders = params.headers; else existing.requestHeaders = params.headers; }
      else {
        const pending = state.pendingHeaders.get(key) ?? {};
        if (response) pending.response = params.headers; else pending.request = params.headers;
        state.pendingHeaders.set(key, pending);
        if (state.pendingHeaders.size > CACHE_LIMIT) state.pendingHeaders.delete(state.pendingHeaders.keys().next().value!);
      }
    }
    else if (method === "Network.loadingFailed" && existing) existing.failed = params.errorText;
    else if (method === "Runtime.consoleAPICalled") state.console.push({ index: index!, level: params.type, text: (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? arg.type).join(" "), timestamp: params.timestamp });
    else if (method === "Log.entryAdded") state.console.push({ index: index!, level: params.entry.level, text: params.entry.text, timestamp: params.entry.timestamp });
  }
  private async restored(tabId: number, signal?: AbortSignal): Promise<State> {
    while (true) {
      signal?.throwIfAborted();
      const current = this.state(tabId);
      const conversationId = this.context.conversationId;
      if (!this.logger || !conversationId) return { ...current, replayComplete: false };
      const revision = current.revision;
      let flight = this.restorations.get(current);
      if (!flight || flight.revision !== revision || flight.conversationId !== conversationId) {
        const task = (async () => {
          const restored: State = { ...current, network: [], console: [], pendingHeaders: new Map(), historical: new Map(), pages: new Map(), replayComplete: true };
          const snapshot = await this.logger!.diagnosticEventsSnapshot(conversationId);
          restored.replayEpoch = snapshot.epoch;
          let expectedRevision = 1;
          for (const event of snapshot.value) {
            const content = fromLogValue(event.content) as { tabId?: number; source: Debuggee; method: string; epoch?: string; index?: number; revision?: number };
            if (content.tabId !== tabId || content.epoch !== current.epoch) continue;
            if (!Number.isSafeInteger(content.revision) || content.revision! !== expectedRevision) restored.replayComplete = false;
            if (!Number.isSafeInteger(content.revision) || content.revision! < expectedRevision) continue;
            expectedRevision = content.revision! + 1;
            this.apply(restored, content.source, content.method, fromLogValue(event.output), content.index);
          }
          if (expectedRevision !== revision + 1) restored.replayComplete = false;
          return restored;
        })();
        flight = { revision, conversationId, task };
        this.restorations.set(current, flight);
        void task.finally(() => { if (this.restorations.get(current)?.task === task) this.restorations.delete(current); }).catch(() => undefined);
      }
      const result = await waitFor(flight.task, signal);
      // A redirect, detach or navigation can arrive while the log read is in
      // flight. Retry against the newer epoch/revision instead of serving it.
      if (this.tabs.get(tabId) === current && current.revision === revision && this.context.conversationId === conversationId) return result;
    }
  }
  async requests(tabId: number, input: { static?: boolean; filter?: string; clear?: boolean; offset?: number; limit?: number }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (input.clear) { this.reset(tabId); return { cleared: true }; }
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Request list offset must be nonnegative and limit must be between 1 and 100");
    const matcher = input.filter ? new RegExp(input.filter) : undefined;
    while (true) {
      signal?.throwIfAborted();
      const state = this.state(tabId), revision = state.revision, conversationId = this.context.conversationId;
      const key = JSON.stringify(["requests", input.static ?? false, input.filter ?? null, offset, limit]);
      const cached = state.pages.get(key);
      if (cached && cached.revision === revision && cached.conversationId === conversationId) {
        try {
          const valid = cached.logEpoch === undefined || this.logger && await waitFor(this.logger.canonicalEpoch(), signal) === cached.logEpoch;
          if (this.tabs.get(tabId) !== state || state.revision !== revision || this.context.conversationId !== conversationId) continue;
          if (valid) return structuredClone(cached.value);
          state.pages.delete(key);
        } catch (error) { if (signal?.aborted) throw error; state.pages.delete(key); }
      }
      let records = state.network, integrity: RequestList["integrity"] = "complete", reason: string | undefined, logEpoch: string | undefined;
      if (state.nextRequest > CACHE_LIMIT) {
        try {
          const replay = await this.restored(tabId, signal);
          if (this.tabs.get(tabId) !== state || state.revision !== revision || this.context.conversationId !== conversationId) continue;
          logEpoch = replay.replayEpoch;
          integrity = replay.replayComplete === true ? "complete" : "incomplete";
          if (integrity === "incomplete") reason = "diagnostic-log-incomplete";
          // Replay can miss best-effort telemetry. Retain every still-live
          // record and report incomplete rather than silently dropping it.
          const merged = new Map(replay.network.map((record) => [record.index, record]));
          for (const record of state.network) merged.set(record.index, record);
          records = [...merged.values()].sort((a, b) => a.index - b.index);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (this.tabs.get(tabId) !== state || state.revision !== revision || this.context.conversationId !== conversationId) continue;
          integrity = "incomplete"; reason = "diagnostic-log-unavailable";
        }
      }
      const filtered = records.filter((record) => {
        const isStatic = ["Image", "Font", "Stylesheet", "Script", "Media"].includes(record.resourceType ?? "") && !record.failed && (record.status ?? 0) < 400;
        return (input.static || !isStatic) && (!matcher || matcher.test(record.url));
      });
      const selected = filtered.slice(offset, offset + limit);
      const requests = selected.map(({ requestRef, method, url, status, failed, statusText, superseded }) => ({ requestRef, method, url, status: failed ? "FAILED" : status, statusText: failed ?? statusText, ...(superseded ? { superseded: true } : {}) }));
      const hasKnownMore = filtered.length > offset + limit;
      const result: RequestList = { requests, integrity, hasMore: hasKnownMore ? true : integrity === "complete" ? false : null,
        ...(hasKnownMore ? { nextOffset: offset + limit } : {}), ...(reason ? { reason } : {}) };
      // Cached history must remain tied to the canonical log epoch, including
      // a clear by another logger instance. In-memory-only pages need no disk.
      if (state.nextRequest <= CACHE_LIMIT || logEpoch !== undefined) {
        state.pages.set(key, { value: structuredClone(result), logEpoch, conversationId, revision });
        while (state.pages.size > PAGE_CACHE_LIMIT) state.pages.delete(state.pages.keys().next().value!);
      }
      return result;
    }
  }
  async request(tabId: number, ref: string, signal?: AbortSignal): Promise<NetworkRecord> {
    signal?.throwIfAborted();
    const state = this.state(tabId);
    if (typeof ref !== "string" || !ref.startsWith(`request:${state.epoch}:`)) throw staleRequest();
    const index = Number(ref.slice(`request:${state.epoch}:`.length));
    if (!Number.isSafeInteger(index) || index < 1 || requestRef(state.epoch, index) !== ref) throw staleRequest();
    const record = state.network.find((item) => item.requestRef === ref) ?? state.historical.get(ref) ?? (await this.restored(tabId, signal)).network.find((item) => item.requestRef === ref);
    signal?.throwIfAborted();
    if (this.tabs.get(tabId) !== state || !record || record.superseded
      || state.latest.get(sourceKey(record.debuggee.sessionId, record.requestId)) !== record.index
      || record.index <= state.invalidBefore
      || (record.frameId !== undefined && (state.invalidations.get(`frame:${record.frameId}`) ?? -1) >= record.index)
      || (record.debuggee.sessionId !== undefined && (state.invalidations.get(`session:${record.debuggee.sessionId}`) ?? -1) >= record.index)) throw staleRequest();
    if (!state.network.includes(record)) {
      state.historical.delete(ref); state.historical.set(ref, record);
      while (state.historical.size > HISTORY_CACHE_LIMIT) state.historical.delete(state.historical.keys().next().value!);
    }
    return record;
  }
  async console(tabId: number, input: { clear?: boolean; minLevel?: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const state = this.state(tabId);
    if (input.clear) { state.console = []; state.nextConsole = 0; state.revision += 1; state.pages.clear(); this.logger?.record({ type: "browser.diagnostic", ...this.context, ...this.context.logIdentity, content: { tabId, source: { tabId }, method: "console.clear", epoch: state.epoch, revision: state.revision }, output: null }); return { cleared: true }; }
    const rank: Record<string, number> = { debug: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3, assert: 3 };
    const records = state.nextConsole > CACHE_LIMIT ? (await this.restored(tabId, signal)).console : state.console;
    return records.filter((message) => (rank[message.level] ?? 1) >= (rank[input.minLevel ?? "info"] ?? 1)).slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100));
  }
}
