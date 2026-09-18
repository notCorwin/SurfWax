import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import type { EventLogger, LogEvent } from "../logging";
import { ContextCompactor, contextPressure, effectiveContext, pendingContextChoice, summarizeContext } from "./compaction";

function fixture() {
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
  const generate = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Keep the user's constraints." }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  }));
  const languageModel = new MockLanguageModelV4({ doGenerate: generate as any });
  const model = { baseURL: "https://provider.test/v1", apiKey: "key", model: "test", contextWindowOverride: 8_000 };
  const raw: ModelMessage[] = [
    { role: "user", content: "Old user details " + "a".repeat(7_000) },
    { role: "assistant", content: "Old findings " + "b".repeat(7_000) },
  ];
  return { events, logger, generate, languageModel, model, raw };
}

describe("context choices and summary", () => {
  it("never compacts during an agent step and records calibrated usage", async () => {
    const { events, logger, model, raw } = fixture();
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds: ["u", "a"], signal: new AbortController().signal });
    expect(await compactor.prepare(raw, 0)).toBeUndefined();
    compactor.recordUsage(7_000);
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    expect(events.some((event) => event.type === "context.estimate.calibrated")).toBe(true);
  });

  it("summarizes the complete effective history once, then replaces the entire old prefix", async () => {
    const { events, logger, generate, languageModel, model, raw } = fixture();
    const branchIds = ["u", "a"];
    await summarizeContext({ raw, branchIds, uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls[0])).toContain("Old user details");
    expect(JSON.stringify(generate.mock.calls[0])).toContain("Old findings");
    const extended = [...raw, { role: "user", content: "new request" } as ModelMessage];
    const applied = await effectiveContext(events, [...branchIds, "new"], extended);
    expect(applied.messages).toEqual([
      { role: "user", content: "Earlier conversation summary:\nKeep the user's constraints." }, extended[2],
    ]);
    const pressure = await contextPressure({ raw: extended, branchIds: [...branchIds, "new"], events, model });
    expect(pressure?.messages).toEqual(applied.messages);
  });

  it("refuses a full-history summary when it cannot fit, without writing a checkpoint", async () => {
    const { events, logger, generate, languageModel, model, raw } = fixture();
    await expect(summarizeContext({ raw, branchIds: ["u", "a"], uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal,
      limit: { provider: "manual", model: "test", context: 2_000, source: "manual" } }))
      .rejects.toThrow("完整历史超出");
    expect(generate).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
  });

  it("restores a pending choice and clears it only for its branch", () => {
    const { events } = fixture();
    events.push({ id: 1, type: "context.choice.required", timestamp: "2026-01-01", content: { branchIds: ["u", "a"] } });
    expect(pendingContextChoice(events, ["u", "a", "next"])).toBe(true);
    expect(pendingContextChoice(events, ["other"])).toBe(false);
    events.push({ id: 2, type: "context.choice.resolved", timestamp: "2026-01-01", content: { branchIds: ["u", "a"] } });
    expect(pendingContextChoice(events, ["u", "a", "next"])).toBe(false);
  });
});
