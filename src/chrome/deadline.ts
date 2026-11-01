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
