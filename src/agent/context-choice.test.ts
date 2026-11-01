import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { EventLogger, toLogValue, type LogEvent } from "../logging";
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
  const model = { baseURL: "https://provider.test/v1", providerSettings: { apiKey: "test-key" }, model: "test", contextWindowOverride: 32_000 };
  return { events, logger, model, languageModel, generate };
}

describe("automatic context upkeep", () => {
  it("does not summarize a tiny task when fixed instructions cause context pressure", async () => {
    const { logger, model, languageModel, generate } = await fixture();
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal,
      { languageModel, instructions: "fixed schema overhead ".repeat(5000) })).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
  it("does nothing below pressure and creates no manual choice event", async () => {
    const { events, logger, model, languageModel, generate } = await fixture();
    model.contextWindowOverride = 256_000;
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

  it("handles a provider overflow below the estimated threshold without changing original messages", async () => {
    const { events, logger, model, languageModel } = await fixture("Original goal " + "x".repeat(20_000));
    const original = events[0]!.content;
    expect(await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel, forced: true })).toBe(true);
    expect(events[0]!.content).toEqual(original);
    const context = await activeContext(logger, "one");
    expect(context.checkpoint).toBeDefined();
    expect(JSON.stringify(context.messages).length).toBeLessThan(JSON.stringify(context.raw).length);
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

describe("incremental canonical context", () => {
  it("matches full replay across updates, branch selection, compaction and log clear", async () => {
    const { logger, model, languageModel } = await fixture();
    const { IncrementalActiveContext } = await import("./context-choice");
    const projection = new IncrementalActiveContext(logger, "one");
    const compare = async () => expect((await projection.read()).messages).toEqual((await activeContext(logger, "one")).messages);
    const message = (id: string, text: string) => ({ id, role: "assistant" as const, parts: [{ type: "text" as const, text }] });
    await compare();
    await logger.appendMessage("one", message("a", "First"), { parentId: "u" });
    await compare();
    await logger.appendMessage("one", message("a", "Updated " + "x".repeat(5000)), { parentId: "u" });
    await compare();
    await logger.appendMessage("one", message("b", "Alternative"), { parentId: "u" });
    await logger.append({ type: "conversation.branch.selected", conversationId: "one", content: { headId: "a" } });
    await compare();
    await ensureAutomaticContextSummary(logger, "one", model, new AbortController().signal, { languageModel, forced: true });
    await compare();
    await logger.clear();
    await logger.appendMessage("one", { id: "new", role: "user", parts: [{ type: "text", text: "After clear" }] }, { parentId: null });
    await compare();
    expect(JSON.stringify((await projection.read()).messages)).toContain("After clear");
    expect(JSON.stringify((await projection.read()).messages)).not.toContain("Updated");
  });

  it.each(["conversation.failed", "conversation.aborted"])("matches %s recovery with message revisions and absent tool receipts", async (terminal) => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
      async all() { return [...events]; }, async clear() { events.length = 0; },
    } });
    const { IncrementalActiveContext } = await import("./context-choice");
    const projection = new IncrementalActiveContext(logger, "one");
    const event = (type: string, fields: Partial<LogEvent> = {}) => events.push({ id: events.length + 1,
      timestamp: new Date().toISOString(), type, conversationId: "one", runId: "run", content: null, ...fields });
    const assistant = (text: string, parts: object[]) => event("conversation.message", { parentId: "u", content: toLogValue({
      id: "a", role: "assistant", parts: [{ type: "text", text, state: "done" }, ...parts],
    }) });
    const tool = (toolCallId: string) => ({ type: "dynamic-tool", toolCallId, toolName: "click", state: "input-available", input: { target: { ref: "e1" } } });
    const compare = async () => expect((await projection.read()).messages).toEqual((await activeContext(logger, "one")).messages);
    event("conversation.message", { content: toLogValue({ id: "u", role: "user", parts: [{ type: "text", text: "Goal" }] }) });
    event("conversation.submitted", { content: { messageId: "u" } });
    assistant("First", []); await compare();
    assistant("Second", [tool("done")]); await compare();
    event("tool.finished", { toolCallId: "done", output: { ok: true } });
    assistant("Last", [tool("done"), tool("pending"), tool("missing")]);
    event("tool.started", { toolCallId: "pending" });
    event(terminal, terminal === "conversation.failed" ? { error: "Provider failed" } : {});
    await compare();
    const restored = JSON.stringify((await projection.read()).messages);
    expect(restored).toContain("Last");
    expect(restored).not.toContain("Second");
    expect(restored).toContain("done");
    expect(restored).toContain("pending");
  });

  it("preserves selected-head ordering and valid updates around invalid messages", async () => {
    const { events, logger } = await fixture();
    const { IncrementalActiveContext } = await import("./context-choice");
    const projection = new IncrementalActiveContext(logger, "one");
    const invalid = (id: string) => events.push({ id: events.length + 1, timestamp: new Date().toISOString(),
      type: "conversation.message", conversationId: "one", parentId: "u", content: { id, role: "assistant" } });
    const append = (id: string, text: string) => logger.appendMessage("one", { id, role: "assistant", parts: [{ type: "text", text }] }, { parentId: "u" });
    const compare = async () => expect((await projection.read()).messages).toEqual((await activeContext(logger, "one")).messages);
    invalid("a"); await compare();
    await append("b", "Other branch"); await append("a", "First valid"); await compare();
    await append("a", "Latest valid"); invalid("a"); await compare();
    expect(JSON.stringify((await projection.read()).messages)).toContain("Other branch");
    await logger.append({ type: "conversation.branch.selected", conversationId: "one", content: { headId: "a" } });
    await compare();
    expect(JSON.stringify((await projection.read()).messages)).toContain("Latest valid");
  });

  it("reads only new relevant events after the first projection", async () => {
    const events: LogEvent[] = [];
    const byTypes = vi.fn(async (types: readonly string[], conversationId?: string, afterId = -1) =>
      events.filter((event) => event.id > afterId && types.includes(event.type) && (!conversationId || event.conversationId === conversationId)));
    const logger = new EventLogger({ store: {
      async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
      async all() { return [...events]; }, async clear() { events.length = 0; }, byTypes,
    } });
    const { IncrementalActiveContext } = await import("./context-choice");
    const projection = new IncrementalActiveContext(logger, "one");
    await logger.appendMessage("one", { id: "u", role: "user", parts: [{ type: "text", text: "Goal" }] }, { parentId: null });
    await projection.read();
    const firstId = events.at(-1)!.id;
    await logger.appendMessage("one", { id: "a", role: "assistant", parts: [{ type: "text", text: "Step" }] }, { parentId: "u" });
    byTypes.mockClear();
    await projection.read();
    const reads = byTypes.mock.calls.filter(([types]) => types.includes("conversation.message"));
    expect(reads).toHaveLength(1);
    expect(reads[0]![2]).toBe(firstId);
  });
});
