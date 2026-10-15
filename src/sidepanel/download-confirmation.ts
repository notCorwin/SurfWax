export type DownloadConfirmationRequest = {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
};

type Pending = DownloadConfirmationRequest & {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

const queue: Pending[] = [];
const listeners = new Set<() => void>();
let current: Pending | undefined;

function publish(): void {
  for (const listener of listeners) listener();
}

function advance(): void {
  current = queue.shift();
  publish();
}

function removeAbort(item: Pending): void {
  if (item.signal && item.abort) item.signal.removeEventListener("abort", item.abort);
}

export function downloadConfirmationSnapshot(): DownloadConfirmationRequest | undefined {
  return current;
}

export function subscribeDownloadConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function respondToDownloadConfirmation(id: string, approved: boolean): void {
  if (current?.id !== id) return;
  const item = current;
  removeAbort(item);
  current = undefined;
  if (approved) item.resolve();
  else item.reject(Object.assign(new Error("用户取消了文件保存。"), { code: "download-denied" }));
  advance();
}

export function requestDownloadConfirmation(
  details: Omit<DownloadConfirmationRequest, "id">,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const item: Pending = { id: crypto.randomUUID(), ...details, resolve, reject, signal };
    item.abort = () => {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      if (current === item) {
        current = undefined;
        advance();
      }
      removeAbort(item);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", item.abort, { once: true });
    if (signal?.aborted) { item.abort(); return; }
    queue.push(item);
    if (!current) advance();
  });
}
