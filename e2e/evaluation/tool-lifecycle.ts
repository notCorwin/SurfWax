type ToolEvent = { type?: unknown; conversationId?: unknown; runId?: unknown; toolCallId?: unknown; content?: unknown };

/** Operation names contain no tool arguments or page content. */
export function completedProgramOperations(events: readonly ToolEvent[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const event of events) {
    if (event.type !== "browser.job.progress" || !event.content || typeof event.content !== "object" || Array.isArray(event.content)) continue;
    const { operation, state } = event.content as Record<string, unknown>;
    if (state !== "completed" || typeof operation !== "string" || !operation) continue;
    counts[operation] = (counts[operation] ?? 0) + 1;
  }
  return counts;
}

/** Invalid model tool calls can have a failed terminal without a tool.started event. */
export function toolLifecycleEvidence(events: readonly ToolEvent[]) {
  const calls = new Map<string, { starts: number; finished: number; failed: number; startAfterTerminal: boolean }>();
  let invalidIdentities = 0;
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.finished" && event.type !== "tool.failed") continue;
    if (typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId || typeof event.toolCallId !== "string" || !event.toolCallId) {
      invalidIdentities++;
      continue;
    }
    const key = JSON.stringify([event.conversationId, event.runId, event.toolCallId]);
    const call = calls.get(key) ?? { starts: 0, finished: 0, failed: 0, startAfterTerminal: false };
    if (event.type === "tool.started") { call.startAfterTerminal ||= call.finished + call.failed > 0; call.starts++; }
    else if (event.type === "tool.finished") call.finished++;
    else call.failed++;
    calls.set(key, call);
  }
  const records = [...calls.values()];
  const started = records.reduce((count, call) => count + call.starts, 0);
  const missingTerminals = records.filter((call) => call.starts > 0 && call.finished + call.failed === 0).length;
  const duplicateStarts = records.filter((call) => call.starts > 1).length;
  const duplicateTerminals = records.filter((call) => call.finished + call.failed > 1).length;
  const startAfterTerminal = records.filter((call) => call.startAfterTerminal).length;
  // A successful completion without a start is never a valid rejected input.
  const orphanFinished = records.filter((call) => call.starts === 0 && call.finished > 0).length;
  const unstartedFailures = records.filter((call) => call.starts === 0 && call.failed === 1).length;
  const complete = started > 0 && invalidIdentities === 0 && missingTerminals === 0 && duplicateStarts === 0 && duplicateTerminals === 0 && startAfterTerminal === 0 && orphanFinished === 0;
  return { complete, started, missingTerminals, duplicateStarts, duplicateTerminals, startAfterTerminal, orphanFinished, unstartedFailures, invalidIdentities };
}
