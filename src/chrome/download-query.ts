export type DownloadState = "in_progress" | "interrupted" | "complete";
export type DownloadListInput = { downloadId?: number; state?: DownloadState; limit?: number };
export type DownloadListResult = {
  downloads: chrome.downloads.DownloadItem[];
  hasMore: boolean;
  scope: "chrome-profile";
  consistency: "live";
  existence: "may-be-stale";
};

const DEFAULT_LIMIT = 100;
const MAX_CHROME_INTEGER = 2_147_483_647;
const states = new Set<DownloadState>(["in_progress", "interrupted", "complete"]);
type DownloadEvents = { addListener: (listener: () => void) => void; removeListener: (listener: () => void) => void };
type SharedRequest = { promise: Promise<chrome.downloads.DownloadItem[]>; waiters: number };
type SearchLease = { promise: Promise<chrome.downloads.DownloadItem[]>; release: () => void };
type InFlight = { revision: number; requests: Map<string, SharedRequest>; sources: DownloadEvents[]; changed: () => void };
const inFlight = new WeakMap<object, InFlight>();
function removeListeners(sources: readonly DownloadEvents[], listener: () => void): void {
  for (const source of sources) try { source.removeListener(listener); } catch { /* The extension context may already be gone. */ }
}

function searchDownloads(api: typeof chrome.downloads, query: chrome.downloads.DownloadQuery): SearchLease {
  // Chrome does not emit onChanged for bytesReceived or estimatedEndTime.
  // Therefore only queries restricted to non-active downloads can share a
  // pending result, and only while Chrome's change events have not fired.
  const sources = [api.onCreated, api.onChanged, api.onErased] as unknown as Array<DownloadEvents | undefined>;
  if ((query.state !== "complete" && query.state !== "interrupted") || sources.some((source) => !source?.addListener || !source.removeListener)) return { promise: api.search(query), release: () => undefined };
  let state = inFlight.get(api);
  if (!state) {
    const next: InFlight = { revision: 0, requests: new Map(), sources: sources as DownloadEvents[], changed: () => { next.revision++; } };
    const registered: DownloadEvents[] = [];
    try {
      for (const source of next.sources) { source.addListener(next.changed); registered.push(source); }
    } catch {
      removeListeners(registered, next.changed);
      return { promise: api.search(query), release: () => undefined };
    }
    state = next;
    inFlight.set(api, state);
  }
  const key = JSON.stringify([state.revision, query]);
  let entry = state.requests.get(key);
  if (!entry) {
    let promise: Promise<chrome.downloads.DownloadItem[]>;
    try { promise = api.search(query); }
    catch (error) {
      if (!state.requests.size) { removeListeners(state.sources, state.changed); inFlight.delete(api); }
      throw error;
    }
    entry = { promise, waiters: 0 };
    state.requests.set(key, entry);
    const created = entry;
    const current = state;
    // Consume a late rejection even if all callers have cancelled, and never
    // let an obsolete request remove a newer request with the same key.
    const settled = () => {
      if (current.requests.get(key) === created) current.requests.delete(key);
      if (!current.requests.size && inFlight.get(api) === current) {
        removeListeners(current.sources, current.changed);
        inFlight.delete(api);
      }
    };
    void promise.then(settled, settled);
  }
  const current = state;
  const requested = entry;
  requested.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    requested.waiters--;
    if (requested.waiters === 0 && current.requests.get(key) === requested) current.requests.delete(key);
    if (!current.requests.size && inFlight.get(api) === current) {
      removeListeners(current.sources, current.changed);
      inFlight.delete(api);
    }
  };
  return { promise: requested.promise, release };
}

function cancellation(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof DOMException && (reason.name === "AbortError" || reason.name === "TimeoutError")) return reason;
  return new DOMException(reason instanceof Error ? reason.message : String(reason ?? "Operation aborted"), "AbortError");
}

/** Read the browser's current download metadata. Chrome's `exists` field is asynchronous and may be stale. */
export async function listDownloads(
  chromeApi: Pick<typeof chrome, "downloads">,
  input: DownloadListInput = {},
  signal?: AbortSignal,
): Promise<DownloadListResult> {
  if (input.downloadId !== undefined && (!Number.isSafeInteger(input.downloadId) || input.downloadId < 0)) throw new Error("Invalid download ID");
  if (input.state !== undefined && !states.has(input.state)) throw new Error("Invalid download state");
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CHROME_INTEGER) throw new Error(`Download limit must be between 0 and ${MAX_CHROME_INTEGER}`);
  if (signal?.aborted) throw cancellation(signal);
  if (!chromeApi.downloads?.search) throw new Error("Chrome downloads API is unavailable");

  // Chrome documents ID lookups with only `id`; apply state locally for that case.
  // Fetch one extra item to report incompleteness without requesting the entire history.
  const query: chrome.downloads.DownloadQuery = input.downloadId !== undefined
    ? { id: input.downloadId }
    : { ...(input.state ? { state: input.state } : {}), orderBy: ["-startTime"], limit: limit === 0 || limit === MAX_CHROME_INTEGER ? 0 : limit + 1 };
  let abort: (() => void) | undefined;
  let lease: SearchLease | undefined;
  try {
    lease = searchDownloads(chromeApi.downloads, query);
    const interrupted = signal && new Promise<never>((_, reject) => {
      abort = () => reject(cancellation(signal));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const found = await (interrupted ? Promise.race([lease.promise, interrupted]) : lease.promise);
    if (signal?.aborted) throw cancellation(signal);
    const matches = input.downloadId !== undefined && input.state !== undefined
      ? found.filter((item) => item.state === input.state) : found;
    return { downloads: limit === 0 ? matches : matches.slice(0, limit), hasMore: limit !== 0 && matches.length > limit,
      scope: "chrome-profile", consistency: "live", existence: "may-be-stale" };
  } finally {
    if (signal && abort) signal.removeEventListener("abort", abort);
    lease?.release();
  }
}
