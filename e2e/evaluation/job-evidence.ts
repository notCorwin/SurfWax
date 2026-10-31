import { fromLogValue } from "../../src/logging";

/** Classify whether browser jobs have settled without unknown effects. */
export function browserJobsSettled(events: readonly { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; content?: unknown; output?: unknown; valueEncoding?: unknown }[]): boolean | null {
  const states = new Map<string, { id: number; state: string; knownFailure: boolean }>();
  const handoffs = new Set<string>();
  const ids = new Set<number>();
  const known = new Set(["queued", "running", "blocked", "succeeded", "failed", "cancelled", "interrupted"]);
  for (const event of events) {
    if (event.type === "tool.finished") {
      if (!Object.hasOwn(event, "output") || event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) return null;
      let output: unknown;
      try { output = fromLogValue(event.output, event.valueEncoding as 2 | 3 | 4 | 5 | undefined); } catch { return null; }
      if (!output || typeof output !== "object" || Array.isArray(output)) continue;
      const outer = output as Record<string, unknown>;
      const records = [outer];
      if (outer.envelopeWrapped === true) {
        if (outer.result && typeof outer.result === "object" && !Array.isArray(outer.result)) records.push(outer.result as Record<string, unknown>);
        // Compacted envelopes preserve any accepted handoff on the outer object.
        else if (!Number.isSafeInteger(outer.$ref) || Number(outer.$ref) < 1) return null;
      }
      const jobIds = new Set<string>();
      for (const record of records) {
        if (record.accepted !== true || record.complete !== false && !Object.hasOwn(record, "jobId")) {
          if (record.complete === false && Object.hasOwn(record, "jobId")) return null;
          continue;
        }
        if (typeof record.jobId !== "string" || !record.jobId) return null;
        jobIds.add(record.jobId);
      }
      if (jobIds.size > 1) return null;
      if (jobIds.size) {
        if (typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId) return null;
        handoffs.add(JSON.stringify([event.conversationId, event.runId, [...jobIds][0]]));
      }
      continue;
    }
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
  // A durable tool handoff without its corresponding job state cannot prove
  // that the accepted work finished, even if every other job settled.
  if ([...handoffs].some((key) => !states.has(key))) return null;
  // Cancellation or host interruption is terminal in the log but does not
  // establish whether a dispatched effect completed before work was stopped.
  if (latest.some(({ state, knownFailure }) => state === "cancelled" || state === "interrupted" || state === "failed" && !knownFailure)) return null;
  return true;
}
