import { fromLogValue } from "../../src/logging";

/** Classify whether browser jobs have settled without unknown effects. */
export function browserJobsSettled(events: readonly { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; content?: unknown; output?: unknown; valueEncoding?: unknown }[]): boolean | null {
  const states = new Map<string, { id: number; state: string; knownFailure: boolean }>();
  const ids = new Set<number>();
  const known = new Set(["queued", "running", "blocked", "succeeded", "failed", "cancelled", "interrupted"]);
  for (const event of events) {
    if (event.type !== "browser.job.state") continue;
    if (!Number.isSafeInteger(event.id) || Number(event.id) < 1 || ids.has(event.id as number)
      || typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId
      || event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) return null;
    ids.add(event.id as number);
    let content: unknown;
    try { content = fromLogValue(event.content, event.valueEncoding as 2 | 3 | 4 | 5 | undefined); } catch { return null; }
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const { jobId, state } = content as Record<string, unknown>;
    if (typeof jobId !== "string" || !jobId || typeof state !== "string" || !known.has(state)) return null;
    let knownFailure = false;
    if (state === "failed" && Object.hasOwn(event, "output")) {
      try {
        const output = fromLogValue(event.output, event.valueEncoding as 2 | 3 | 4 | 5 | undefined);
        if (output && typeof output === "object" && !Array.isArray(output)) {
          const record = output as Record<string, unknown>, error = record.error;
          if (record.ok === false && error && typeof error === "object" && !Array.isArray(error)) {
            const detail = error as Record<string, unknown>;
            knownFailure = typeof detail.code === "string" && !!detail.code && typeof detail.message === "string"
              && (detail.effectUnknown === undefined || detail.effectUnknown === false);
          }
        }
      } catch { /* Missing, detached or invalid result evidence remains unknown. */ }
    }
    const key = JSON.stringify([event.conversationId, event.runId, jobId]);
    const prior = states.get(key);
    if (!prior || Number(event.id) > prior.id) states.set(key, { id: Number(event.id), state, knownFailure });
  }
  const latest = [...states.values()];
  if (latest.some(({ state }) => ["queued", "running", "blocked"].includes(state))) return false;
  // Cancellation or host interruption is terminal in the log but does not
  // establish whether a dispatched effect completed before work was stopped.
  if (latest.some(({ state, knownFailure }) => state === "cancelled" || state === "interrupted" || state === "failed" && !knownFailure)) return null;
  return true;
}
