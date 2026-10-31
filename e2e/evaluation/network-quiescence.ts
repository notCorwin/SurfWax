import type { BrowserContext, Request } from "@playwright/test";

/** Observe from before navigation so popup and other page requests are included. */
export function trackFixtureRequests(context: BrowserContext, origins: readonly string[]) {
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  const active = new Set<Request>();
  const waiters = new Set<() => void>();
  let lastActivity = performance.now();
  let disposed = false;

  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const onRequest = (request: Request) => {
    let origin: string;
    try { origin = new URL(request.url()).origin; } catch { return; }
    if (!allowed.has(origin)) return;
    active.add(request);
    lastActivity = performance.now();
    wake();
  };
  const onEnd = (request: Request) => {
    if (!active.delete(request)) return;
    lastActivity = performance.now();
    wake();
  };
  context.on("request", onRequest);
  context.on("requestfinished", onEnd);
  context.on("requestfailed", onEnd);

  return {
    /** True means no observed in-flight requests for quietMs, not that future timers cannot issue requests. */
    async wait({ quietMs, timeoutMs }: { quietMs: number; timeoutMs: number }): Promise<boolean> {
      if (!Number.isFinite(quietMs) || quietMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid quiescence timing");
      const started = performance.now();
      const deadline = started + timeoutMs;
      while (!disposed) {
        const now = performance.now();
        const quietSince = Math.max(started, lastActivity);
        if (active.size === 0 && quietSince + quietMs <= deadline && now >= quietSince + quietMs) return true;
        if (now >= deadline) return false;
        const nextCheck = active.size ? deadline : Math.min(deadline, quietSince + quietMs);
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          waiters.add(done);
          timer = setTimeout(done, Math.min(2_147_483_647, Math.max(0, nextCheck - performance.now())));
          if (disposed) done();
        });
      }
      return false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      context.off("request", onRequest);
      context.off("requestfinished", onEnd);
      context.off("requestfailed", onEnd);
      active.clear();
      wake();
    },
  };
}
