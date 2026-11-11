import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { estimatePromptInput, fitContextRequest } from "./context-budget";

const limit = { provider: "manual", model: "test", context: 10_000, input: 8_000, source: "manual" as const };
const history: ModelMessage[] = [{ role: "user", content: "Keep this constraint. " + "x".repeat(12_000) }];
const summary: ModelMessage[] = [{ role: "user", content: "Saved constraint" }];

it("compacts at 80% without rounding early, including supplemental input, and admits the exact input budget", async () => {
  const supplemental: ModelMessage = { role: "user", content: "Latest browser state" };
  const outgoing = [...history, supplemental];
  for (const [input, estimate, shouldCompact] of [
    [8_000, 6_399, false], [8_000, 6_400, true], [8_000, 6_401, true],
    [8_001, 6_400, false], [8_001, 6_401, true],
  ] as const) {
    const compact = vi.fn(async () => summary);
    const finalize = vi.fn(async (messages: ModelMessage[]) => [...messages, supplemental]);
    let tokens: number = estimate;
    const result = await fitContextRequest({
      prepared: history, outgoing, limit: { ...limit, input }, prompt: {}, finalize,
      compaction: {
        estimate: () => tokens,
        canCompact: () => true,
        compact: async () => { tokens = input; return compact(); },
      },
    });
    expect(compact).toHaveBeenCalledTimes(shouldCompact ? 1 : 0);
    if (shouldCompact) {
      expect(result).toEqual([...summary, supplemental]);
      expect(finalize).toHaveBeenCalledWith(summary);
    } else expect(result).toBe(outgoing);
  }
  expect(history[0]?.content).toContain("Keep this constraint");
});

it("forces compaction when the growth guard skips it, and rejects overflow after adding browser input", async () => {
  const compact = vi.fn(async (_messages: ModelMessage[], _limit: typeof limit, _force: boolean) => summary);
  const options = {
    prepared: history, outgoing: history, limit, prompt: {},
    compaction: {
      estimate: (messages: ModelMessage[]) => messages === summary ? 2_000 : 8_001,
      canCompact: () => false,
      compact,
    },
    finalize: async (messages: ModelMessage[]) => messages,
  };
  expect(await fitContextRequest(options)).toBe(summary);
  expect(compact).toHaveBeenCalledWith(history, limit, true);
  await expect(fitContextRequest({
    ...options,
    finalize: async (messages) => [...messages, { role: "user", content: "large browser state" }],
  })).rejects.toThrow("压缩后请求仍超出");
});

it("rejects fixed overhead before requesting summaries, and refuses pressure without a compactor", async () => {
  const prompt = { instructions: "x".repeat(30_000) };
  const compact = vi.fn(async () => summary);
  const options = {
    prepared: history, outgoing: history, limit, prompt,
    finalize: async (messages: ModelMessage[]) => messages,
    compaction: { estimate: () => 9_000, canCompact: () => true, compact },
  };
  expect(estimatePromptInput({ ...prompt, messages: [] })).toBeGreaterThan(limit.input);
  await expect(fitContextRequest(options)).rejects.toThrow("系统提示与工具定义");
  expect(compact).not.toHaveBeenCalled();
  await expect(fitContextRequest({
    ...options, prompt: {}, compaction: undefined,
    outgoing: [{ role: "user", content: "x".repeat(20_000) }],
  })).rejects.toThrow("无法在当前运行中压缩");
});
