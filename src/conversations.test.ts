import { describe, expect, it, vi } from "vitest";
import { branchMessages, createMessageProjection } from "./sidepanel/conversation-store";
import type { SidePanelMessage } from "./agent/transport";
import { activeConversationMessages, generateConversationTitle, restoreConversationRepository } from "./conversations";
import * as model from "./agent/model";
import { EventLogger, rebuildConversationList, rebuildConversationRepository, selectedConversationId, toLogValue, type LogEvent } from "./logging";

function event(id: number, type: string, options: Partial<LogEvent> = {}): LogEvent {
  return {
    id,
    type,
    timestamp: new Date(id * 1_000).toISOString(),
    content: null,
    ...options,
  };
}

it("does not send a queued title request after the user renames the running conversation", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(record) { const stored = { ...record, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const createModel = vi.spyOn(model, "createModel").mockRejectedValue(new Error("Unexpected title request"));
  const subscribe = vi.spyOn(logger, "subscribe");
  const conversationId = "renamed-while-running";
  try {
    await logger.append({ type: "conversation.created", conversationId, content: { title: "新对话" } });
    const title = generateConversationTitle(logger, { baseURL: "https://provider.test/v1", model: "test" }, conversationId);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    await logger.append({ type: "conversation.title.updated", conversationId, content: { title: "First manual title", source: "manual" } });
    await logger.append({ type: "conversation.title.updated", conversationId, content: { title: "Latest manual title", source: "manual" } });
    await logger.append({ type: "conversation.finished", conversationId, runId: "finished-run", content: null });
    await expect(title).resolves.toBe("Latest manual title");
    expect(createModel).not.toHaveBeenCalled();
    expect(events.filter(event => event.type.startsWith("model.title."))).toEqual([]);
    expect(rebuildConversationList(events)[0]?.title).toBe("Latest manual title");
  } finally { createModel.mockRestore(); subscribe.mockRestore(); }
});

describe("conversation restoration", () => {
  it("shows a failed completed response as an error instead of a user cancellation", async () => {
    const repository = await restoreConversationRepository([
      event(1, "conversation.message", { content: { id: "user", role: "user", parts: [] } }),
      event(2, "conversation.submitted", { runId: "run", content: { messageId: "user" } }),
      event(3, "conversation.message", { runId: "run", parentId: "user", content: {
        id: "assistant", role: "assistant", parts: [{ type: "text", text: "Completed progress", state: "done" }],
      } }),
      event(4, "conversation.failed", { runId: "run", error: "Provider rejected the next request" }),
    ]);
    const message = repository.messages.at(-1)!.message as SidePanelMessage;
    const view = createMessageProjection().message(message, false, [message.id]);
    expect(view.status).toMatchObject({ type: "incomplete", reason: "error", error: "Provider rejected the next request" });
    expect(view.parts).toMatchObject([{ type: "text", text: "Completed progress" }]);
  });

  it("ignores legacy events and rebuilds sorted conversation metadata", () => {
    const events = [
      event(1, "conversation.message", { content: toLogValue({ id: "legacy" }) }),
      event(2, "conversation.created", { conversationId: "old", content: toLogValue({ title: "旧对话" }) }),
      event(3, "conversation.created", { conversationId: "new", content: toLogValue({ title: "新对话" }) }),
      event(4, "conversation.submitted", { conversationId: "old", runId: "r1" }),
      event(5, "conversation.aborted", { conversationId: "old", runId: "r1" }),
      event(6, "conversation.title.updated", { conversationId: "new", content: toLogValue({ title: "生成标题" }) }),
      event(7, "conversation.selected", { conversationId: "old" }),
    ];

    expect(rebuildConversationList(events)).toMatchObject([
      { id: "new", title: "生成标题", runStatus: "idle" },
      { id: "old", title: "旧对话", runStatus: "interrupted" },
    ]);
    expect(selectedConversationId(events)).toBe("old");
  });

  it("restores complete responses and reconciles interrupted tool results", async () => {
    const conversationId = "thread-1";
    const runId = "run-1";
    const events = [
      event(1, "conversation.message", { conversationId, runId,
        content: toLogValue({ id: "user-1", role: "user", parts: [{ type: "text", text: "检查页面" }] }) }),
      event(2, "conversation.submitted", { conversationId, runId, content: { messageId: "user-1" } }),
      event(3, "conversation.message", { conversationId, runId, parentId: "user-1", content: toLogValue({
        id: "assistant-1", role: "assistant", parts: [
          { type: "text", text: "已经读取", state: "done" },
          { type: "reasoning", text: "先确认状态", state: "done" },
          { type: "dynamic-tool", toolCallId: "done", toolName: "run", state: "input-available", input: { code: "return 1" } },
          { type: "dynamic-tool", toolCallId: "pending", toolName: "run", state: "input-available", input: { code: "return 2" } },
          { type: "dynamic-tool", toolCallId: "not-started", toolName: "run", state: "input-available", input: { code: "return 3" } },
        ],
      }) }),
      event(4, "tool.finished", { conversationId, runId, toolCallId: "done", output: { value: 1 } }),
      event(5, "tool.started", { conversationId, runId, toolCallId: "pending" }),
      event(6, "conversation.aborted", { conversationId, runId }),
    ];
    const repository = await restoreConversationRepository(events);
    expect(repository.headId).toBe("assistant-1");
    expect(repository.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
    const assistant = repository.messages[1]!.message;
    expect(assistant.metadata).toMatchObject({ interrupted: true });
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "已经读取", state: "done" }),
      expect.objectContaining({ type: "reasoning", text: "先确认状态", state: "done" }),
      expect.objectContaining({ toolCallId: "done", state: "output-available", output: { value: 1 } }),
      expect.objectContaining({ toolCallId: "pending", state: "output-error" }),
      expect.objectContaining({ toolCallId: "not-started", state: "output-error" }),
    ]));
  });

  it("restores the selected branch until a newer message advances the head", async () => {
    const messages = [
      event(1, "conversation.message", { content: toLogValue({ id: "u1", role: "user", parts: [] }) }),
      event(2, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [] }) }),
      event(3, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
    ];
    const selected = event(4, "conversation.branch.selected", { content: toLogValue({ headId: "a1" }) });
    expect((await restoreConversationRepository([...messages, selected])).headId).toBe("a1");
    expect((await restoreConversationRepository([...messages, selected, event(5, "conversation.message", {
      parentId: "a1",
      content: toLogValue({ id: "u2", role: "user", parts: [] }),
    })])).headId).toBe("u2");
    expect((await restoreConversationRepository([...messages, event(4, "conversation.branch.selected", {
      content: toLogValue({ headId: "missing" }),
    })])).headId).toBe("a2");
  });

  it("keeps a selected branch after a late reply snapshot and advances on the next submitted run", async () => {
    const messages = [
      event(1, "conversation.message", { content: toLogValue({ id: "u1", role: "user", parts: [] }) }),
      event(2, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [] }) }),
      event(3, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
      event(4, "conversation.submitted", { runId: "run" }),
      event(5, "conversation.finished", { runId: "run" }),
      event(6, "conversation.branch.selected", { content: toLogValue({ headId: "a1" }) }),
      event(7, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
    ];
    expect((await restoreConversationRepository(messages)).headId).toBe("a1");
    expect((await restoreConversationRepository([...messages,
      event(8, "conversation.submitted", { runId: "next" }),
      event(9, "conversation.message", { parentId: "a1", content: toLogValue({ id: "u2", role: "user", parts: [] }) }),
    ])).headId).toBe("u2");
  });

  it("keeps a selected branch when regeneration fails before creating a message", async () => {
    const events = [
      event(1, "conversation.message", { content: toLogValue({ id: "u1", role: "user", parts: [] }) }),
      event(2, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [] }) }),
      event(3, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
      event(4, "conversation.branch.selected", { content: toLogValue({ headId: "a1" }) }),
      event(5, "conversation.submitted", { runId: "retry", content: toLogValue({ messageId: "u1" }) }),
      event(6, "conversation.failed", { runId: "retry", error: "Unauthorized" }),
    ];

    expect((await restoreConversationRepository(events)).headId).toBe("a1");
    expect(rebuildConversationRepository(events).headId).toBe("a1");
  });

  it("advances a selected branch when a new canonical message is appended without a submitted event", async () => {
    const events = [
      event(1, "conversation.message", { content: toLogValue({ id: "u1", role: "user", parts: [] }) }),
      event(2, "conversation.submitted", { runId: "run" }),
      event(3, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [] }) }),
      event(4, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
      event(5, "conversation.branch.selected", { content: toLogValue({ headId: "a1" }) }),
      event(6, "conversation.message", { parentId: "a1", content: toLogValue({ id: "u2", role: "user", parts: [] }) }),
      event(7, "conversation.message", { parentId: "u2", content: toLogValue({ id: "a3", role: "assistant", parts: [] }) }),
    ];
    expect((await restoreConversationRepository(events)).headId).toBe("a3");
    expect((await restoreConversationRepository([...events,
      event(8, "conversation.branch.selected", { content: toLogValue({ headId: "a1" }) }),
      event(9, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
    ])).headId).toBe("a1");
  });

  it("updates an old reply without moving the default head back from a newer message", async () => {
    const events = [
      event(1, "conversation.message", { content: toLogValue({ id: "u1", role: "user", parts: [] }) }),
      event(2, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Original" }] }) }),
      event(3, "conversation.message", { parentId: "a1", content: toLogValue({ id: "u2", role: "user", parts: [] }) }),
      event(4, "conversation.message", { parentId: "u2", content: toLogValue({ id: "a2", role: "assistant", parts: [] }) }),
      event(5, "conversation.message", { parentId: "u1", content: toLogValue({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Updated" }] }) }),
    ];
    for (const repository of [await restoreConversationRepository(events), rebuildConversationRepository(events)]) {
      expect(repository.headId).toBe("a2");
      expect(repository.messages.map(({ message }) => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
      expect(repository.messages.find(({ message }) => message.id === "a1")?.message.parts).toEqual([{ type: "text", text: "Updated" }]);
      expect(branchMessages(repository).map((message) => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
    }
  });
});

it("keeps a completed reply when regeneration fails before producing a replacement", async () => {
  const conversationId = "thread";
  const original = { id: "original", role: "assistant", parts: [{ type: "tool-click", toolCallId: "original-call", state: "output-available", input: {}, output: { ok: true } }, { type: "text", text: "Original reply" }] };
  const repository = await restoreConversationRepository([
    event(1, "conversation.message", { conversationId, runId: "old", content: toLogValue({ id: "user", role: "user", parts: [{ type: "text", text: "Request" }] }) }),
    event(2, "conversation.message", { conversationId, runId: "old", parentId: "user", content: toLogValue(original) }),
    event(3, "conversation.finished", { conversationId, runId: "old" }),
    event(4, "conversation.submitted", { conversationId, runId: "retry", content: { messageId: "user" } }),
    event(5, "conversation.failed", { conversationId, runId: "retry", error: "Unauthorized" }),
  ]);
  expect(repository.headId).toBe("original");
  expect(repository.messages.at(-1)?.message).toEqual(original);
});

it("replaces an output-free synthetic failure with the latest terminal", async () => {
  const repository = await restoreConversationRepository([
    event(1, "conversation.message", { content: toLogValue({ id: "user", role: "user", parts: [] }) }),
    event(2, "conversation.submitted", { runId: "first", content: toLogValue({ messageId: "user" }) }),
    event(3, "conversation.failed", { runId: "first", error: "old error" }),
    event(4, "conversation.submitted", { runId: "second", content: toLogValue({ messageId: "user" }) }),
    event(5, "conversation.failed", { runId: "second", error: "new error" }),
  ]);
  expect(repository.messages.map(({ message }) => message.id)).toEqual(["user", "failed-first"]);
  expect(repository.messages[1]?.message.metadata).toMatchObject({ custom: { failure: "new error" } });
});

it("keeps descendants connected when replacing a synthetic failure", async () => {
  const repository = await restoreConversationRepository([
    event(1, "conversation.message", { content: toLogValue({ id: "user", role: "user", parts: [] }) }),
    event(2, "conversation.submitted", { runId: "first", content: toLogValue({ messageId: "user" }) }),
    event(3, "conversation.failed", { runId: "first", error: "old error" }),
    event(4, "conversation.message", { parentId: "failed-first", content: toLogValue({ id: "follow-up", role: "user", parts: [] }) }),
    event(5, "conversation.message", { parentId: "follow-up", content: toLogValue({ id: "follow-up-reply", role: "assistant", parts: [] }) }),
    event(6, "conversation.submitted", { runId: "second", content: toLogValue({ messageId: "user" }) }),
    event(7, "conversation.failed", { runId: "second", error: "new error" }),
  ]);
  expect(repository.messages.find(({ message }) => message.id === "follow-up")?.parentId).toBe("failed-first");
  expect(repository.headId).toBe("follow-up-reply");
  expect(branchMessages(repository, "follow-up-reply").map(({ id }) => id))
    .toEqual(["user", "failed-first", "follow-up", "follow-up-reply"]);
});

it("reconstructs an output-free abort as an interrupted response", async () => {
  const repository = await restoreConversationRepository([
    event(1, "conversation.message", { content: toLogValue({ id: "user", role: "user", parts: [] }) }),
    event(2, "conversation.submitted", { runId: "stopped", content: toLogValue({ messageId: "user" }) }),
    event(3, "conversation.aborted", { runId: "stopped" }),
  ]);
  expect(repository.messages[1]?.message).toMatchObject({ id: "failed-stopped", metadata: { custom: { interrupted: true } } });
});

it("keeps synthetic terminals in the repository but excludes them from model history", async () => {
  const events = [
    event(1, "conversation.message", { conversationId: "thread", content: toLogValue({ id: "user", role: "user", parts: [] }) }),
    event(2, "conversation.submitted", { conversationId: "thread", runId: "stopped", content: toLogValue({ messageId: "user" }) }),
    event(3, "conversation.aborted", { conversationId: "thread", runId: "stopped" }),
    event(4, "conversation.message", { conversationId: "thread", parentId: "failed-stopped", content: toLogValue({ id: "continued", role: "user", parts: [{ type: "text", text: "continue" }] }) }),
  ];
  const logger = { restorationEvents: async () => events } as unknown as EventLogger;
  expect((await restoreConversationRepository(events)).messages.map(({ message }) => message.id))
    .toEqual(["user", "failed-stopped", "continued"]);
  expect((await activeConversationMessages(logger, "thread")).map(({ id }) => id)).toEqual(["user", "continued"]);
});
