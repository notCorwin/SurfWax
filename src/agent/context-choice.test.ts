import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { activeContext, ensureAutomaticContextSummary } from "./context-choice";

async function fixture(text = "Original goal") {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  } });
  await logger.appendMessage("one", { id: "u", role: "user", parts: [{ type: "text", text }] }, { parentId: null });
  const generate = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Preserved user goal and exact findings." }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] }));
  const languageModel = new MockLanguageModelV4({ doGenerate: generate });
  const model = { baseURL: "https://provider.test/v1", apiKey: "test-key", model: "test", contextWindowOverride: 32_000 };
  return { events, logger, model, languageModel, generate };
}

describe("automatic context upkeep", () => {
  it("does nothing below pressure and creates no manual choice event", async () => {
    const { events, logger, model, languageModel, generate } = await fixture();
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel })).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["conversation.message"]);
  });

  it("automatically summarizes a full canonical branch and reuses its checkpoint", async () => {
    const { events, logger, model, languageModel, generate } = await fixture("Task constraints " + "x".repeat(130_000));
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel })).toBe(true);
    expect(generate).toHaveBeenCalled();
    expect(events.some((event) => event.type === "context.choice.required")).toBe(false);
    expect((await activeContext(logger, "one")).checkpoint).toMatchObject({ sourceUiCount: 1, branchIds: ["u"] });
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel })).toBe(false);
    expect(events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
  });

  it("resolves a restored legacy manual gate automatically", async () => {
    const { events, logger, model, languageModel } = await fixture();
    await logger.append({ type: "context.choice.required", conversationId: "one", content: { branchIds: ["u"] } });
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel })).toBe(true);
    const resolved = events.find((event) => event.type === "context.choice.resolved");
    expect(fromLogValue(resolved?.content)).toMatchObject({ branchIds: ["u"], action: "summary", automatic: true });
  });

  it("handles a provider overflow below the estimated threshold without changing original messages", async () => {
    const { events, logger, model, languageModel } = await fixture();
    const original = events[0]!.content;
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel, forced: true })).toBe(true);
    expect(events[0]!.content).toEqual(original);
    expect((await activeContext(logger, "one")).messages).toHaveLength(1);
  });

  it("keeps the branch intact and checkpoint absent after a failed or cancelled summary", async () => {
    const { events, logger, model } = await fixture("x".repeat(130_000));
    const languageModel = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("invalid model configuration"); } });
    await expect(ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel })).rejects.toThrow("invalid model");
    expect((await activeContext(logger, "one")).checkpoint).toBeUndefined();
    expect(events.some((event) => event.type === "context.compaction.failed")).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(ensureAutomaticContextSummary(logger, "one", model, controller.signal, { languageModel })).rejects.toMatchObject({ name: "AbortError" });
    expect(events.filter((event) => event.type === "conversation.message")).toHaveLength(1);
  });
});
