import type { trackFixtureRequests } from "./network-quiescence";
import type { trackServerResponses } from "./server-quiescence";

/** Both observers must be quiet simultaneously, not merely at different times. */
export async function waitForEvaluationQuiescence(browser: ReturnType<typeof trackFixtureRequests>, server: ReturnType<typeof trackServerResponses>, quietMs: number, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(0, deadline - performance.now());
    const [browserSettled, serverResult] = await Promise.all([
      browser.wait({ quietMs, timeoutMs: remaining }), server.wait({ quietMs, timeoutMs: remaining }),
    ]);
    if (!browserSettled || !serverResult.settled) return { settled: false, server: server.snapshot() };
    if (browser.isQuiet(quietMs) && server.isQuiet(quietMs)) return { settled: true, server: server.snapshot() };
    if (performance.now() >= deadline) return { settled: false, server: server.snapshot() };
  }
}
