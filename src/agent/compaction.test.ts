import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import type { EventLogger, LogEvent } from "../logging";
import { ContextCompactor } from "./compaction";
import type { JevSelectionScorer } from "./jev";

function fixture(summary = "Earlier pages were inspected; keep the user's constraints.") {
  const events: LogEvent[] = [];
  const logger = {
    async append(record: Partial<LogEvent>) {
      const event = { id: events.length + 1, timestamp: new Date().toISOString(), content: null, ...record } as LogEvent;
      events.push(event);
      return event;
    },
    record(record: Partial<LogEvent>) { events.push({ id: events.length + 1, timestamp: new Date().toISOString(), content: null, ...record } as LogEvent); },
    async conversation() { return [...events]; },
  } as unknown as EventLogger;
  const doGenerate = vi.fn(async () => ({
    content: [{ type: "text" as const, text: summary }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  }));
  const languageModel = new MockLanguageModelV4({ doGenerate: doGenerate as any });
  const model = { baseURL: "https://example.test/v1", apiKey: "key", model: "test", contextWindowOverride: 8_000 };
  const messages: ModelMessage[] = [
    { role: "user", content: "Old user details " + "a".repeat(10_000) },
    { role: "assistant", content: "Old tool findings " + "b".repeat(10_000) },
    { role: "user", content: "Continue this task" },
  ];
  const make = (branchIds: string[], signal = new AbortController().signal) => new ContextCompactor({
    model, languageModel, logger, conversationId: "thread", branchIds, signal,
  });
  return { events, logger, doGenerate, messages, make };
}

describe("context compaction", () => {
  it("compresses at the threshold, keeps raw log messages, and reuses only the matching branch", async () => {
    const { events, doGenerate, messages, make } = fixture();
    const compacted = await make(["u1", "a1", "u2"]).prepare(messages, 0);
    expect(compacted).toHaveLength(2);
    expect(compacted?.[0]?.content).toContain("Earlier conversation summary:");
    expect(compacted?.[1]).toBe(messages[2]);
    expect(events.some((event) => event.type === "context.compacted")).toBe(true);
    expect(messages[0]?.content).toContain("Old user details");
    const firstCalls = doGenerate.mock.calls.length;
    expect((await make(["u1", "a1", "u2", "a2", "u3"]).prepare([...messages, { role: "assistant", content: "done" }, { role: "user", content: "next" }], 0))?.[0]?.content)
      .toContain("Earlier conversation summary:");
    expect(doGenerate).toHaveBeenCalledTimes(firstCalls);
    await make(["different-u1", "a1", "u2"]).prepare(messages, 0);
    expect(doGenerate.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it("uses provider input usage to calibrate the next step and never activates a failed summary", async () => {
    const { events, messages, make, doGenerate } = fixture();
    const short: ModelMessage[] = [
      { role: "user", content: "old ".repeat(400) },
      { role: "assistant", content: "reply ".repeat(400) },
      { role: "user", content: "current" },
    ];
    const compactor = make(["u1", "a1", "u2"]);
    expect(await compactor.prepare(short, 0)).toBeUndefined();
    compactor.recordUsage(7_000);
    expect(await compactor.prepare(short, 1)).toHaveLength(2);
    expect(doGenerate).toHaveBeenCalled();

    doGenerate.mockRejectedValueOnce(new Error("summary rejected"));
    await expect(make(["other"]).prepare(messages, 0)).rejects.toThrow("summary rejected");
    expect(events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(make(["other"], controller.signal).prepare(messages, 0)).rejects.toMatchObject({ name: "AbortError" });

    const interrupted = fixture();
    const running = new AbortController();
    interrupted.doGenerate.mockImplementationOnce(async () => {
      running.abort("panel closed");
      throw new DOMException("Operation aborted", "AbortError");
    });
    await expect(interrupted.make(["u1", "a1", "u2"], running.signal).prepare(interrupted.messages, 0))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(interrupted.events.some((event) => event.type === "context.compaction.aborted")).toBe(true);
    expect(interrupted.events.some((event) => event.type === "context.compacted")).toBe(false);
  });

  it("selects high-value messages in order, keeps the raw log, and reuses the selection checkpoint", async () => {
    const { events, logger } = fixture();
    const model = { baseURL: "https://example.test/v1", apiKey: "key", model: "test", contextWindowOverride: 6_000 };
    const messages: ModelMessage[] = [
      { role: "user", content: "Keep this constraint " + "a".repeat(4_000) },
      { role: "assistant", content: "Discard this stale narration " + "b".repeat(5_000) },
      { role: "user", content: "Continue the task" },
    ];
    const score = vi.fn(async (_task: string, candidates: readonly { index: number; message: ModelMessage }[]) => ({
      probabilities: new Map(candidates.map(({ index }) => [index, index === 0 ? 0.9 : 0.1])),
      batches: 1,
      usage: { input_tokens: 20, output_tokens: 0 },
      model: "jev-1.13.0",
    }));
    const make = (branchIds: string[]) => new ContextCompactor({
      model,
      languageModel: new MockLanguageModelV4({ doGenerate: vi.fn() as any }),
      logger,
      conversationId: "thread",
      branchIds,
      signal: new AbortController().signal,
      jevSelector: { score } satisfies JevSelectionScorer,
    });

    const compacted = await make(["u1", "a1", "u2"]).prepare(messages, 0);
    expect(compacted?.map((message) => message.role)).toEqual(["user", "user"]);
    expect(compacted?.[0]).toBe(messages[0]);
    expect(compacted?.[1]).toBe(messages[2]);
    expect(messages[1]?.content).toContain("stale narration");
    expect(events.find((event) => event.type === "context.compacted")?.content).toMatchObject({ strategy: "jev-selection", selectedIndexes: [0] });

    const firstCalls = score.mock.calls.length;
    const restored = await make(["u1", "a1", "u2", "a2"]).prepare([...messages, { role: "assistant", content: "new" }], 0);
    expect(restored?.[0]).toBe(messages[0]);
    expect(score).toHaveBeenCalledTimes(firstCalls);
    expect(events.some((event) => event.type === "context.checkpoint.applied" && (event.content as { strategy?: string }).strategy === "jev-selection")).toBe(true);

    await make(["different"]).prepare(messages, 0);
    expect(score.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it("closes selected tool messages over the call/result pair", async () => {
    const { logger } = fixture();
    const toolCall: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "chrome", input: { code: "return 1" + "a".repeat(2_000) } }],
    };
    const toolResult: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "chrome", output: { type: "text", value: "1" + "b".repeat(2_000) } }],
    };
    const stale: ModelMessage = { role: "assistant", content: "stale narration " + "c".repeat(4_000) };
    const messages: ModelMessage[] = [toolCall, toolResult, stale, { role: "user", content: "Continue" }];
    const score: JevSelectionScorer = {
      score: vi.fn(async () => ({
        probabilities: new Map([[0, 0.9], [1, 0.1], [2, 0.1]]),
        batches: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
        model: "jev-latest",
      })),
    };
    const compacted = await new ContextCompactor({
      model: { baseURL: "https://example.test/v1", apiKey: "key", model: "test", contextWindowOverride: 5_500 },
      languageModel: new MockLanguageModelV4({ doGenerate: vi.fn() as any }),
      logger,
      conversationId: "thread",
      branchIds: ["a", "b", "c"],
      signal: new AbortController().signal,
      jevSelector: score,
    }).prepare(messages, 0);

    expect(compacted).toEqual([toolCall, toolResult, messages[3]]);
  });

  it("falls back to the existing summary path on Jev failure but not on abort", async () => {
    const failed = fixture();
    const failedScore: JevSelectionScorer = { score: vi.fn(async () => { throw new Error("Jev unavailable"); }) };
    const fallback = new ContextCompactor({
      model: { baseURL: "https://example.test/v1", apiKey: "key", model: "test", contextWindowOverride: 8_000 },
      languageModel: new MockLanguageModelV4({ doGenerate: failed.doGenerate as any }),
      logger: failed.logger,
      conversationId: "thread",
      branchIds: ["u1", "a1", "u2"],
      signal: new AbortController().signal,
      jevSelector: failedScore,
    });
    const result = await fallback.prepare(failed.messages, 0);
    expect(result?.[0]?.content).toContain("Earlier conversation summary:");
    expect(failed.events.some((event) => event.type === "context.compaction.jev.failed")).toBe(true);
    expect(failed.events.some((event) => event.type === "context.compaction.fallback")).toBe(true);

    const interrupted = fixture();
    const controller = new AbortController();
    const abortingScore: JevSelectionScorer = { score: vi.fn(async () => {
      controller.abort("panel closed");
      throw new DOMException("Operation aborted", "AbortError");
    }) };
    const aborted = new ContextCompactor({
      model: { baseURL: "https://example.test/v1", apiKey: "key", model: "test", contextWindowOverride: 8_000 },
      languageModel: new MockLanguageModelV4({ doGenerate: interrupted.doGenerate as any }),
      logger: interrupted.logger,
      conversationId: "thread",
      branchIds: ["u1", "a1", "u2"],
      signal: controller.signal,
      jevSelector: abortingScore,
    });
    await expect(aborted.prepare(interrupted.messages, 0)).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupted.doGenerate).not.toHaveBeenCalled();
  });
});
