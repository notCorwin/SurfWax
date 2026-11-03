import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { fromLogValue, type ConversationMessage, type LogEvent } from "../logging";
import { prepareToolMessages } from "../chrome/tool";
import { materializeToolCatalog } from "./tool-catalog";

type Boundary = { eventId: number; offset: number; message: ModelMessage | UIMessage; ui: boolean; assistant?: ConversationMessage };

/** Internal model messages have durable positions without changing the visible branch tree. */
export async function projectModelMessages(messages: readonly ConversationMessage[], events: readonly LogEvent[]): Promise<ModelMessage[]> {
  const boundaries = new Map<string, Boundary[]>();
  for (const event of events) {
    if (event.type !== "model.context.appended" && event.type !== "agent.goal.continued") continue;
    const value = fromLogValue(event.content, event.valueEncoding) as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object") continue;
    const ui = event.type === "agent.goal.continued";
    const id = ui ? value.messageId : value.anchorMessageId;
    const offset = ui ? value.offset : value.partCount;
    const message = (ui ? value.reminderMessage : value.message) as UIMessage | ModelMessage | undefined;
    if (typeof id !== "string" || !Number.isSafeInteger(offset) || Number(offset) < 0 || message?.role !== "user"
      || (ui ? !Array.isArray((message as UIMessage).parts) : !("content" in message))) continue;
    const list = boundaries.get(id) ?? [];
    list.push({ eventId: event.id, offset: Number(offset), message, ui,
      ...(ui && value.assistantSegment && typeof value.assistantSegment === "object" ? { assistant: value.assistantSegment as ConversationMessage } : {}) });
    boundaries.set(id, list);
  }
  const result: ModelMessage[] = [];
  const convert = async (message: ConversationMessage) => {
    const raw = await convertToModelMessages([materializeToolCatalog(message as UIMessage)], { ignoreIncompleteToolCalls: true });
    // Screenshot bytes are transported in their own durable model message.
    return prepareToolMessages(raw, 0, undefined, undefined, false) as Promise<ModelMessage[]>;
  };
  for (const source of messages) {
    let offset = 0;
    let goalOffset = 0;
    const entries = (boundaries.get(source.id) ?? []).filter((entry) => entry.offset <= source.parts.length)
      .sort((left, right) => left.offset - right.offset || left.eventId - right.eventId);
    for (const entry of entries) {
      if (entry.offset > offset) result.push(...await convert({ ...source, parts: source.parts.slice(offset, entry.offset) }));
      if (entry.ui) {
        if (!source.parts.slice(goalOffset, entry.offset).some((part) => part && typeof part === "object" && "type" in part && part.type !== "step-start")
          && entry.assistant) result.push(...await convert(entry.assistant));
        result.push(...await convert(entry.message as ConversationMessage));
        goalOffset = entry.offset;
      } else result.push(entry.message as ModelMessage);
      offset = entry.offset;
    }
    if (offset < source.parts.length) result.push(...await convert({ ...source, parts: source.parts.slice(offset) }));
  }
  return result;
}
