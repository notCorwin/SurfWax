import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { PROGRAM_TOOL_CONTEXT as TOOL_CONTEXT, TOOL_REGISTRY } from "../chrome/tool";
import { createPromptSnapshot, ensureConversationPrompt, readPromptSnapshot } from "./prompt";
import { contextPressure, estimatePromptInput, summarizeContext } from "./compaction";
import { retryModelOperation } from "./model";
function fixture() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: { async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; }, async all() { return [...events]; }, async clear() { events.length = 0; } } });
  return { logger, events };
}
describe("canonical prompt versions", () => {
  it("appends all tools after custom instructions and preserves the stored prefix", async () => {
    const { logger, events } = fixture();
    const first = await ensureConversationPrompt(logger, "one", "My instructions");
    expect(first).toMatchObject({ version: 2, format: "system-tools", instructions: `My instructions\n\n${TOOL_CONTEXT}` });
    const prefix = JSON.stringify(events);
    expect(await ensureConversationPrompt(logger, "one", "My instructions")).toEqual(first);
    expect(JSON.stringify(events)).toBe(prefix);
    await ensureConversationPrompt(logger, "one", "Next instructions");
    expect(events).toHaveLength(2); expect(fromLogValue(events[0]!.content)).toEqual({ prompt: first });
    expect(readPromptSnapshot(events)?.source).toBe("Next instructions");
  });
  it("migrates a legacy branch only after a successful summary and restores other branches unchanged", async () => {
    const { logger, events } = fixture();
    await logger.append({ type: "conversation.submitted", conversationId: "one", content: { messageId: "u" } });
    const legacy = await ensureConversationPrompt(logger, "one", "Custom", ["u"]);
    expect(legacy.instructions).toBe("Custom"); expect(legacy.format).toBe("legacy-user-tools");
    const raw = [{ role: "user" as const, content: "Original task" }];
    const model = { baseURL: "https://test/v1", apiKey: "key", model: "test", contextWindowOverride: 262144 };
    const signal = new AbortController().signal;
    const failed = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("permanent failure"); } });
    await expect(summarizeContext({ raw, branchIds: ["u"], uiCount: 1, model, languageModel: failed, logger, conversationId: "one", signal, prompt: legacy })).rejects.toThrow("permanent");
    expect(readPromptSnapshot(events, ["u"])).toEqual(legacy);
    const successful = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: "Task summary" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
    await summarizeContext({ raw, branchIds: ["u"], uiCount: 1, model, languageModel: successful, logger, conversationId: "one", signal, prompt: legacy });
    expect(readPromptSnapshot(events, ["u", "a"])?.instructions).toBe(`Custom\n\n${TOOL_CONTEXT}`);
    expect(readPromptSnapshot(events, ["different-user"])).toEqual(legacy);
    expect(readPromptSnapshot(JSON.parse(JSON.stringify(events)), ["u", "a"])?.version).toBe(2);
  });
  it("counts system text and schemas at the exact 20 percent remaining boundary", async () => {
    const raw = [{ role: "user" as const, content: "task" }];
    const instructions = createPromptSnapshot("Custom").instructions;
    const tools = [{ name: "tool", description: "large schema".repeat(100) }];
    const estimated = estimatePromptInput({ instructions, messages: raw, tools });
    const limit = { context: estimated * 5, input: estimated * 5, output: 0, source: "manual" as const, provider: "test", model: "unknown" };
    const model = { baseURL: "", apiKey: "key", model: "unknown" };
    const result = await contextPressure({ raw, branchIds: ["u"], events: [], model, instructions, tools, limit: { ...limit, input: estimated * 1.25 } });
    expect(result?.estimated).toBe(estimated); expect(result?.threshold).toBe(estimated);
    const over = await contextPressure({ raw: [...raw, { role: "user", content: "one more token" }], branchIds: ["u"], events: [], model, instructions, tools, limit: { ...limit, input: estimated * 1.25 } });
    expect(over!.estimated).toBeGreaterThan(over!.threshold);
  });
  it("accepts act batches longer than 100 steps", () => {
    const schema = TOOL_REGISTRY.find(({ name }) => name === "act")!.inputSchema;
    expect(schema.safeParse({ steps: Array.from({ length: 121 }, () => ({ type: "click", target: { by: "role", value: "button", name: "Increment" } })) }).success).toBe(true);
  });
});
it("retries read-only model work beyond old limits, caps every delay and stops on permanent errors or abort", async () => {
  let calls = 0; const sleep = vi.fn(async (_ms: number) => {}); const controller = new AbortController();
  expect(await retryModelOperation(async () => { if (++calls < 15) throw new TypeError("connection reset"); return "done"; }, { signal: controller.signal, purpose: "summary", sleep })).toBe("done");
  expect(sleep).toHaveBeenCalledTimes(14); expect(sleep.mock.calls.every(([ms]) => ms <= 5000)).toBe(true);
  const permanent = vi.fn(async () => { throw Object.assign(new Error("unauthorized"), { statusCode: 401 }); });
  await expect(retryModelOperation(permanent, { signal: controller.signal, purpose: "title", sleep })).rejects.toThrow("unauthorized");
  expect(permanent).toHaveBeenCalledOnce();
  controller.abort(); await expect(retryModelOperation(permanent, { signal: controller.signal, purpose: "title", sleep })).rejects.toMatchObject({ name: "AbortError" });
});
