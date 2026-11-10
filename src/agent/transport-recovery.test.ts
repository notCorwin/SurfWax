import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { EventLogger, fromLogValue, type ConversationMessage, type LogEvent } from "../logging";
import { createChatTransport, type SidePanelMessage } from "./transport";
import { createAgent } from "./runner";
import type { ChromeExecutor } from "../chrome/executor";
import { PROGRAM_CATALOG_VERSION } from "../chrome/tool";
import { restoreConversationRepository } from "../conversations";
import { browserJobsSettled } from "../../e2e/evaluation/job-evidence";
import { toolLifecycleEvidence } from "../../e2e/evaluation/tool-lifecycle";
import { createMemoryEventStore } from "../memory-event-store";
import { canAutoDispatchFollowup, rebuildFollowups } from "./followups";

vi.mock("./coordinator", () => ({ claimConversationRun: async (_id: string, signal?: AbortSignal) => ({ runId: crypto.randomUUID(), conversationId: _id, signal: signal ?? new AbortController().signal, finish: vi.fn() }) }));
function logger() {
  const events: LogEvent[] = [];
  return new EventLogger({ store: {
    async append(record) { const stored = { ...record, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
}
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text = "Recovered") => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const call = (id: string, url: string, toolName = "navigate") => ({ content: [{ type: "text" as const, text: "Ready to act" },
  { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify({ url }) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] });
const user: SidePanelMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] };
function setup(model: MockLanguageModelV4, log = logger(), executor = { browserContext: async () => ({ tabs: [] }), runProgram: vi.fn(async () => ({ ok: true })) }) {
  const factory = vi.fn(async (signal, _branchIds, _resumed, onResponse) => createAgent({
    model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model,
    executor: executor as unknown as ChromeExecutor, logger: log, conversationId: "thread", signal, onResponse,
  }));
  return { log, factory, executor };
}
const options = () => ({ trigger: "submit-message" as const, chatId: "thread", messages: [user], abortSignal: new AbortController().signal });

describe("complete-response transport", () => {
  it("retains the original failure when terminal reconciliation also fails", async () => {
    const log = logger();
    const original = new Error("agent failed");
    const reconciliation = new Error("log read failed");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(log, "closePendingTools").mockRejectedValue(reconciliation);
    const factory = vi.fn(async () => { throw original; });
    let caught: unknown;
    try { await createChatTransport(factory as never, log, "thread").sendMessages(options()); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ errors: [original, reconciliation], cause: original });
    expect(report).toHaveBeenCalledWith("[Surf Wax] conversation.terminal-failed", expect.objectContaining({ conversationId: "thread", runId: expect.any(String), error: expect.objectContaining({ errors: [expect.objectContaining({ message: "agent failed" }), expect.objectContaining({ message: "log read failed" })] }) }));
    report.mockRestore();
  });
  it("leaves a follow-up queued when its atomic submission fails, then dispatches it once on retry", async () => {
    const store = createMemoryEventStore();
    const batch = store.appendMany.bind(store);
    let rejectSubmission = true;
    const guardedStore = { ...store, async appendMany(events: readonly Omit<LogEvent, "id">[]) {
      if (rejectSubmission && events.some((event) => event.type === "conversation.followup.dispatched")) {
        rejectSubmission = false;
        throw new Error("transaction aborted");
      }
      return batch(events);
    } };
    const first = new EventLogger({ store: guardedStore });
    const queued = { id: "followup", text: "Next step", createdAt: "2026-01-01T00:00:00Z" };
    await first.append({ type: "conversation.followup.queued", conversationId: "thread", content: queued });
    const followup: SidePanelMessage = { id: "followup-message", role: "user", parts: [{ type: "text", text: queued.text }],
      metadata: { custom: { followupId: queued.id, followupMode: "followup" } } };
    const model = new MockLanguageModelV4({ doGenerate: async () => reply() });
    const firstRun = setup(model, first);
    await expect(createChatTransport(firstRun.factory, first, "thread").sendMessages({ ...options(), messages: [followup] })).rejects.toThrow("transaction aborted");
    expect(firstRun.factory).not.toHaveBeenCalled();
    const interrupted = await store.all();
    expect(interrupted.filter((event) => ["conversation.message", "conversation.followup.dispatched", "conversation.submitted"].includes(event.type))).toEqual([]);
    expect(rebuildFollowups(interrupted)).toEqual([queued]);

    const recovered = new EventLogger({ store: guardedStore });
    const retry = setup(model, recovered);
    await createChatTransport(retry.factory, recovered, "thread").sendMessages({ ...options(), messages: [followup] });
    const events = await store.all();
    expect(events.filter((event) => event.type === "conversation.followup.dispatched")).toHaveLength(1);
    expect(events.filter((event) => event.type === "conversation.submitted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "conversation.message" && (fromLogValue(event.content, event.valueEncoding) as { id?: string }).id === followup.id)).toHaveLength(1);
    expect(rebuildFollowups(events)).toEqual([]);
  });

  it("recovers an interrupted run after the follow-up transaction without redispatching the message", async () => {
    const store = createMemoryEventStore();
    const log = new EventLogger({ store });
    const queued = { id: "followup", text: "Next step", createdAt: "2026-01-01T00:00:00Z" };
    await log.append({ type: "conversation.followup.queued", conversationId: "thread", content: queued });
    await log.appendFollowupSubmission({ conversationId: "thread", runId: "interrupted-run", chatId: "thread", parentId: null,
      message: { id: "followup-message", role: "user", parts: [{ type: "text", text: queued.text }] }, followup: { id: queued.id, mode: "followup" } });
    const types = (await store.all()).slice(-3).map((event) => event.type);
    expect(types).toEqual(["conversation.message", "conversation.followup.dispatched", "conversation.submitted"]);
    const recovered = new EventLogger({ store });
    await recovered.recoverDanglingRuns([], "worker-restarted");
    const events = await recovered.conversation("thread");
    expect(rebuildFollowups(events)).toEqual([]);
    expect(canAutoDispatchFollowup(events)).toBe(false);
    const repository = await restoreConversationRepository(events);
    expect(repository.messages.some(({ message }) => message.id === "followup-message")).toBe(true);
    expect(repository.messages.some(({ parentId, message }) => parentId === "followup-message"
      && (message.metadata as { custom?: { syntheticTerminal?: boolean } } | undefined)?.custom?.syntheticTerminal === true)).toBe(true);
    expect(events.filter((event) => event.type === "conversation.aborted")).toHaveLength(1);
  });

  it("refuses a follow-up submission when the store cannot commit it atomically", async () => {
    const store = createMemoryEventStore();
    const { appendMany: _batch, ...nonAtomicStore } = store;
    const log = new EventLogger({ store: nonAtomicStore });
    await log.append({ type: "conversation.followup.queued", conversationId: "thread", content: { id: "f", text: "next", createdAt: "2026-01-01T00:00:00Z" } });
    await expect(log.appendFollowupSubmission({ conversationId: "thread", runId: "run", chatId: "thread", parentId: null,
      message: { id: "message", role: "user", parts: [] }, followup: { id: "f", mode: "followup" } })).rejects.toThrow("atomic conversation submission");
    expect((await store.all()).map((event) => event.type)).toEqual(["conversation.followup.queued"]);
  });

  it("prevents two loggers from dispatching the same queued message", async () => {
    const store = createMemoryEventStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "conversation.followup.queued", conversationId: "thread", content: { id: "f", text: "next", createdAt: "2026-01-01T00:00:00Z" } });
    const submission = (runId: string) => ({ conversationId: "thread", runId, chatId: "thread", parentId: null,
      message: { id: `message-${runId}`, role: "user" as const, parts: [] }, followup: { id: "f", mode: "followup" as const } });
    const results = await Promise.allSettled([first.appendFollowupSubmission(submission("one")), second.appendFollowupSubmission(submission("two"))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const events = await store.all();
    expect(events.filter((event) => event.type === "conversation.followup.dispatched")).toHaveLength(1);
    expect(events.filter((event) => event.type === "conversation.message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "conversation.submitted")).toHaveLength(1);
    const rejected = results[0]!.status === "rejected" ? first : second;
    await expect(rejected.append({ type: "test.after-stale-dispatch" })).resolves.toBeDefined();
  });
  it("returns rejected model calls as repair feedback and continues without dispatching them", async () => {
    const prompts: string[] = [];
    const { factory, executor, log } = setup(new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      if (prompts.length === 1) {
        const invalid = call("duplicate", "https://example.com/");
        return { ...invalid, content: [...invalid.content, invalid.content[1]!] };
      }
      return prompts.length === 2 ? call("repaired", "https://example.com/") : reply("Recovered task");
    } }));
    const result = await createChatTransport(factory, log, "thread").sendMessages(options());
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Tool-call protocol recovery:");
    expect(prompts[1]).toContain("before any tool");
    expect(executor.runProgram).toHaveBeenCalledOnce();
    const events = await log.all();
    expect(events.filter((event) => event.type === "tool.started").map((event) => event.toolCallId)).toEqual(["1:repaired"]);
    expect(events.some((event) => event.type === "model.request.retrying")).toBe(false);
    expect(events.at(-1)?.type).toBe("conversation.finished");
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Recovered task" })]));
  });

  it("sends recovered V2 BigInt tool results in the next model request", async () => {
    const log = logger();
    await log.appendMessage("thread", user as ConversationMessage, { runId: "old" });
    await log.append({ type: "conversation.submitted", conversationId: "thread", runId: "old", content: { messageId: user.id } });
    await log.appendMessage("thread", { id: "assistant-old", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "execute_program", toolCallId: "old-call", state: "input-available", input: { code: "return 123n" } }] } as ConversationMessage, { runId: "old", parentId: user.id });
    await log.append({ type: "tool.finished", conversationId: "thread", runId: "old", toolCallId: "old-call", output: { ok: true, result: { value: 123n, special: -0 } } });
    await log.append({ type: "conversation.failed", conversationId: "thread", runId: "old" });
    const restored = await restoreConversationRepository(await log.conversation("thread"));
    const messages = restored.messages.map(({ message }) => message as SidePanelMessage);
    messages.push({ id: "next", role: "user", parts: [{ type: "text", text: "Continue" }] });
    let prompt = "";
    const { factory } = setup(new MockLanguageModelV4({ doGenerate: async (request) => { prompt = JSON.stringify(request.prompt); return reply(); } }), log);
    await createChatTransport(factory, log, "thread").sendMessages({ ...options(), messages });
    expect(prompt).toContain('"bigintPaths"');
    expect(prompt).toContain('"123"');
    expect(prompt).toContain('"numberPaths"');
    expect(prompt).toContain('"-0"');
  });

  it("retains a failed SDK tool's readable error in the next model request", async () => {
    const log = logger();
    await log.appendMessage("thread", user as ConversationMessage, { runId: "old" });
    await log.append({ type: "conversation.submitted", conversationId: "thread", runId: "old", content: { messageId: user.id } });
    await log.appendMessage("thread", { id: "assistant-old", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "missing-tool", toolCallId: "old-call", state: "input-available", input: {} }] } as ConversationMessage, { runId: "old", parentId: user.id });
    class ProviderFailure extends Error { statusCode = 404; }
    const error = Object.assign(new ProviderFailure("No such tool: missing-tool"), { name: "NoSuchToolError" });
    Object.defineProperty(error, Symbol("sdk-marker"), { value: true, enumerable: true });
    await log.append({ type: "tool.failed", conversationId: "thread", runId: "old", toolCallId: "old-call", output: { ok: false, error }, error });
    await log.append({ type: "conversation.failed", conversationId: "thread", runId: "old" });
    const restored = await restoreConversationRepository(await log.conversation("thread"));
    const messages = restored.messages.map(({ message }) => message as SidePanelMessage);
    messages.push({ id: "next", role: "user", parts: [{ type: "text", text: "Continue" }] });
    let prompt = "";
    const { factory } = setup(new MockLanguageModelV4({ doGenerate: async (request) => { prompt = JSON.stringify(request.prompt); return reply(); } }), log);
    await createChatTransport(factory, log, "thread").sendMessages({ ...options(), messages });
    expect(prompt).toContain("missing-tool");
    expect(prompt).toContain("No such tool: missing-tool");
    expect(prompt).toContain("NoSuchToolError");
    expect(prompt).toContain("statusCode");
  });

  it.each(["response", "tool-start", "tool-result", "invalid-result"])("stops browser work when the canonical %s cannot be persisted", async (stage) => {
    const events: LogEvent[] = [];
    const failure = new Error("Canonical storage write failed");
    const log = new EventLogger({ store: {
      async append(record) {
        if (stage === "response" && record.type === "conversation.message" && (record.content as any)?.role === "assistant"
          || stage === "tool-start" && record.type === "tool.started"
          || stage === "tool-result" && record.type === "tool.finished"
          || stage === "invalid-result" && record.type === "tool.failed") throw failure;
        const saved = { ...record, id: events.length + 1 }; events.push(saved); return saved;
      },
      async all() { return [...events]; }, async clear() {},
    } });
    const { factory, executor } = setup(new MockLanguageModelV4({ doGenerate: async () => call("effect", "https://example.com/", stage === "invalid-result" ? "missing-tool" : "navigate") }), log);
    const cleanup = vi.fn(async () => undefined);
    await expect(createChatTransport(factory, log, "thread", cleanup).sendMessages(options())).rejects.toBe(failure);
    expect(executor.runProgram).toHaveBeenCalledTimes(stage === "tool-result" ? 1 : 0);
    expect(factory).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("publishes only complete responses and persists them before executing tools", async () => {
    let step = 0;
    const log = logger();
    const executor = { browserContext: async () => ({ tabs: [] }), runProgram: vi.fn(async () => {
      const saved = (await log.repository("thread")).messages.at(-1)!.message;
      expect(saved.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Ready to act", state: "done" }),
        expect.objectContaining({ toolCallId: "effect", state: "input-available", input: { url: "https://example.com/" } })]));
      return { ok: true };
    }) };
    const { factory } = setup(new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? call("effect", "https://example.com/") : reply() }), log, executor);
    const snapshots: SidePanelMessage[] = [];
    const result = await createChatTransport(factory, log, "thread").sendMessages({ ...options(), onMessage: (message) => { snapshots.push(message); } });
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Recovered", state: "done" }),
      expect.objectContaining({ toolCallId: "effect", state: "output-available", output: { ok: true, evidenceId: "effect" } })]));
    expect(snapshots[0]!.parts.some((part) => "toolCallId" in part && part.state === "input-available")).toBe(true);
    expect(snapshots.every((message) => message.parts.every((part) => !("state" in part) || part.state !== "streaming"))).toBe(true);
    expect((await log.all()).some((event) => event.type === "conversation.stream.chunk")).toBe(false);
  });

  it("records exactly one result for an invalid call before continuing", async () => {
    let step = 0;
    const { factory, executor, log } = setup(new MockLanguageModelV4({
      doGenerate: async () => ++step === 1 ? call("invalid", "https://example.com/", "missing-tool") : reply(),
    }));
    const result = await createChatTransport(factory, log, "thread").sendMessages(options());
    expect(executor.runProgram).not.toHaveBeenCalled();
    expect((await log.all()).filter((event) => event.toolCallId === "invalid" && ["tool.failed", "tool.finished"].includes(event.type)))
      .toMatchObject([{ type: "tool.failed", latencyMs: 0 }]);
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "invalid", state: "output-error" })]));
  });

  it.each([false, true])("distinguishes an SDK-rejected argument from a later unknown browser effect (%s)", async (effectUnknown) => {
    let step = 0;
    const executor = {
      browserContext: async () => ({ tabs: [] }),
      inspect: vi.fn(async () => ({ observationId: "observed", items: [], truncation: { truncated: false } })),
      runProgram: vi.fn(async () => ({ ok: false, error: { code: "response-lost", message: "Response lost after dispatch", effectUnknown: true } })),
    };
    const { factory, log } = setup(new MockLanguageModelV4({ doGenerate: async () => {
      if (++step === 1) return {
        content: [{ type: "tool-call" as const, toolCallId: "bad-arguments", toolName: "click", input: JSON.stringify({
          target: { by: "role", value: "button", name: "Approve" }, frame: { by: "css", value: "iframe" },
        }) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
      };
      if (step === 2) return effectUnknown ? call("later-action", "https://example.com/") : {
        content: [{ type: "tool-call" as const, toolCallId: "later-observation", toolName: "inspect_page", input: "{}" }],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
      };
      return reply("Checked the result");
    } }), undefined, executor);
    await createChatTransport(factory, log, "thread").sendMessages(options());
    const events = await log.all();
    const rejected = events.filter((event) => event.toolCallId === "bad-arguments" && ["tool.failed", "tool.finished"].includes(event.type));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.type).toBe("tool.failed");
    expect(fromLogValue(rejected[0]!.content, rejected[0]!.valueEncoding)).toMatchObject({ toolName: "click", dispatched: false });
    const error = fromLogValue(rejected[0]!.error, rejected[0]!.valueEncoding) as { code: string; message: string; effectUnknown: boolean; cause: { name: string; message: string } };
    expect(error).toMatchObject({ code: "invalid-tool-input", effectUnknown: false });
    expect(error.message).toContain("frame");
    expect(error.cause.name).toContain("InvalidToolInputError");
    expect(error.cause.message).toContain("frame");
    expect(events.some((event) => event.type === "tool.started" && event.toolCallId === "bad-arguments")).toBe(false);
    expect(executor.runProgram).toHaveBeenCalledTimes(effectUnknown ? 1 : 0);
    expect(browserJobsSettled(events)).toBe(effectUnknown ? null : true);
    expect(toolLifecycleEvidence(events)).toMatchObject({ complete: true, started: 1, declaredCalls: 2,
      unstartedFailures: 1, missingDeclaredTerminals: 0, missingTerminals: 0, duplicateTerminals: 0 });
  });

  it("recovers a missing invalid-call result after a one-time terminal write failure", async () => {
    const log = logger();
    const append = log.append.bind(log);
    const failure = new Error("Temporary terminal write failure");
    let rejected = false;
    vi.spyOn(log, "append").mockImplementation((record) => {
      if (record.type === "tool.failed" && !rejected) { rejected = true; return Promise.reject(failure); }
      return append(record);
    });
    const { factory, executor } = setup(new MockLanguageModelV4({ doGenerate: async () => call("invalid", "https://example.com/", "missing-tool") }), log);
    await expect(createChatTransport(factory, log, "thread").sendMessages(options())).rejects.toBe(failure);
    expect(executor.runProgram).not.toHaveBeenCalled();
    expect((await log.all()).filter((event) => event.toolCallId === "invalid" && event.type === "tool.failed")).toHaveLength(1);
    expect((await log.all()).filter((event) => event.type === "conversation.failed")).toHaveLength(1);
  });

  it("refreshes canonical metadata and the agent after context overflow", async () => {
    const log = logger();
    await log.appendMessage("thread", user as ConversationMessage);
    const requests: unknown[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async (request) => {
      requests.push(request.prompt);
      if (requests.length === 1) throw Object.assign(new Error("maximum context length exceeded"), { statusCode: 400 });
      return reply();
    } });
    const { factory } = setup(model, log);
    const summarize = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      await log.append({ type: "context.compacted", conversationId: "thread", content: { summary: "Saved summary" } });
    });
    const cleanup = vi.fn(async () => undefined);
    const result = await createChatTransport(factory, log, "thread", cleanup, summarize).sendMessages(options());
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Recovered" })]));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map((entry) => entry[2])).toEqual([false, true]);
    expect(summarize).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await log.all()).filter((event) => event.type === "conversation.finished")).toHaveLength(1);
    expect(fromLogValue((await log.contextEvents("thread"))[0]!.content)).toMatchObject({ prompt: { catalogVersion: PROGRAM_CATALOG_VERSION } });
  });

  it("resumes from completed tool results after a response-body failure without repeating the effect", async () => {
    let request = 0;
    const prompts: string[] = [];
    const { factory, executor, log } = setup(new MockLanguageModelV4({ doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      if (++request === 1) return call("effect", "https://example.com/");
      if (request === 2) throw new TypeError("Response body connection lost");
      return reply();
    } }));
    await createChatTransport(factory, log, "thread").sendMessages(options());
    expect(request).toBe(3);
    expect(executor.runProgram).toHaveBeenCalledOnce();
    expect(prompts[2]).toContain('"toolCallId":"effect"');
    expect(prompts[2]).toContain('"ok":true');
    expect((await log.all()).filter((event) => event.type === "tool.finished")).toHaveLength(1);
    expect((await log.all()).filter((event) => event.type === "model.request.retrying")).toMatchObject([{ retry: { attempt: 1, reason: "request-failed" } }]);
  });

  it("rejects permanent errors and releases the run exactly once", async () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const { factory, log } = setup(new MockLanguageModelV4({ doGenerate: async () => { throw error; } }));
    const cleanup = vi.fn(async () => undefined);
    await expect(createChatTransport(factory, log, "thread", cleanup).sendMessages(options())).rejects.toBe(error);
    expect(factory).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await log.all()).filter((event) => event.type === "conversation.failed")).toHaveLength(1);
    expect((await log.repository("thread")).messages.map((entry) => entry.message.id)).toEqual(["user"]);
  });

  it("aborts a waiting request without publishing an unfinished response", async () => {
    const controller = new AbortController();
    const { factory, log } = setup(new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
      return new Promise((_resolve, reject) => { abortSignal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }); });
    } }));
    const task = createChatTransport(factory, log, "thread").sendMessages({ ...options(), abortSignal: controller.signal });
    const failure = expect(task).rejects.toThrow();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    controller.abort();
    await failure;
    expect((await log.all()).filter((event) => event.type === "conversation.aborted")).toHaveLength(1);
    expect((await log.repository("thread")).messages.map((entry) => entry.message.id)).toEqual(["user"]);
  });
});
