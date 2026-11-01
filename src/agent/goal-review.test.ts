import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { goalReviewContext, reviewGoal } from "./goal-review";
import type { Goal } from "./goal-completion";

const goal: Goal = { taskType: "browser", status: "completed", summary: "Submitted once; destination says Rejected.", evidence: [{ toolCallId: "submit", observation: "Rejected" }] };
const context = goalReviewContext([{ role: "user", content: "Transfer the original file and confirm it was accepted." },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "submit", toolName: "click", output: { type: "json", value: { performed: true, pageSnapshot: { items: [{ line: "Rejected" }] } } } }] }]);
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };

describe("independent goal review", () => {
  it("supplies original requirements and actual result, returning actionable unmet work", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt, tools }) => {
      expect(tools?.length ?? 0).toBe(0);
      expect(JSON.stringify(prompt)).toContain("confirm it was accepted");
      expect(JSON.stringify(prompt)).toContain("Rejected");
      expect(JSON.stringify(prompt)).toContain("An action returning success is not business success");
      return { content: [{ type: "text", text: JSON.stringify({ accept: false, reason: "The destination rejected the file", remaining: ["Diagnose the rejection and verify acceptance without blindly duplicating the write"] }) }],
        finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    } });
    expect(await reviewGoal({ goal, context, model })).toMatchObject({ accept: false, remaining: [expect.stringContaining("Diagnose")] });
  });

  it.each(["not JSON", JSON.stringify({ accept: true, reason: "Done", remaining: ["Still missing requested date"] })])("does not accept malformed or contradictory verdicts (%s)", async (text) => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) });
    await expect(reviewGoal({ goal, context, model })).rejects.toThrow();
  });

  it("bounds evidence excerpts and prioritizes user requirements over giant page data", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Original requirement" },
      { role: "user", content: `<page-refresh>\n${"noise".repeat(100_000)}` },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "read", toolName: "read_text", output: { type: "text", value: "page".repeat(100_000) } }] }];
    const packed = goalReviewContext(messages);
    expect(packed).toContain("Original requirement");
    expect(packed).not.toContain("noise");
    expect(packed.length).toBeLessThan(50_000);
    expect(packed).toContain('"truncated":true');
  });

  it("does not send a review request that exceeds its input budget", async () => {
    let requested = false;
    const model = new MockLanguageModelV4({ doGenerate: async () => { requested = true; throw new Error("must not send"); } });
    await expect(reviewGoal({ goal, context, model, budget: { input: 10, output: 10 } })).rejects.toThrow("input budget");
    expect(requested).toBe(false);
  });
});
