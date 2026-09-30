export type DownloadRequest = { id: string; artifact?: { id: number; filename: string }; error?: string };
type Pending = DownloadRequest & { resolve: () => void; reject: (error: unknown) => void; cleanup: () => void };
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let snapshot: readonly DownloadRequest[] = [];
function changed(): void { snapshot = [...pending.values()].map(({ id, artifact, error }) => ({ id, artifact, error })); for (const listener of listeners) listener(); }
export function downloadRequests(): readonly DownloadRequest[] { return snapshot; }
export function subscribeDownloadRequests(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export async function ensureDownloadPermission(signal?: AbortSignal, artifact?: { id: number; filename: string }, onWaiting?: () => void): Promise<void> {
  signal?.throwIfAborted();
  if (await chrome.permissions.contains({ permissions: ["downloads"] })) { signal?.throwIfAborted(); return; }
  signal?.throwIfAborted();
  onWaiting?.();
  await new Promise<void>((resolve, reject) => {
    const id = crypto.randomUUID();
    const cancel = () => { const entry = pending.get(id); if (!entry) return; pending.delete(id); entry.cleanup(); changed(); reject(signal?.reason instanceof Error ? signal.reason : new DOMException(String(signal?.reason ?? "保存已取消"), "AbortError")); };
    pending.set(id, { id, artifact, resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) });
    signal?.addEventListener("abort", cancel, { once: true });
    changed();
  });
}
/** Call directly from a real click, before any await, to preserve Chrome's user gesture. */
export async function authorizeDownload(id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  try {
    const granted = await chrome.permissions.request({ permissions: ["downloads"] });
    if (!pending.has(id)) return;
    pending.delete(id); entry.cleanup(); changed();
    if (granted) entry.resolve();
    else entry.reject(Object.assign(new Error("下载授权被拒绝；产物仍保留在会话中，可稍后再次保存。"), { code: "download-permission-denied", artifact: entry.artifact }));
  } catch (error) { pending.delete(id); entry.cleanup(); changed(); entry.reject(error); }
}
export function cancelDownload(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id); entry.cleanup(); changed();
  entry.reject(Object.assign(new Error("已取消保存；产物仍保留在会话中。"), { code: "download-cancelled", artifact: entry.artifact }));
}
