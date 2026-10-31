type Event = { type?: unknown; conversationId?: unknown; runId?: unknown; timestamp?: unknown };
type TerminalType = "conversation.finished" | "conversation.failed" | "conversation.aborted";

/** Classify the persisted terminal, not the time at which polling happened. */
export function deadlineEvidence(events: readonly Event[], startedAt: number, deadlineAt: number): {
  state: "pending" | "on_time" | "late" | "unknown";
  terminal: TerminalType | null;
  terminalTimestamp: string | null;
  logTerminalPresent: boolean;
} {
  const pending = { state: "pending" as const, terminal: null, terminalTimestamp: null, logTerminalPresent: false };
  const unknown = { state: "unknown" as const, terminal: null, terminalTimestamp: null, logTerminalPresent: false };
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || deadlineAt < startedAt) return unknown;
  let submission: Event | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === "conversation.submitted") { submission = events[index]; break; }
  }
  if (!submission) return events.some((event) => event.type === "conversation.finished" || event.type === "conversation.failed" || event.type === "conversation.aborted") ? unknown : pending;
  if (typeof submission.conversationId !== "string" || !submission.conversationId || typeof submission.runId !== "string" || !submission.runId) return unknown;
  const terminals = events.filter((event) => event.conversationId === submission.conversationId && event.runId === submission.runId &&
    (event.type === "conversation.finished" || event.type === "conversation.failed" || event.type === "conversation.aborted"));
  if (terminals.length === 0) return pending;
  if (terminals.length !== 1) return unknown;
  const event = terminals[0]!;
  const terminal = event.type as TerminalType;
  if (typeof event.timestamp !== "string") return { ...unknown, terminal, logTerminalPresent: true };
  const milliseconds = Date.parse(event.timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== event.timestamp || milliseconds < startedAt) {
    return { ...unknown, terminal, logTerminalPresent: true };
  }
  return { state: milliseconds <= deadlineAt ? "on_time" : "late", terminal, terminalTimestamp: event.timestamp, logTerminalPresent: true };
}
