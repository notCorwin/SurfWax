/** Schedule a cancellable deadline without overflowing the browser's 32-bit timer. */
export function scheduleDeadline(timeoutMs: number, onDeadline: () => void): () => void {
  let remaining = timeoutMs;
  let started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const elapsed = Math.max(0, performance.now() - started);
    remaining = Math.max(0, remaining - elapsed);
    if (remaining === 0) { onDeadline(); return; }
    started = performance.now();
    timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  };
  timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}

/** One lifetime for an operation, including time spent waiting for its queue.
 * Consumers must use signal to revoke work at the dispatch boundary; wait only
 * bounds observation of promises whose underlying API cannot be cancelled.
 */
export function createDeadline(timeoutMs: number, parent?: AbortSignal, label = "Operation") {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Operation timeout must be a positive safe integer");
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const cancel = scheduleDeadline(timeoutMs, () => controller.abort(new DOMException(`${label} timed out after ${timeoutMs}ms`, "TimeoutError")));
  return {
    signal,
    async wait<T>(task: PromiseLike<T>): Promise<T> {
      const pending = Promise.resolve(task);
      if (signal.aborted) { void pending.catch(() => undefined); signal.throwIfAborted(); }
      let onAbort!: () => void;
      try {
        return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
      } finally { signal.removeEventListener("abort", onAbort); }
    },
    dispose: cancel,
  };
}
