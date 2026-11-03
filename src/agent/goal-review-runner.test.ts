import { expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { EventLogger, type LogEvent } from "../logging";
import type { ChromeExecutor } from "../chrome/executor";
import { createAgent } from "./runner";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };

it("reviews a self-declared answer against the original browser task before allowing termination", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: { async append(record) { const stored = { ...record, id: events.length + 1 }; events.push(stored); return stored; }, async all() { return [...events]; }, async clear() {} } });
  let actions = 0, reviews = 0;
  const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
    if (prompt.some((message) => message.role === "system" && message.content.startsWith("SURFWAX_GOAL_REVIEW"))) {
      reviews++;
      const text = JSON.stringify(prompt);
      expect(text).toContain("Open the browser and report the exact release date");
      const accept = text.includes("2026-10-01");
      return { content: [{ type: "text", text: JSON.stringify({ accept, reason: accept ? "The requested observed date is delivered" : "Browser verification has not been performed", remaining: accept ? [] : ["Open the page and obtain its release date"] }) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    }
    actions++;
    const name = actions === 2 ? "inspect_page" : "complete_goal";
    const input = actions === 1 ? { taskType: "answer", status: "completed", summary: "No browser work done" }
      : actions === 2 ? {} : { taskType: "browser", status: "completed", summary: "Release date: 2026-10-01", evidence: [{ toolCallId: "step-2", observation: "Page shows release date 2026-10-01" }] };
    return { content: [{ type: "tool-call", toolCallId: `step-${actions}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] };
  } });
  const executor = { browserContext: async () => ({ tabs: [] }), inspect: async () => ({ snapshot: "Release date: 2026-10-01" }) } as unknown as ChromeExecutor;
  await createAgent({ model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model, executor, logger, goalMode: true }).generate({ prompt: "Open the browser and report the exact release date" });
  expect(actions).toBe(3);
  expect(reviews).toBe(2);
  expect(events.find((event) => event.type === "tool.failed" && event.toolCallId === "step-1")?.output).toMatchObject({ error: { code: "goal-incomplete" } });
  expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "step-3")?.output).toMatchObject({ ok: true });
});

it("reviews an answer delivered alongside completion without requiring a summary", async () => {
  let actions = 0, reviews = 0;
  const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
    if (prompt.some((message) => message.role === "system" && message.content.startsWith("SURFWAX_GOAL_REVIEW"))) {
      reviews++;
      const content = prompt.find((message) => message.role === "user")!.content;
      const request = JSON.parse(typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join(""));
      expect(request.proposedGoal).toEqual({ taskType: "answer", status: "completed" });
      expect(request.context.excerpts).toContainEqual({
        role: "assistant", excerpt: [{ type: "text", text: "The answer is 42." }], truncated: false,
      });
      return { content: [{ type: "text", text: JSON.stringify({ accept: true, reason: "The requested answer was delivered", remaining: [] }) }],
        finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    }
    actions++;
    if (actions > 1) throw new Error("Completion should not require repeating the answer");
    return { content: [{ type: "text", text: "The answer is 42." },
      { type: "tool-call", toolCallId: "done", toolName: "complete_goal", input: JSON.stringify({ taskType: "answer", status: "completed" }) }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] };
  } });
  const executor = { browserContext: async () => ({ tabs: [] }) } as unknown as ChromeExecutor;
  const result = await createAgent({ model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 },
    languageModel: model, executor, goalMode: true }).generate({ prompt: "What is the answer?" });
  expect(actions).toBe(1);
  expect(reviews).toBe(1);
  expect(result.toolResults).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "complete_goal", output: { ok: true, taskType: "answer", status: "completed" } })]));
});
