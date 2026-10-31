import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface ServerActivity {
  /** Requests observed without both an ended response and a completed/aborted request. */
  active: number;
  /** Responses that reached finish after the complete request was received. */
  finished: number;
  /** Requests aborted or responses closed before finish. This is historical evidence. */
  interrupted: number;
}

/**
 * Attach before issuing requests. This complements browser-side tracking,
 * including requests that become Chrome downloads and are not surfaced as
 * Playwright request events. Response finish only means Node handed bytes to
 * the operating system; it does not prove the browser received them.
 */
export function trackServerResponses(server: Server, filter: (request: IncomingMessage) => boolean = () => true) {
  const active = new Map<ServerResponse, () => void>();
  const waiters = new Set<() => void>();
  let finished = 0, interrupted = 0, lastActivity = performance.now(), disposed = false;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const touch = () => { lastActivity = performance.now(); wake(); };

  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    if (!filter(request)) return;
    let requestDone = request.complete, responseDone = false, responseFinished = false, aborted = false;
    const cleanup = () => {
      request.off("end", onRequestEnd);
      request.off("aborted", onRequestAborted);
      request.off("close", onRequestClose);
      response.off("finish", onResponseFinish);
      response.off("close", onResponseClose);
    };
    const settle = () => {
      if (!requestDone || !responseDone || !active.has(response)) return;
      active.delete(response);
      cleanup();
      if (responseFinished && !aborted) finished++;
      else interrupted++;
      touch();
    };
    const onRequestEnd = () => { requestDone = true; settle(); };
    const onRequestAborted = () => { requestDone = true; aborted = true; settle(); };
    const onRequestClose = () => { requestDone = true; aborted ||= !request.complete; settle(); };
    const onResponseFinish = () => {
      responseDone = true;
      responseFinished = true;
      requestDone ||= request.complete;
      settle();
    };
    const onResponseClose = () => {
      responseDone = true;
      responseFinished ||= response.writableFinished;
      requestDone ||= request.complete || request.destroyed;
      aborted ||= !request.complete && request.destroyed;
      settle();
    };
    active.set(response, cleanup);
    request.once("end", onRequestEnd);
    request.once("aborted", onRequestAborted);
    request.once("close", onRequestClose);
    response.once("finish", onResponseFinish);
    response.once("close", onResponseClose);
    touch();
  };
  server.prependListener("request", onRequest);

  const snapshot = (): ServerActivity => ({ active: active.size, finished, interrupted });
  return {
    snapshot,
    isQuiet(quietMs: number): boolean {
      return !disposed && active.size === 0 && performance.now() - lastActivity >= quietMs;
    },
    /** A quiet server can still have historical interruptions or issue work in a future timer. */
    async wait({ quietMs, timeoutMs }: { quietMs: number; timeoutMs: number }): Promise<{ settled: boolean } & ServerActivity> {
      if (!Number.isFinite(quietMs) || quietMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid quiescence timing");
      const started = performance.now();
      const deadline = started + timeoutMs;
      while (!disposed) {
        const now = performance.now(), quietSince = Math.max(started, lastActivity);
        if (active.size === 0 && quietSince + quietMs <= deadline && now >= quietSince + quietMs) return { settled: true, ...snapshot() };
        if (now >= deadline) break;
        const next = active.size ? deadline : Math.min(deadline, quietSince + quietMs);
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          waiters.add(done);
          timer = setTimeout(done, Math.min(2_147_483_647, Math.max(0, next - performance.now())));
          if (disposed) done();
        });
      }
      return { settled: false, ...snapshot() };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      server.off("request", onRequest);
      for (const cleanup of active.values()) cleanup();
      active.clear();
      wake();
    },
  };
}
