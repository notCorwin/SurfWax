import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ChromeExecutor } from "../chrome/executor";
import { EventLogger, type LogEvent } from "../logging";
import { createAgent } from "./runner";
import { createChatTransport, type SidePanelMessage } from "./transport";

vi.mock("./coordinator", () => ({ claimConversationRun: async (_id: string, signal?: AbortSignal) => ({
  signal: signal ?? new AbortController().signal, finish: vi.fn(),
}) }));

function logger() {
  const events: LogEvent[] = [];
  return new EventLogger({ store: {
    async append(record) { const saved = { ...record, id: events.length + 1 }; events.push(saved); return saved; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
}

const user: SidePanelMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Inspect the page" }] };
const refresh: SidePanelMessage = { id: "refresh", role: "user", metadata: { custom: { pageRefresh: true } },
  parts: [{ type: "text", text: "REFRESHED_PAGE_SNAPSHOT" }] };
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const options = () => ({ trigger: "submit-message" as const, chatId: "thread", messages: [user] });

function fixture(model: MockLanguageModelV4, runProgram = vi.fn(async () => ({ ok: true }))) {
  const log = logger();
  const executor = { browserContext: async () => ({ tabs: [] }), runProgram, inspect: vi.fn(async () => ({ snapshot: "tool snapshot" })) };
  const factory = vi.fn(async (signal, _branchIds, _resumed, onResponse, shouldYield) => createAgent({
    model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model,
    executor: executor as unknown as ChromeExecutor, logger: log, conversationId: "thread", signal, onResponse, shouldYield,
  }));
  return { log, factory };
}

describe("page refresh transport", () => {
  it("appends the refresh to canonical history and sends it in a subsequent model request", async () => {
    const prompts: string[] = [];
    const { log, factory } = fixture(new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return reply(prompts.length === 1 ? "Initial answer" : "Updated answer");
    } }));
    const drain = vi.fn().mockResolvedValueOnce([refresh]).mockResolvedValue([]);
    const dispose = vi.fn();
    const observe = vi.fn(async (signal: AbortSignal) => {
      expect(factory).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      return { drain, dispose };
    });
    const published: SidePanelMessage[] = [];
    const result = await createChatTransport(factory, log, "thread", undefined, undefined, undefined, observe)
      .sendMessages({ ...options(), onMessage: (message) => { published.push(message); } });

    expect(observe).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("REFRESHED_PAGE_SNAPSHOT");
    expect(prompts[1]).toContain("Initial answer");
    expect(prompts[1]).toContain("REFRESHED_PAGE_SNAPSHOT");
    expect(prompts[1]!.indexOf("Initial answer")).toBeLessThan(prompts[1]!.indexOf("REFRESHED_PAGE_SNAPSHOT"));
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Updated answer" })]));
    expect(published.every((message) => message.role === "assistant")).toBe(true);
    const entries = (await log.repository("thread")).messages;
    const firstAnswer = entries.find(({ message }) => message.parts.some((part) => !!part && typeof part === "object" && "text" in part && part.text === "Initial answer"));
    expect(firstAnswer?.parentId).toBe(user.id);
    expect(entries.find(({ message }) => message.id === refresh.id)).toEqual({ parentId: firstAnswer?.message.id, message: refresh });
    expect(entries.find(({ message }) => message.id === result.id)?.parentId).toBe(refresh.id);
  });

  it("sends a refresh observed during a tool call before the next model request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pending = false;
    const runProgram = vi.fn(async () => { pending = true; await gate; return { ok: true, result: "TOOL_COMPLETED" }; });
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return prompts.length === 1 ? {
        content: [{ type: "tool-call" as const, toolCallId: "click", toolName: "click", input: JSON.stringify({ target: { ref: "e1" } }) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
      } : reply("Updated answer");
    } });
    const { log, factory } = fixture(model, runProgram);
    const observe = async () => ({
      hasPending: () => pending,
      drain: async () => { if (!pending) return []; pending = false; return [refresh]; },
      dispose: vi.fn(),
    });
    const running = createChatTransport(factory, log, "thread", undefined, undefined, undefined, observe).sendMessages(options());
    await vi.waitFor(() => expect(runProgram).toHaveBeenCalledOnce());
    expect(prompts).toHaveLength(1);
    release();
    await running;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("TOOL_COMPLETED");
    expect(prompts[1]).toContain("REFRESHED_PAGE_SNAPSHOT");
    expect(prompts[1]!.indexOf("TOOL_COMPLETED")).toBeLessThan(prompts[1]!.indexOf("REFRESHED_PAGE_SNAPSHOT"));
    const history = await log.repository("thread");
    expect(history.messages.find(({ message }) => message.id === refresh.id)).toBeDefined();
  });

  it("disposes the observer when generation fails", async () => {
    const failure = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const { log, factory } = fixture(new MockLanguageModelV4({ doGenerate: async () => { throw failure; } }));
    const dispose = vi.fn();
    const observe = vi.fn(async () => ({ drain: vi.fn(async () => []), dispose }));
    await expect(createChatTransport(factory, log, "thread", undefined, undefined, undefined, observe).sendMessages(options())).rejects.toBe(failure);
    expect(observe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
