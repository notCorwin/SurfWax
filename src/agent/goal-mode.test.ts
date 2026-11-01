import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ChromeExecutor } from "../chrome/executor";
import { EventLogger, type LogEvent } from "../logging";
import { createAgent } from "./runner";
import { activeContext, IncrementalActiveContext } from "./context-choice";
import { createChatTransport, type SidePanelMessage } from "./transport";

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
  it("continues after repeated text and finishes only after a successful completion tool, publishing its summary", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      if (prompts.length < 3) return reply(`Progress ${prompts.length}`);
      return calls(call("done", "complete_goal", { status: "completed", summary: "Finished the task." }));
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
    let pending = true;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      count++;
      if (count === 1) return calls(call("parallel", "complete_goal", { status: "completed", summary: "too soon" }), call("read", "inspect_page", {}));
      if (count === 2) return calls(call("pending", "complete_goal", { status: "completed", summary: "too soon" }));
      pending = false;
      return calls(call("done", "complete_goal", { status: "blocked", summary: "Need a login." }));
    } });
    const { events, logger, factory } = fixture(model, { pendingBackgroundJobs: () => pending ? ["job"] : [], inspect: async () => ({ snapshot: "page" }) });
    const result = await createChatTransport(factory, logger, "thread", undefined, undefined, undefined, undefined, true).sendMessages(options());
    expect(count).toBe(3);
    expect(events.filter((event) => event.type === "tool.failed").map((event) => event.toolCallId)).toEqual(expect.arrayContaining(["parallel", "pending"]));
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Need a login." })]));
  });



  it("replays prior continuation messages after a page refresh", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return prompts.length < 3 ? reply(`Progress ${prompts.length}`)
        : calls(call("done", "complete_goal", { status: "completed", summary: "Done" }));
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
      : calls(call("done", "complete_goal", { status: "completed", summary: "Done" })) });
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
