import { expect, it, vi } from "vitest";
import { claimConversationRun } from "../agent/coordinator";
import { restoreConversationRepository } from "../conversations";
import { EventLogger, type ConversationMessage, type LogEvent } from "../logging";
import { ConversationStore, createMessageProjection } from "./conversation-store";
import type { SidePanelMessage } from "../agent/transport";

it("keeps a queued follow-up out of the message log until transport claims it, while preserving normal prewrites", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
  const seen: string[][] = [];
  const runtime = new ConversationStore(logger, () => ({ async sendMessages() {
    seen.push((await logger.all()).filter((event) => event.type === "conversation.message").map((event) => event.type));
    throw new Error("stopped before submission");
  } }));
  await runtime.thread.append({ role: "user", content: [{ type: "text", text: "queued" }],
    metadata: { custom: { followupId: "f", followupMode: "followup" } } });
  expect(seen[0]).toEqual([]);
  await runtime.thread.append("normal message");
  expect(seen[1]).toEqual(["conversation.message"]);
});

it("does not expose an outdated conversation load failure after a later switch", async () => {
  const logger = new EventLogger({ store: {
    async append(event) { return { ...event, id: 1 }; },
    async all() { return []; },
    async clear() {},
  } });
  let rejectOld!: (error: Error) => void;
  const pending = new Promise<LogEvent[]>((_resolve, reject) => { rejectOld = reject; });
  vi.spyOn(logger, "restorationEvents").mockImplementation((id) => id === "old" ? pending : Promise.resolve([]));
  const runtime = new ConversationStore(logger, () => { throw new Error("Unexpected model request"); });
  const old = runtime.threads.switchToThread("old");
  await runtime.threads.switchToThread("new");
  rejectOld(new Error("old load failed"));
  await expect(old).rejects.toThrow("old load failed");
  expect(runtime.getState().threadListItem.id).toBe("new");
  expect(runtime.getState().thread.error).toBeUndefined();
  expect(runtime.getState().thread.isLoading).toBe(false);
});

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
  await vi.waitFor(() => expect(runtime.getState().threads.threadIds).toContain("external"));

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
  expect(runtime.getState().thread.messages[1]?.userBranch).toEqual({ id: "edited", number: 2, count: 2 });
  await runtime.thread.getMessageById("edited").switchToBranch({ position: "previous" });
  expect(runtime.getState().thread.messages.map(({ id }) => id)).toEqual(["question", "original"]);
  expect(runtime.getState().thread.messages[1]?.userBranch).toEqual({ id: "question", number: 1, count: 2 });
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

it("reports a failed regeneration that produced no reply while preserving the original reply", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  const conversationId = "failed-regeneration";
  await logger.appendMessage(conversationId, { id: "question", role: "user", parts: [{ type: "text", text: "hello" }] });
  await logger.appendMessage(conversationId, { id: "reply", role: "assistant", parts: [{ type: "text", text: "original" }] }, { parentId: "question" });
  const failure = new Error("provider rejected regeneration");
  const runtime = new ConversationStore(logger, () => ({
    async sendMessages() {
      await logger.append({ type: "conversation.submitted", conversationId, runId: "retry", content: { messageId: "question" } });
      await logger.append({ type: "conversation.failed", conversationId, runId: "retry", content: null, error: failure });
      throw failure;
    },
  }));
  await runtime.threads.switchToThread(conversationId);
  await runtime.thread.getMessageById("reply").reload();
  expect(runtime.getState().thread.messages.map(({ id }) => id)).toEqual(["question", "reply"]);
  expect(runtime.getState().thread.error).toBe(failure);
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

it("does not write a user turn when cancelled while replaying the canonical branch", async () => {
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
  await vi.waitFor(() => expect(logger.restorationEvents).toHaveBeenCalled());
  expect(events.some((event) => event.type === "conversation.message")).toBe(false);
  runtime.thread.cancelRun();
  release();
  await running;
  expect(events.some((event) => event.type === "conversation.message")).toBe(false);
  expect(runtime.getState().thread.isRunning).toBe(false);
});

it("restores response time for each reasoning part without retiming earlier steps", async () => {
  const events: LogEvent[] = [];
  let time = 0;
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, timestamp: new Date(time).toISOString(), id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
  } });
  const conversationId = "reasoning-times", runId = "run";
  await logger.appendMessage(conversationId, { id: "user", role: "user", parts: [{ type: "text", text: "go" }] });
  const reply: SidePanelMessage = { id: "reply", role: "assistant", parts: [{ type: "step-start" }, { type: "reasoning", text: "first" }, { type: "reasoning", text: "same response" }] };
  await logger.append({ type: "model.request.started", conversationId, runId, content: { callId: "call" } });
  time = 1234;
  await logger.append({ type: "model.response.received", conversationId, runId, content: { callId: "call" } });
  await logger.appendMessage(conversationId, reply as ConversationMessage, { runId, parentId: "user" });
  time = 5000;
  await logger.append({ type: "model.request.started", conversationId, runId, content: { callId: "call" } });
  time = 8250;
  await logger.append({ type: "model.response.received", conversationId, runId, content: { callId: "call" } });
  reply.parts.push({ type: "step-start" }, { type: "reasoning", text: "second response" });
  await logger.appendMessage(conversationId, reply as ConversationMessage, { runId, parentId: "user" });
  // A response without a valid start must not reuse a previous request's time.
  await logger.append({ type: "model.response.received", conversationId, runId, content: { callId: "call" } });
  reply.parts.push({ type: "step-start" }, { type: "reasoning", text: "unknown" });
  await logger.appendMessage(conversationId, reply as ConversationMessage, { runId, parentId: "user" });
  const runtime = new ConversationStore(logger, () => { throw new Error("Restoration must not request a model"); });
  await runtime.threads.switchToThread(conversationId);
  const parts = runtime.getState().thread.messages.at(-1)!.parts;
  expect(parts.map((part) => part.type === "reasoning" ? part.responseTimeMs : undefined)).toEqual([1234, 1234, 3250, undefined]);
  expect(parts[0]).toMatchObject({ responseTimingId: expect.any(Number) });
  expect(parts[1]).toMatchObject({ responseTimingId: (parts[0] as { responseTimingId: number }).responseTimingId });
});

it("never reuses missing or mismatched response timing in live updates or restoration", async () => {
  const events: LogEvent[] = [];
  let time = 0;
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, timestamp: new Date(time).toISOString(), id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
  } });
  const conversationId = "missing-times", runId = "run";
  let runtime!: ConversationStore;
  const durations = () => runtime.getState().thread.messages.at(-1)!.parts.map((part) => part.type === "reasoning" ? part.responseTimeMs : undefined);
  runtime = new ConversationStore(logger, () => ({ async sendMessages(options) {
    const reply: SidePanelMessage = { id: "reply", role: "assistant", parts: [] };
    const record = async (type: string, callId: string, timestamp: number) => {
      time = timestamp;
      await logger.append({ type, conversationId, runId, content: { callId } });
    };
    const publish = async () => {
      reply.parts.push({ type: "reasoning", text: `part-${reply.parts.length}` });
      const snapshot = { ...reply, parts: [...reply.parts] };
      await logger.appendMessage(conversationId, snapshot as ConversationMessage, { runId, parentId: options.messages.at(-1)!.id });
      await options.onMessage?.(snapshot);
    };
    await record("model.request.started", "first", 0);
    await record("model.response.received", "first", 100);
    await publish();
    // No lifecycle events for the next response.
    await publish();
    await record("model.request.started", "second", 200);
    await record("model.response.received", "different-call", 350);
    await publish();
    await record("model.request.started", "unfinished", 400);
    await publish();
    // Even the same call id must not match a start from before that publication.
    await record("model.response.received", "unfinished", 800);
    await publish();
    await record("model.request.started", "negative", 1000);
    await record("model.response.received", "negative", 900);
    await publish();
    expect(durations()).toEqual([100, undefined, undefined, undefined, undefined, undefined]);
    return reply;
  } }), conversationId);
  const disconnect = runtime.connect();
  try {
    await runtime.threads.reload();
    await runtime.thread.append("go");
    expect(durations()).toEqual([100, undefined, undefined, undefined, undefined, undefined]);
  } finally { disconnect(); }
});


it("rejects a competing submission before any durable conversation change", async () => {
  const { testEventStore } = await import("../test-event-store");
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: testEventStore(events) });
  const transport = vi.fn();
  const runtime = new ConversationStore(logger, transport);
  const owner = await claimConversationRun("other");
  try {
    await runtime.thread.append("must not become a branch");
    expect(events).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.getState().thread.error).toBeInstanceOf(Error);
    expect(runtime.getState().thread.isRunning).toBe(false);
  } finally { owner.finish(); logger.dispose(); }
});

it("replays another writer's new head under the lease before appending", async () => {
  const { testEventStore } = await import("../test-event-store");
  const events: LogEvent[] = [];
  const storage = testEventStore(events);
  const logger = new EventLogger({ store: storage });
  const other = new EventLogger({ store: storage });
  await logger.append({ type: "conversation.created", conversationId: "shared", content: { title: "Shared" } });
  await logger.appendMessage("shared", { id: "u", role: "user", parts: [{ type: "text", text: "old" }] });
  const seen: string[][] = [];
  const runtime = new ConversationStore(logger, () => ({ async sendMessages(options) {
    seen.push(options.messages.map(message => message.id));
    expect(options.runLease?.conversationId).toBe("shared");
    return { id: "unused", role: "assistant", parts: [] };
  } }), "shared");
  await runtime.threads.switchToThread("shared");
  // Even without a connected live subscription, command input comes from the log.
  await other.appendMessage("shared", { id: "remote", role: "assistant", parts: [{ type: "text", text: "new progress" }] }, { parentId: "u" });
  await runtime.thread.append("continue");
  expect(seen[0]?.slice(0, 2)).toEqual(["u", "remote"]);
  const repository = await logger.repository("shared");
  expect(repository.messages.at(-1)?.parentId).toBe("remote");
  logger.dispose(); other.dispose();
});

it("retains the draft and rejects a deleted session before any new write even without commit delivery", async () => {
  const { testEventStore } = await import("../test-event-store");
  const events: LogEvent[] = [];
  const storage = testEventStore(events);
  const logger = new EventLogger({ store: storage });
  const other = new EventLogger({ store: storage });
  await logger.append({ type: "conversation.created", conversationId: "deleted", content: { title: "Deleted" } });
  const transport = vi.fn();
  const runtime = new ConversationStore(logger, transport, "deleted");
  await runtime.threads.switchToThread("deleted");
  await other.deleteConversation("deleted");
  await logger.flush();
  const count = events.length;
  runtime.composer.setText("preserve this draft");
  await runtime.composer.send();
  expect(events).toHaveLength(count);
  expect(transport).not.toHaveBeenCalled();
  expect(runtime.getState().composer.text).toBe("preserve this draft");
  expect(String(runtime.getState().thread.error)).toContain("已被删除");
  await expect(runtime.threads.switchToThread("deleted")).rejects.toThrow("已被删除");
  await logger.dispose(); await other.dispose();
});

it("does not lose a commit arriving between list drain completion and promise cleanup", async () => {
  const { testEventStore } = await import("../test-event-store");
  const logger = new EventLogger({ store: testEventStore() });
  let committed: Parameters<Parameters<EventLogger['subscribeCommits']>[0]>[0] | undefined;
  let notify!: Parameters<EventLogger['subscribeCommits']>[0];
  vi.spyOn(logger, 'subscribeCommits').mockImplementation(listener => { notify = listener; return () => {}; });
  const event: LogEvent = { id: 1, type: 'conversation.created', conversationId: 'tail', timestamp: new Date().toISOString(), content: { title: 'Tail' } };
  const read = vi.spyOn(logger, 'summaryEventsSince').mockImplementationOnce(async () => {
    queueMicrotask(() => queueMicrotask(() => {
      committed = { lastId: 1, conversationIds: ['tail'], external: true, cleared: false, types: ['conversation.created'] };
      notify(committed);
    }));
    return { value: [], epoch: 'one' };
  }).mockResolvedValue({ value: [event], epoch: 'one' });
  const runtime = new ConversationStore(logger, vi.fn());
  const close = runtime.connect();
  await vi.waitFor(() => expect(runtime.getState().threads.threadIds).toContain('tail'));
  expect(read).toHaveBeenCalledTimes(2);
  await logger.append({ type: 'browser.diagnostic', content: 'irrelevant' });
  expect(read).toHaveBeenCalledTimes(2);
  close(); await logger.dispose();
});
