import type { UIMessage } from "ai";
import { fromLogValue, type LogEvent } from "../logging";

type Continuation = { messageId: string; offset: number; assistantSegment: UIMessage; reminderMessage: UIMessage };

/** Replay internal continuation messages only for assistant messages on the active branch. */
export function replayGoalContinuations<T extends UIMessage>(messages: readonly T[], events: readonly LogEvent[]): UIMessage[] {
  const byMessage = new Map<string, Continuation[]>();
  for (const event of events) {
    if (event.type !== "agent.goal.continued") continue;
    const item = fromLogValue(event.content, event.valueEncoding) as Continuation | undefined;
    if (!item || typeof item.messageId !== "string" || !Number.isSafeInteger(item.offset) || item.offset < 0
      || item.assistantSegment?.role !== "assistant" || !Array.isArray(item.assistantSegment.parts)
      || item.reminderMessage?.role !== "user" || !Array.isArray(item.reminderMessage.parts)) continue;
    const entries = byMessage.get(item.messageId) ?? [];
    entries.push(item);
    byMessage.set(item.messageId, entries);
  }
  return messages.flatMap((message) => {
    const entries = byMessage.get(message.id);
    if (!entries?.length) return [message];
    const result: UIMessage[] = [];
    let offset = 0;
    for (const item of entries) {
      if (item.offset < offset || item.offset > message.parts.length) continue;
      result.push(item.assistantSegment, item.reminderMessage);
      offset = item.offset;
    }
    if (offset < message.parts.length) result.push({ ...message, parts: message.parts.slice(offset) });
    return result;
  });
}
