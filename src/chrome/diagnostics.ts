import { fromLogValue, type EventLogger } from "../logging";

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
export type NetworkRecord = {
  index: number; requestId: string; debuggee: Debuggee; method: string; url: string;
  requestHeaders: Record<string, string>; requestBody?: string; frameId?: string;
  status?: number; statusText?: string; responseHeaders?: Record<string, string>; failed?: string; resourceType?: string;
};
export type ConsoleRecord = { index: number; level: string; text: string; timestamp?: number };
type PendingHeaders = { request?: Record<string, string>; response?: Record<string, string> };
type State = { epoch: string; nextRequest: number; nextConsole: number; network: NetworkRecord[]; console: ConsoleRecord[]; pendingHeaders: Map<string, PendingHeaders> };
const CACHE_LIMIT = 1000;

/** Disposable diagnostic caches. The event log contains every unmodified CDP event. */
export class BrowserDiagnostics {
  private readonly tabs = new Map<number, State>();
  private context: { conversationId?: string; toolCallId?: string; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } } = {};
  constructor(private readonly logger?: EventLogger) {}
  bind(context: typeof this.context): void { this.context = context; }
  private state(tabId: number): State {
    let state = this.tabs.get(tabId);
    if (!state) { state = { epoch: crypto.randomUUID(), nextRequest: 0, nextConsole: 0, network: [], console: [], pendingHeaders: new Map() }; this.tabs.set(tabId, state); }
    return state;
  }
  remove(tabId: number): void { this.tabs.delete(tabId); }
  clear(): void { this.tabs.clear(); this.context = {}; }
  reset(tabId: number): void { this.tabs.delete(tabId); this.state(tabId); }
  handle(source: Debuggee, method: string, params: any): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Page.frameNavigated" && !source.sessionId && !params?.frame?.parentId) this.reset(tabId);
    if (!method.startsWith("Network.") && method !== "Runtime.consoleAPICalled" && method !== "Log.entryAdded") return;
    const state = this.state(tabId);
    const existing = state.network.find((item) => item.requestId === params.requestId && item.debuggee.sessionId === source.sessionId);
    const index = method === "Network.requestWillBeSent" ? existing?.index ?? ++state.nextRequest
      : method === "Runtime.consoleAPICalled" || method === "Log.entryAdded" ? ++state.nextConsole : existing?.index;
    this.logger?.record({ type: "browser.diagnostic", ...this.context, ...this.context.logIdentity, content: { tabId, source, method, epoch: state.epoch, index }, output: params });
    this.apply(state, source, method, params, index);
    if (state.network.length > CACHE_LIMIT) state.network.splice(0, state.network.length - CACHE_LIMIT);
    if (state.console.length > CACHE_LIMIT) state.console.splice(0, state.console.length - CACHE_LIMIT);
  }
  private apply(state: State, source: Debuggee, method: string, params: any, index?: number): void {
    if (method === "console.clear") { state.console = []; return; }
    const key = JSON.stringify([source.sessionId, params?.requestId]);
    const existing = state.network.find((item) => item.requestId === params.requestId && item.debuggee.sessionId === source.sessionId);
    if (method === "Network.requestWillBeSent") {
      const record: NetworkRecord = existing ?? { index: index!, requestId: params.requestId, debuggee: source, method: params.request.method, url: params.request.url, requestHeaders: {} };
      Object.assign(record, { method: params.request.method, url: params.request.url, requestHeaders: params.request.headers ?? {}, requestBody: params.request.postData, resourceType: params.type, frameId: params.frameId, responseHeaders: undefined });
      const headers = state.pendingHeaders.get(key);
      if (headers?.request) record.requestHeaders = headers.request;
      if (headers?.response) record.responseHeaders = headers.response;
      state.pendingHeaders.delete(key);
      if (!existing) state.network.push(record);
    } else if (method === "Network.responseReceived" && existing) {
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
  private async restored(tabId: number): Promise<State> {
    const current = this.state(tabId);
    if (!this.logger || !this.context.conversationId) return current;
    const state: State = { ...current, network: [], console: [], pendingHeaders: new Map() };
    for (const event of await this.logger.diagnosticEvents(this.context.conversationId)) {
      const content = fromLogValue(event.content) as { tabId?: number; source: Debuggee; method: string; epoch?: string; index?: number };
      if (content.tabId !== tabId || content.epoch !== current.epoch) continue;
      this.apply(state, content.source, content.method, fromLogValue(event.output), content.index);
    }
    return state;
  }
  async requests(tabId: number, input: { static?: boolean; filter?: string; clear?: boolean; offset?: number; limit?: number }): Promise<unknown> {
    if (input.clear) { this.reset(tabId); return { cleared: true }; }
    const state = this.state(tabId);
    const records = state.nextRequest > CACHE_LIMIT ? (await this.restored(tabId)).network : state.network;
    const matcher = input.filter ? new RegExp(input.filter) : undefined;
    return records.filter((record) => {
      const isStatic = ["Image", "Font", "Stylesheet", "Script", "Media"].includes(record.resourceType ?? "") && !record.failed && (record.status ?? 0) < 400;
      return (input.static || !isStatic) && (!matcher || matcher.test(record.url));
    }).slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100)).map(({ index, method, url, status, failed, statusText }) => ({ index, method, url, status: failed ? "FAILED" : status, statusText: failed ?? statusText }));
  }
  async request(tabId: number, index: number): Promise<NetworkRecord | undefined> {
    return this.state(tabId).network.find((record) => record.index === index) ?? (await this.restored(tabId)).network.find((record) => record.index === index);
  }
  async console(tabId: number, input: { clear?: boolean; minLevel?: string; offset?: number; limit?: number }): Promise<unknown> {
    const state = this.state(tabId);
    if (input.clear) { state.console = []; state.nextConsole = 0; this.logger?.record({ type: "browser.diagnostic", ...this.context, ...this.context.logIdentity, content: { tabId, source: { tabId }, method: "console.clear", epoch: state.epoch }, output: null }); return { cleared: true }; }
    const rank: Record<string, number> = { debug: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3, assert: 3 };
    const records = state.nextConsole > CACHE_LIMIT ? (await this.restored(tabId)).console : state.console;
    return records.filter((message) => (rank[message.level] ?? 1) >= (rank[input.minLevel ?? "info"] ?? 1)).slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100));
  }
}
