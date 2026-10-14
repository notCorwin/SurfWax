import { expect, it, vi } from "vitest";
import { restoreConversationRepository } from "../conversations";
import { EventLogger, type LogEvent } from "../logging";
import { ConversationStore, createMessageProjection } from "./conversation-store";
import type { SidePanelMessage } from "../agent/transport";

it("lists historical archived conversations normally and preserves their messages", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  await logger.append({ type: "conversation.created", conversationId: "legacy", content: { title: "历史对话" } });
  await logger.appendMessage("legacy", { id: "saved", role: "user", parts: [{ type: "text", text: "保留历史消息" }] });
  await logger.append({ type: "conversation.archived", conversationId: "legacy", content: null });
  await logger.append({ type: "conversation.created", conversationId: "regular", content: { title: "普通对话" } });
  const runtime = new ConversationStore(logger, () => { throw new Error("Opening saved conversations must not request a model"); });
  await runtime.threads.reload();
  expect(runtime.getState().threads.threadIds).toHaveLength(2);
  expect(runtime.getState().threads.threadIds).toEqual(expect.arrayContaining(["legacy", "regular"]));
  await runtime.threads.switchToThread("legacy");
  expect(runtime.getState().thread.messages).toMatchObject([{ role: "user", parts: [{ type: "text", text: "保留历史消息" }] }]);
});

it("reconciles conversation-list writes from another logger before publishing a local update", async () => {
  const events: LogEvent[] = [];
  const store = {
    async append(event: Omit<LogEvent, "id">) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  };
  const logger = new EventLogger({ store });
  const otherLogger = new EventLogger({ store });
  const runtime = new ConversationStore(logger, () => { throw new Error("Listing conversations must not request a model"); });
  runtime.connect();
  await runtime.threads.reload();

  await otherLogger.append({ type: "conversation.created", conversationId: "external", content: { title: "其他窗口" } });
  expect(runtime.getState().threads.threadIds).not.toContain("external");

  await logger.append({ type: "conversation.created", conversationId: "local", content: { title: "当前窗口" } });
  await vi.waitFor(() => {
    expect(runtime.getState().threads.threadIds).toHaveLength(2);
    expect(runtime.getState().threads.threadIds).toEqual(expect.arrayContaining(["external", "local"]));
  });
});

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

it("rebuilds an early request failure from the canonical terminal event", async () => {
  const failure = { message: "provider rejected the request", status: 400 };
  const repository = await restoreConversationRepository([
    { id: 1, timestamp: new Date(0).toISOString(), type: "conversation.message", conversationId: "failed", parentId: null,
      content: { id: "question", role: "user", parts: [{ type: "text", text: "hello" }] } },
    { id: 2, timestamp: new Date(1).toISOString(), type: "conversation.submitted", conversationId: "failed", runId: "run-1",
      content: { messageId: "question" } },
    { id: 3, timestamp: new Date(2).toISOString(), type: "conversation.failed", conversationId: "failed", runId: "run-1",
      content: null, error: failure },
  ]);
  expect(repository.messages).toHaveLength(2);
  const restored = repository.messages[1]!.message;
  expect(restored).toMatchObject({ id: "failed-run-1", role: "assistant", metadata: { custom: { failure } } });
  expect(createMessageProjection().message(restored as SidePanelMessage, false, [restored.id]).status)
    .toEqual({ type: "incomplete", reason: "error", error: failure });
});
