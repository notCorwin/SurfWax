import { expect, it } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { ConversationStore, createMessageProjection } from "./conversation-store";

it("restores the selected reply inside an inactive branch when reopening a conversation", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const conversationId = "branches";
  for (const [id, role, parentId] of [
    ["question", "user", null], ["original", "assistant", "question"], ["regenerated", "assistant", "question"],
  ] as const) await logger.appendMessage(conversationId, { id, role, parts: [{ type: "text", text: id }] }, { parentId });
  await logger.append({ type: "conversation.branch.selected", conversationId, content: { headId: "original" } });
  await logger.appendMessage(conversationId, { id: "edited", role: "user", parts: [{ type: "text", text: "edited" }] }, { parentId: null });
  await logger.appendMessage(conversationId, { id: "edited-reply", role: "assistant", parts: [{ type: "text", text: "edited reply" }] }, { parentId: "edited" });
  const runtime = new ConversationStore(logger, () => { throw new Error("Branch navigation must not request a model"); });
  await runtime.threads.switchToThread(conversationId);
  expect(runtime.getState().thread.messages.map(({ id }) => id)).toEqual(["edited", "edited-reply"]);
  await runtime.thread.getMessageById("edited").switchToBranch({ position: "previous" });
  expect(runtime.getState().thread.messages.map(({ id }) => id)).toEqual(["question", "original"]);
  await runtime.thread.getMessageById("question").switchToBranch({ position: "next" });
  expect(runtime.getState().thread.messages.map(({ id }) => id)).toEqual(["edited", "edited-reply"]);
});

it("shows structured tool failures without losing the full result", () => {
  const output = { ok: false, error: { message: "Command was removed", detail: "Keep the complete diagnostic" } };
  const projected = createMessageProjection().message({ id: "reply", role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "removed-command", toolCallId: "call", state: "output-available", input: {}, output,
  }] }, false, ["reply"]);
  expect(projected.parts[0]).toMatchObject({ type: "tool-call", isError: true, status: { type: "incomplete" }, result: output });
});
