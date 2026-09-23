import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import type { EventLogger, LogEvent } from "../logging";
import { ContextCompactor, contextPressure, effectiveContext, estimateInput, pendingContextChoice, summarizeContext } from "./compaction";

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
  it("anchors estimates to the complete prompt and provider usage", async () => {
    const { events, logger, model, raw } = fixture();
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds: ["u", "a"], signal: new AbortController().signal });
    expect(await compactor.prepare(raw, 0)).toBeUndefined();
    const promptMessages = [...raw, { role: "user", content: "ephemeral browser context" } as ModelMessage];
    compactor.recordPrompt({ instructions: "system", messages: promptMessages, tools: [{ name: "page", inputSchema: { type: "object" } }] });
    const promptCalibration = events.at(-1)!;
    expect(promptCalibration.type).toBe("context.estimate.calibrated");
    expect((promptCalibration.content as any).baseEstimate).toBe(estimateInput(raw));
    expect((promptCalibration.content as any).promptEstimate).toBeGreaterThan((promptCalibration.content as any).baseEstimate);

    compactor.recordUsage(7_000, 0);
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    await expect(contextPressure({ raw, branchIds: ["u", "a"], events, model }))
      .resolves.toMatchObject({ estimated: 7_000 });

    const extended = [...raw, { role: "user", content: "next" } as ModelMessage];
    await expect(contextPressure({ raw: extended, branchIds: ["u", "a", "next"], events, model }))
      .resolves.toMatchObject({ estimated: 7_000 + estimateInput(extended) - estimateInput(raw) });
  });

  it("ignores legacy, unrelated, and pre-compaction calibrations", async () => {
    const { events, logger, languageModel, model, raw } = fixture();
    events.push({ id: 1, type: "context.estimate.calibrated", timestamp: "2026-01-01", content: { scale: 8 } });
    await expect(contextPressure({ raw, branchIds: ["u", "a"], events, model }))
      .resolves.toMatchObject({ estimated: estimateInput(raw) });

    events.push({ id: 2, type: "context.estimate.calibrated", timestamp: "2026-01-01", content: {
      branchIds: ["other"], contextVersion: 0, baseEstimate: 1, promptEstimate: 50_000, inputTokens: 50_000,
    } });
    await expect(contextPressure({ raw, branchIds: ["u", "a"], events, model }))
      .resolves.toMatchObject({ estimated: estimateInput(raw) });

    await summarizeContext({ raw, branchIds: ["u", "a"], uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal });
    events.push({ id: events.length + 1, type: "context.estimate.calibrated", timestamp: "2026-01-01", content: {
      branchIds: ["u", "a"], contextVersion: 0, baseEstimate: 1, promptEstimate: 50_000, inputTokens: 50_000,
    } });
    await expect(contextPressure({ raw, branchIds: ["u", "a"], events, model }))
      .resolves.toMatchObject({ estimated: estimateInput([{ role: "user", content: "Earlier conversation summary:\nKeep the user's constraints." }]) });
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
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(true);
  });

  it("reports a failed in-run summary without replacing the history", async () => {
    const { events, logger, model, raw } = fixture();
    const languageModel = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("summary unavailable"); } });
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds: ["u", "a"], signal: new AbortController().signal });
    await expect(compactor.compact(raw, raw, 1, languageModel,
      { provider: "manual", model: "test", context: 20_000, source: "manual" })).rejects.toThrow("summary unavailable");
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(true);
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
  });

  it("aborts an in-run summary and records the interruption", async () => {
    const { events, logger, model, raw } = fixture();
    const controller = new AbortController();
    const started = vi.fn();
    const languageModel = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
      started();
      return await new Promise((_, reject) => {
        if (abortSignal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        else abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    } });
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds: ["u", "a"], signal: controller.signal });
    const task = compactor.compact(raw, raw, 1, languageModel,
      { provider: "manual", model: "test", context: 20_000, source: "manual" });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(events.some((event) => event.type === "context.compaction.aborted")).toBe(true);
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
