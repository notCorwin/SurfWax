import { expect, it, vi } from "vitest";
import { restoreConversationRepository } from "../conversations";
import { EventLogger, type ConversationMessage, type LogEvent } from "../logging";
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

it("restores tool durations by run and call id without mixing repeated ids", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const conversationId = "timings";
  await logger.appendMessage(conversationId, { id: "question-1", role: "user", parts: [{ type: "text", text: "one" }] });
  for (const [runId, messageId, parentId, durationMs, incomplete] of [
    ["run-1", "reply-1", "question-1", 1234, false],
    ["run-2", "reply-2", "question-2", 25, true],
  ] as const) {
    if (runId === "run-2") await logger.appendMessage(conversationId, { id: "question-2", role: "user", parts: [{ type: "text", text: "two" }] }, { parentId: "reply-1" });
    await logger.appendMessage(conversationId, { id: messageId, role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "click", toolCallId: "same", state: "output-available", input: {}, output: { ok: true },
    }] }, { runId, parentId });
    await logger.append({ type: "tool.started", conversationId, runId, toolCallId: "same" });
    await logger.append({ type: "tool.finished", conversationId, runId, toolCallId: "same", latencyMs: durationMs, content: { timingIncomplete: incomplete } });
  }
  const runtime = new ConversationStore(logger, () => { throw new Error("Restoration must not request a model"); });
  await runtime.threads.switchToThread(conversationId);
  const parts = runtime.getState().thread.messages.flatMap((message) => message.parts.filter((part) => part.type === "tool-call"));
  expect(parts).toMatchObject([{ toolName: "click", startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number), durationMs: 1234, timingIncomplete: false }, { toolName: "click", startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number), durationMs: 25, timingIncomplete: true }]);
});

it("restores a disconnected run with its tool interruption and incomplete timing", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const conversationId = "interrupted-timing";
  await logger.appendMessage(conversationId, { id: "question", role: "user", parts: [{ type: "text", text: "run" }] });
  await logger.append({ type: "conversation.submitted", conversationId, runId: "lost", content: { messageId: "question" } });
  await logger.appendMessage(conversationId, { id: "partial", role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "click", toolCallId: "call", state: "input-available", input: {},
  }] }, { runId: "lost", parentId: "question" });
  await logger.append({ type: "tool.started", conversationId, runId: "lost", toolCallId: "call", content: { toolName: "click" } });
  await logger.recoverDanglingRuns([], "worker-restarted");
  const runtime = new ConversationStore(logger, () => { throw new Error("Restoration must not request a model"); });
  await runtime.threads.switchToThread(conversationId);
  const partial = runtime.getState().thread.messages.find((message) => message.id === "partial");
  expect(partial).toMatchObject({ runId: "lost", parts: [{ toolName: "click", durationMs: 0, timingIncomplete: true, interrupted: true }] });
  expect(events.find((event) => event.type === "conversation.aborted")?.content).toBeNull();
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

it("keeps a transport error visible when no canonical terminal was recorded", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const runtime = new ConversationStore(logger, () => ({
    async sendMessages() { throw new Error("运行已由另一个面板接管"); },
  }));
  await runtime.thread.append("hello");
  expect(runtime.getState().thread.error).toEqual(new Error("运行已由另一个面板接管"));
  expect(events.some((event) => event.type === "conversation.failed")).toBe(false);
});

it("does not duplicate a refreshed canonical failure when its synthetic message ID is reused", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const conversationId = "retry-failure";
  await logger.appendMessage(conversationId, { id: "question", role: "user", parts: [] });
  await logger.append({ type: "conversation.submitted", conversationId, runId: "first", content: { messageId: "question" } });
  await logger.append({ type: "conversation.failed", conversationId, runId: "first", content: null, error: "old" });
  const runtime = new ConversationStore(logger, () => ({
    async sendMessages() {
      await logger.append({ type: "conversation.submitted", conversationId, runId: "second", content: { messageId: "question" } });
      await logger.append({ type: "conversation.failed", conversationId, runId: "second", content: null, error: "new" });
      throw new Error("new");
    },
  }));
  await runtime.threads.switchToThread(conversationId);
  await runtime.thread.startRun({ parentId: "question" });
  expect(runtime.getState().thread.error).toBeUndefined();
  expect(runtime.getState().thread.messages.at(-1)?.status).toMatchObject({ reason: "error", error: "new" });
});

it("publishes complete transport snapshots while running and restores its returned message", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const snapshot: SidePanelMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "完整的模型响应" }] };
  const terminal: SidePanelMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "工具完成后的最终响应" }] };
  let release!: (message: SidePanelMessage) => void;
  const finalMessage = new Promise<SidePanelMessage>((resolve) => { release = resolve; });
  let submittedId = "";
  const runtime = new ConversationStore(logger, () => ({
    async sendMessages(options) {
      submittedId = options.messages.at(-1)!.id;
      await options.onMessage?.(snapshot);
      return finalMessage;
    },
  }), "snapshot-test");

  const running = runtime.thread.append("请执行操作");
  await vi.waitFor(() => expect(runtime.getState().thread.messages.at(-1)?.source.id).toBe("reply"));
  expect(runtime.getState().thread.isRunning).toBe(true);
  expect(runtime.getState().thread.messages.at(-1)?.parts).toMatchObject([{ type: "text", text: "完整的模型响应" }]);

  await logger.appendMessage("snapshot-test", terminal as ConversationMessage, { parentId: submittedId });
  release(terminal);
  await running;
  expect(runtime.getState().thread.isRunning).toBe(false);
  expect(runtime.getState().thread.messages.at(-1)?.parts).toMatchObject([{ type: "text", text: "工具完成后的最终响应" }]);
});

it("always clears running state when the failure baseline cannot be read", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  vi.spyOn(logger, "restorationEvents").mockRejectedValueOnce(new Error("IndexedDB unavailable"));
  const runtime = new ConversationStore(logger, () => { throw new Error("transport must not start"); });
  await runtime.thread.append("hello");
  expect(runtime.getState().thread.isRunning).toBe(false);
  expect(runtime.getState().thread.error).toEqual(new Error("IndexedDB unavailable"));
});

it("persists a submitted user turn before a pending failure baseline can be cancelled", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  await logger.append({ type: "conversation.created", conversationId: "existing", content: { title: "Existing" } });
  const runtime = new ConversationStore(logger, () => { throw new Error("transport must not start"); }, "existing");
  await runtime.threads.switchToThread("existing");
  let release!: () => void;
  const baseline = new Promise<void>((resolve) => { release = resolve; });
  const original = logger.restorationEvents.bind(logger);
  vi.spyOn(logger, "restorationEvents").mockImplementationOnce(async (...args) => { await baseline; return original(...args); });
  const running = runtime.thread.append("keep this turn");
  await vi.waitFor(() => expect(events.some((event) => event.type === "conversation.message")).toBe(true));
  runtime.thread.cancelRun();
  release();
  await running;
  expect(events.find((event) => event.type === "conversation.message")?.content).toMatchObject({ role: "user", parts: [{ text: "keep this turn" }] });
  expect(runtime.getState().thread.isRunning).toBe(false);
});
