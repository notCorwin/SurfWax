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
  const generate = vi.fn(async (_options?: unknown) => ({
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

  it("summarizes every oversized source fragment and merges before writing one checkpoint", async () => {
    const { events, logger, generate, languageModel, model, raw } = fixture();
    await summarizeContext({ raw, branchIds: ["u", "a"], uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal,
      limit: { provider: "manual", model: "test", context: 2_000, source: "manual" } });
    const sourcePrompts = generate.mock.calls.map(([options]) => (options as any).prompt)
      .flatMap((prompt: any[]) => prompt.filter((message) => message.role === "user"))
      .flatMap((message: any) => message.content.filter((part: any) => part.type === "text").map((part: any) => part.text))
      .filter((text: string) => text.startsWith("Serialized conversation source,"));
    expect(sourcePrompts.length).toBeGreaterThan(1);
    expect(sourcePrompts.map((text: string) => text.slice(text.indexOf("\n") + 1)).join("")).toBe(JSON.stringify(raw));
    expect(events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
    expect(events.some((event) => event.type === "model.compaction.finished" && (event.content as any).phase === "merge")).toBe(true);
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(false);
  });

  it("does not write a checkpoint when one fragment fails", async () => {
    const { events, logger, model, raw } = fixture();
    let calls = 0;
    const languageModel = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 2) throw new Error("second fragment unavailable");
      return { content: [{ type: "text", text: "first fragment" }], finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
    } });
    await expect(summarizeContext({ raw, branchIds: ["u", "a"], uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal,
      limit: { provider: "manual", model: "test", context: 2_000, source: "manual" } })).rejects.toThrow("second fragment");
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(true);
  });

  it("reuses an in-run summary on the next turn and rejects edited branches and altered summaries", async () => {
    const { events, logger, model, raw, languageModel } = fixture();
    const branchIds = ["u", "a"];
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds, signal: new AbortController().signal });
    const prepared = [...raw, { role: "user", content: "transient browser context" } as ModelMessage];
    await compactor.compact(raw, prepared, 2, languageModel, { provider: "manual", model: "test", context: 20_000, source: "manual" });
    const next = { role: "user", content: "continue" } as ModelMessage;
    const restored = await effectiveContext(events, [...branchIds, "next"], [...raw, next]);
    expect(restored.checkpoint?.strategy).toBe("summary");
    expect(restored.checkpoint?.summaryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.messages).toHaveLength(2);
    expect((await effectiveContext(events, ["u", "edited", "next"], [...raw, next])).checkpoint).toBeUndefined();
    expect((await effectiveContext(events, [...branchIds, "next"], [{ role: "user", content: "edited" }, raw[1]!, next])).checkpoint).toBeUndefined();
    const event = events.find((event) => event.type === "context.compacted")!;
    (event.content as any).summary = "changed summary";
    expect((await effectiveContext(events, [...branchIds, "next"], [...raw, next])).checkpoint).toBeUndefined();
  });

  it("accepts equivalent SDK text representations and keeps legacy checkpoint compatibility", async () => {
    const { events, logger, model, raw, languageModel } = fixture();
    const branchIds = ["u", "a"];
    await summarizeContext({ raw, branchIds, uiCount: 2, model, languageModel, logger,
      conversationId: "one", signal: new AbortController().signal });
    const reconstructed = raw.map((message) => ({ ...message, content: [{ type: "text", text: message.content }] })) as ModelMessage[];
    expect((await effectiveContext(events, branchIds, reconstructed)).checkpoint).toBeDefined();
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(raw)));
    const sourceDigest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    events.length = 0;
    events.push({ id: 1, type: "context.compacted", timestamp: "2026-01-01", content: {
      strategy: "summary", branchIds, sourceCount: raw.length, sourceDigest, summary: "Legacy summary", sourceUiCount: 2,
    } });
    expect((await effectiveContext(events, branchIds, raw)).checkpoint?.summary).toBe("Legacy summary");
    events.push({ id: 2, type: "context.compacted", timestamp: "2026-01-01", content: null });
    expect((await effectiveContext(events, branchIds, raw)).checkpoint?.summary).toBe("Legacy summary");
  });

  it("calibrates provider usage after an in-run compaction and includes tool schemas before first usage", async () => {
    const { events, logger, model, raw, languageModel } = fixture();
    const branchIds = ["u", "a"];
    const compactor = new ContextCompactor({ model, logger, conversationId: "one", branchIds, signal: new AbortController().signal });
    const compacted = await compactor.compact(raw, raw, 2, languageModel,
      { provider: "manual", model: "test", context: 20_000, source: "manual" });
    compactor.recordPrompt({ instructions: "system", messages: compacted, tools: [{ name: "large", schema: "a".repeat(12_000) }] });
    compactor.recordUsage(5_000, 2);
    expect(compactor.estimate(compacted)).toBe(5_000);
    expect(compactor.estimate(compacted, { instructions: "system", tools: [{ schema: "a".repeat(12_000) }] })).toBe(5_000);
    await expect(contextPressure({ raw, branchIds, events, model })).resolves.toMatchObject({ estimated: 5_000 });
    const withoutCalibration = events.filter((event) => event.type !== "context.estimate.calibrated");
    const plain = await contextPressure({ raw, branchIds, events: withoutCalibration, model });
    const withTools = await contextPressure({ raw, branchIds, events: withoutCalibration, model, tools: [{ schema: "a".repeat(12_000) }] });
    expect(withTools!.estimated - plain!.estimated).toBeGreaterThan(3_900);
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
