import { describe, expect, it } from "vitest";
import { restoreConversationRepository } from "./conversations";
import { rebuildConversationList, selectedConversationId, toLogValue, type LogEvent } from "./logging";

function event(id: number, type: string, options: Partial<LogEvent> = {}): LogEvent {
  return {
    id,
    type,
    timestamp: new Date(id * 1_000).toISOString(),
    content: null,
    ...options,
  };
}

describe("conversation restoration", () => {
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

  it("replays interrupted text and reconciles finished and unfinished tools", async () => {
    const conversationId = "thread-1";
    const runId = "run-1";
    const events = [
      event(1, "conversation.created", { conversationId, content: toLogValue({ title: "新对话" }) }),
      event(2, "conversation.message", {
        conversationId,
        runId,
        content: toLogValue({ id: "user-1", role: "user", parts: [{ type: "text", text: "检查页面" }] }),
      }),
      event(3, "conversation.submitted", { conversationId, runId, content: toLogValue({ messageId: "user-1" }) }),
      event(4, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "start", messageId: "assistant-1" }) }),
      event(5, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "text-start", id: "text-1" }) }),
      event(6, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "text-delta", id: "text-1", delta: "已经读取" }) }),
      event(7, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "tool-input-available", toolCallId: "done", toolName: "chrome", dynamic: true, input: { code: "return 1" } }) }),
      event(8, "tool.finished", { conversationId, runId, toolCallId: "done", output: toLogValue({ value: 1 }) }),
      event(9, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "tool-input-available", toolCallId: "pending", toolName: "chrome", dynamic: true, input: { code: "return 2" } }) }),
      event(10, "tool.started", { conversationId, runId, toolCallId: "pending" }),
      event(11, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "reasoning-start", id: "reasoning-1" }) }),
      event(12, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "reasoning-delta", id: "reasoning-1", delta: "先确认状态" }) }),
      event(13, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "tool-input-start", toolCallId: "partial", toolName: "chrome", dynamic: true }) }),
      event(14, "conversation.stream.chunk", { conversationId, runId, content: toLogValue({ type: "tool-input-delta", toolCallId: "partial", inputTextDelta: "{\"code\":\"ret" }) }),
      event(15, "conversation.aborted", { conversationId, runId }),
    ];

    const repository = await restoreConversationRepository(events);
    expect(repository.headId).toBe("assistant-1");
    expect(repository.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
    const assistant = repository.messages[1]!.message;
    expect(assistant.metadata).toMatchObject({ interrupted: true });
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "已经读取", state: "done" }),
      expect.objectContaining({ type: "reasoning", text: "先确认状态", state: "done" }),
      expect.objectContaining({ type: "dynamic-tool", toolCallId: "done", state: "output-available", output: { value: 1 } }),
      expect.objectContaining({ type: "dynamic-tool", toolCallId: "pending", state: "output-error" }),
    ]));
    expect(assistant.parts).not.toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "partial" })]));
  });
});
