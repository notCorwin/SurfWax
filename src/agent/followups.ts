import { fromLogValue, type LogEvent } from "../logging";

export const FOLLOWUP_EVENT_TYPES = [
  "conversation.followup.queued",
  "conversation.followup.dispatched",
  "conversation.followup.removed",
] as const;

export type FollowupMessage = {
  id: string;
  text: string;
  createdAt: string;
};

export function rebuildFollowups(events: readonly LogEvent[]): FollowupMessage[] {
  const pending = new Map<string, FollowupMessage>();
  for (const event of events) {
    if (!FOLLOWUP_EVENT_TYPES.includes(event.type as typeof FOLLOWUP_EVENT_TYPES[number])) continue;
    const content = fromLogValue(event.content) as { id?: unknown; text?: unknown; createdAt?: unknown } | null;
    if (!content || typeof content.id !== "string") continue;
    if (event.type === "conversation.followup.queued") {
      if (typeof content.text !== "string" || typeof content.createdAt !== "string") continue;
      pending.set(content.id, { id: content.id, text: content.text, createdAt: content.createdAt });
    } else {
      pending.delete(content.id);
    }
  }
  return [...pending.values()];
}

export function canAutoDispatchFollowup(events: readonly LogEvent[]): boolean {
  const terminal = [...events].reverse().find((event) =>
    event.type === "conversation.finished" || event.type === "conversation.failed" || event.type === "conversation.aborted");
  return terminal?.type === "conversation.finished";
}
