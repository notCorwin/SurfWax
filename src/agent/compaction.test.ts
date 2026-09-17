import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import type { EventLogger, LogEvent } from "../logging";
import { ContextCompactor } from "./compaction";

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
});
