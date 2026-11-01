import { MockLanguageModelV4 } from "ai/test";
import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it, vi } from "vitest";
import type { ChromeExecutor } from "../chrome/executor";
import { EventLogger, type LogEvent } from "../logging";
import { createAgent } from "./runner";
import { activeContext, IncrementalActiveContext } from "./context-choice";
import { createChatTransport, type SidePanelMessage } from "./transport";
import { GOAL_SCHEMA, localEvidence, releaseRunEvidence, runEvidence, validateGoal, type Goal } from "./goal-completion";

vi.mock("./coordinator", () => ({ claimConversationRun: async (_id: string, signal?: AbortSignal) => ({
  signal: signal ?? new AbortController().signal, finish: vi.fn(),
}) }));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const call = (id: string, name: string, input: unknown) => ({ type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) });
const calls = (...content: ReturnType<typeof call>[]) => ({ content, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] });
const user: SidePanelMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Work on the goal" }] };
function fixture(model: MockLanguageModelV4, executorExtra: object = {}) {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: { async append(record) { const event = { ...record, id: events.length + 1 }; events.push(event); return event; }, async all() { return [...events]; }, async clear() { events.length = 0; } } });
  const executor = { browserContext: async () => ({ tabs: [] }), ...executorExtra } as unknown as ChromeExecutor;
  const factory = (signal: AbortSignal, _ids: string[], _resumed?: boolean, onResponse?: any, shouldYield?: () => boolean) => createAgent({
    model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model, executor, logger, conversationId: "thread", signal, onResponse, shouldYield, goalMode: true,
  });
  return { events, logger, factory };
}
const options = () => ({ trigger: "submit-message" as const, chatId: "thread", messages: [user] });

describe("goal mode", () => {
  it("sends a root object schema in an OpenAI Responses function and validates each goal variant", async () => {
    const requests: any[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "response", object: "response", created_at: 1, model: "test", status: "completed",
        output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    });
    const languageModel = createOpenAI({ apiKey: "key", baseURL: "https://provider.test/v1", fetch }).responses("test");
    const executor = { browserContext: async () => ({ tabs: [] }) } as unknown as ChromeExecutor;
    await createAgent({ model: { providerId: "openai", sdk: "@ai-sdk/openai", baseURL: "https://provider.test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel, executor, goalMode: true }).generate({ prompt: "hello" });
    const parameters = requests[0].tools.find((tool: any) => tool.name === "complete_goal").parameters;
    expect(parameters.type).toBe("object");
    expect(parameters.anyOf).toBeUndefined();
    const answer = { taskType: "answer", status: "completed", summary: "Done" };
    const browser = { taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: "id", observation: "Observed" }] };
    const blocked = { ...browser, status: "blocked", dependency: "authentication", userAction: "Sign in", attemptedRecovery: [{ toolCallId: "id", action: "Checked" }] };
    for (const value of [answer, browser, blocked]) expect(GOAL_SCHEMA.safeParse(value).success).toBe(true);
    for (const value of [{ ...answer, status: "blocked" }, { ...answer, evidence: browser.evidence }, { ...browser, evidence: undefined },
      { ...browser, dependency: "authentication" }, { ...blocked, attemptedRecovery: undefined }, { ...browser, extra: true }])
      expect(GOAL_SCHEMA.safeParse(value).success).toBe(false);
  });

  it("projects only minimal evidence, incrementally reuses it, and rebuilds after matching release", async () => {
    const { logger } = fixture(new MockLanguageModelV4({ doGenerate: async () => reply("done") }));
    const huge = "large payload ".repeat(100_000);
    await logger.append({ type: "tool.finished", conversationId: "thread", runId: "run", toolCallId: "read", content: { toolName: "inspect_page" }, output: { ok: true, result: huge } });
    const first = await runEvidence(logger, "thread", "run");
    expect(first).toEqual([{ id: "read", name: "inspect_page", success: true, effectUnknown: false, order: expect.any(Number) }]);
    expect(JSON.stringify(first)).not.toContain("large payload");
    await logger.append({ type: "tool.failed", conversationId: "thread", runId: "run", toolCallId: "1:write", content: { toolName: "click" }, output: { ok: false, error: { effectUnknown: true }, result: huge } });
    expect(await runEvidence(logger, "thread", "run")).toHaveLength(2);
    releaseRunEvidence(logger, "thread", "other-run");
    expect(await runEvidence(logger, "thread", "run")).toHaveLength(2);
    releaseRunEvidence(logger, "thread", "run");
    expect(await runEvidence(logger, "thread", "run")).toEqual(expect.arrayContaining(first));
  });

  it("validates browser evidence, blockers, unknown effects, and the pure answer exception", () => {
    const goal = (id: string): Goal => ({ taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: id, observation: "Observed" }] });
    const answer: Goal = { taskType: "answer", status: "completed", summary: "An answer" };
    const good = localEvidence("observed", "inspect_page", { ok: true, result: "page" }, 1);
    const failed = localEvidence("failed", "click", { ok: false, error: { retryable: true } }, 2);
    const unknown = localEvidence("unknown", "click", { ok: false, error: { effectUnknown: true } }, 3);
    const falseVerification = localEvidence("false", "verify_state", { ok: true, result: { verified: false } }, 4);
    const verified = localEvidence("verified", "verify_state", { ok: true, result: { verified: true } }, 5);
    const dispatch = localEvidence("dispatch", "click", { ok: true }, 2);
    const noVerification = localEvidence("no-verification", "verify_state", { ok: true, result: {} }, 6);
    const wrapped = localEvidence("wrapped", "verify_state", { ok: true, envelopeWrapped: true, result: { result: { verified: true } } }, 7);
    const compacted = localEvidence("compact", "verify_state", { ok: true, verification: { verified: true }, $ref: 100 }, 8);
    const network = localEvidence("network", "read_response", { ok: true, result: "confirmed" }, 9);
    expect(validateGoal(answer, [])).toBeUndefined();
    expect(validateGoal(answer, [good])).toContain("no browser work");
    expect(validateGoal(goal("missing"), [good])).toContain("this run");
    expect(validateGoal(goal("failed"), [failed])).toContain("successful terminal");
    expect(validateGoal(goal("false"), [falseVerification])).toContain("successful terminal");
    expect(validateGoal(goal("no-verification"), [noVerification])).toContain("successful terminal");
    expect(validateGoal(goal("dispatch"), [dispatch])).toContain("successful observation");
    expect(validateGoal(goal("observed"), [good, unknown])).toContain("unknown");
    expect(validateGoal(goal("verified"), [good, unknown, verified])).toContain("unknown");
    const resolved = (id: string, target: string): Goal => ({ taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: id, observation: "Outcome checked", resolves: [target] }] });
    expect(validateGoal(resolved("verified", "unknown"), [good, unknown, verified])).toBeUndefined();
    expect(validateGoal(resolved("wrapped", "unknown"), [unknown, wrapped])).toBeUndefined();
    expect(validateGoal(resolved("compact", "unknown"), [unknown, compacted])).toBeUndefined();
    expect(validateGoal(resolved("network", "unknown"), [unknown, network])).toBeUndefined();
    expect(validateGoal(resolved("network", "missing"), [unknown, network])).toContain("earlier unknown effect");
    expect(validateGoal(resolved("observed", "unknown"), [good, unknown])).toContain("later successful observation");
    expect(validateGoal(resolved("dispatch", "unknown"), [unknown, dispatch])).toContain("later successful observation");
    const other = localEvidence("other", "click", { ok: false, error: { effectUnknown: true } }, 4);
    expect(validateGoal(resolved("network", "unknown"), [unknown, other, network])).toContain("other");
    const blocked: Goal = { taskType: "browser", status: "blocked", summary: "Sign in", dependency: "authentication", userAction: "Sign in",
      attemptedRecovery: [{ toolCallId: "observed", action: "Checked the session" }], evidence: [{ toolCallId: "observed", observation: "Login page" }] };
    expect(validateGoal(blocked, [good])).toBeUndefined();
    expect(validateGoal({ ...blocked, evidence: [{ toolCallId: "dispatch", observation: "Clicked" }], attemptedRecovery: [{ toolCallId: "dispatch", action: "Clicked" }] }, [dispatch])).toContain("successful observation");
    expect(validateGoal({ ...blocked, evidence: [{ toolCallId: "failed", observation: "Timeout" }] }, [failed])).toBeDefined();
    expect(validateGoal({ ...blocked, attemptedRecovery: [{ toolCallId: "invented", action: "Tried" }] }, [good])).toContain("actual terminal");
  });

  it.each([true, false])("uses local evidence with a logger but without canonical run identity (conversationId=%s)", async (withConversation) => {
    let count = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++count === 1) return calls(call("read", "inspect_page", {}));
      if (count === 2) return calls(call("answer", "complete_goal", { taskType: "answer", status: "completed", summary: "Done" }));
      return calls(call("done", "complete_goal", { taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: "read", observation: "Page checked" }] }));
    } });
    const { logger, events } = fixture(model);
    const executor = { browserContext: async () => ({ tabs: [] }), inspect: async () => ({ snapshot: "page" }) } as unknown as ChromeExecutor;
    const agent = createAgent({ model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model, executor, logger,
      ...(withConversation ? { conversationId: "thread" } : {}), goalMode: true });
    await agent.generate({ prompt: "Inspect the page" });
    expect(count).toBe(3);
    expect(events.find((event) => event.type === "tool.failed" && event.toolCallId === "answer")?.output).toMatchObject({ error: { code: "goal-evidence-invalid" } });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "done")?.output).toMatchObject({ ok: true });
  });

  it("carries canonical evidence through automatic continuation and rejects previous-run evidence", async () => {
    let count = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      count++;
      if (count === 1) return calls(call("read", "inspect_page", {}));
      if (count === 2) return reply("Checking the outcome");
      if (count === 3) return calls(call("invalid", "complete_goal", { taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: "old", observation: "old" }] }));
      return calls(call("done", "complete_goal", { taskType: "browser", status: "completed", summary: "Done", evidence: [{ toolCallId: "read", observation: "Page observed" }] }));
    } });
    const { events, logger, factory } = fixture(model, { inspect: async () => ({ snapshot: "page" }) });
    await logger.append({ type: "tool.finished", conversationId: "thread", runId: "previous", toolCallId: "old", content: { toolName: "inspect_page" }, output: { ok: true } });
    await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages(options());
    expect(count).toBe(4);
    expect(events.find((event) => event.type === "tool.failed" && event.toolCallId?.endsWith("invalid"))?.output).toMatchObject({ error: { code: "goal-evidence-invalid" } });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId?.endsWith("done"))?.output).toMatchObject({ ok: true });
  });

  it("continues after repeated text and finishes only after a successful completion tool, publishing its summary", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      if (prompts.length < 3) return reply(`Progress ${prompts.length}`);
      return calls(call("done", "complete_goal", { taskType: "answer", status: "completed", summary: "Finished the task." }));
    } });
    const { events, logger, factory } = fixture(model);
    const result = await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages(options());
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("Progress 1");
    expect(prompts[2]).toContain("Progress 2");
    expect(prompts[2]!.match(/Goal mode is still active/g)).toHaveLength(2);
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Finished the task." })]));
    expect(events.filter((event) => event.type === "agent.goal.continued")).toHaveLength(2);
    expect(events.find((event) => event.type === "tool.finished")).toMatchObject({ toolCallId: "2:done", output: { ok: true, summary: "Finished the task." } });
    expect(events.at(-1)?.type).toBe("conversation.finished");
    const saved = (await logger.repository("thread")).messages.find(({ message }) => message.id === result.id)?.message;
    expect(saved?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Finished the task." })]));
    const active = await activeContext(logger, "thread");
    expect(JSON.stringify(active.raw)).toContain("Progress 1");
    expect(JSON.stringify(active.raw).match(/Goal mode is still active/g)).toHaveLength(2);
    expect((await new IncrementalActiveContext(logger, "thread").read()).messages).toEqual(active.messages);
    const ordinaryPrompts: string[] = [];
    const ordinaryModel = new MockLanguageModelV4({ doGenerate: async ({ prompt, tools }) => {
      ordinaryPrompts.push(JSON.stringify(prompt));
      expect(tools?.some((item) => item.name === "complete_goal")).toBe(false);
      return reply("Normal reply");
    } });
    const ordinaryExecutor = { browserContext: async () => ({ tabs: [] }) } as unknown as ChromeExecutor;
    const ordinaryFactory = (signal: AbortSignal, _ids: string[], _resumed?: boolean, onResponse?: any, shouldYield?: () => boolean) => createAgent({
      model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: ordinaryModel,
      executor: ordinaryExecutor, logger, conversationId: "thread", signal, onResponse, shouldYield,
    });
    const nextUser: SidePanelMessage = { id: "next", role: "user", parts: [{ type: "text", text: "Continue normally" }] };
    await createChatTransport(ordinaryFactory, logger, "thread").sendMessages({ ...options(), messages: [user, result, nextUser] });
    expect(ordinaryPrompts).toHaveLength(1);
    expect(ordinaryPrompts[0]!.match(/Goal mode is still active/g)).toHaveLength(2);
    expect(ordinaryPrompts[0]).toContain("Finished the task.");
  });

  it("rejects completion alongside other calls or while jobs are pending", async () => {
    let count = 0;
    let pending = false;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      count++;
      if (count === 1) return calls(call("parallel", "complete_goal", { taskType: "answer", status: "completed", summary: "too soon" }), call("read", "inspect_page", {}));
      if (count === 2) { pending = true; return calls(call("pending", "complete_goal", { taskType: "answer", status: "completed", summary: "too soon" })); }
      pending = false;
      return calls(call("done", "complete_goal", { taskType: "browser", status: "blocked", summary: "Need a login.", dependency: "authentication", userAction: "Sign in", attemptedRecovery: [{ toolCallId: "read", action: "Check session" }], evidence: [{ toolCallId: "read", observation: "Login required" }] }));
    } });
    const { events, logger, factory } = fixture(model, { pendingBackgroundJobs: () => pending ? ["job"] : [], inspect: async () => ({ snapshot: "page" }) });
    const result = await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages(options());
    expect(count).toBe(3);
    expect(events.filter((event) => event.type === "tool.failed").map((event) => event.toolCallId)).toEqual(expect.arrayContaining(["parallel", "pending"]));
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Need a login.\n\nSign in" })]));
    expect(events.at(-1)).toMatchObject({ type: "conversation.finished", content: { goal: { status: "blocked", userAction: "Sign in" } } });
  });



  it("replays prior continuation messages after a page refresh", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return prompts.length < 3 ? reply(`Progress ${prompts.length}`)
        : calls(call("done", "complete_goal", { taskType: "answer", status: "completed", summary: "Done" }));
    } });
    const { logger, factory } = fixture(model);
    const refresh: SidePanelMessage = { id: "refresh", role: "user", parts: [{ type: "text", text: "Refreshed page" }] };
    const drain = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([refresh]).mockResolvedValue([]);
    const observe = async () => ({ drain, dispose: vi.fn() });
    await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, observe, true).sendMessages(options());
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("Goal mode is still active");
    expect(prompts[2]).toContain("Refreshed page");
    expect(prompts[2]!.indexOf("Goal mode is still active")).toBeLessThan(prompts[2]!.indexOf("Refreshed page"));
  });

  it("continues after an invalid completion call", async () => {
    let count = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ++count === 1
      ? calls(call("invalid", "complete_goal", { status: "completed" }))
      : calls(call("done", "complete_goal", { taskType: "answer", status: "completed", summary: "Done" })) });
    const { events, logger, factory } = fixture(model);
    await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages(options());
    expect(count).toBe(2);
    expect(events.some((event) => event.type === "tool.failed" && event.toolCallId === "invalid")).toBe(true);
    expect(events.some((event) => event.type === "tool.finished" && event.toolCallId === "done")).toBe(true);
  });

  it("allows the user to pause after a text response", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({ doGenerate: async () => { controller.abort(); return reply("working"); } });
    const { events, logger, factory } = fixture(model);
    await expect(createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages({ ...options(), abortSignal: controller.signal })).rejects.toBeDefined();
    expect(events.some((event) => event.type === "conversation.finished")).toBe(false);
    expect(events.some((event) => event.type === "conversation.aborted")).toBe(true);
  });
});
