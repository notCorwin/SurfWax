import { describe, expect, it } from "vitest";
import type { LogEvent } from "../logging";
import { summarizeTokenUsage } from "./token-usage";

function step(usage?: unknown): LogEvent {
  return { id: 1, timestamp: "2026-01-01", type: "model.step.finished", usage } as LogEvent;
}

describe("summarizeTokenUsage", () => {
  it("distinguishes no completed steps from missing provider data", () => {
    const none = { total: 0, reported: 0, missing: 0 };
    expect(summarizeTokenUsage([])).toEqual({ input: none, output: none, cacheRead: none });
    const missing = { total: 0, reported: 0, missing: 1 };
    expect(summarizeTokenUsage([step()])).toEqual({ input: missing, output: missing, cacheRead: missing });
  });

  it("sums each field independently and preserves partial and zero reports", () => {
    expect(summarizeTokenUsage([
      step({ inputTokens: 100, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 40 } }),
      step({ inputTokens: 50, outputTokens: 5 }),
      step({ inputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } }),
    ])).toEqual({
      input: { total: 150, reported: 3, missing: 0 },
      output: { total: 5, reported: 2, missing: 1 },
      cacheRead: { total: 40, reported: 2, missing: 1 },
    });
  });

  it("rejects invalid numbers and ignores events that are not completed agent steps", () => {
    expect(summarizeTokenUsage([
      step({ inputTokens: NaN, outputTokens: -1, inputTokenDetails: { cacheReadTokens: Infinity } }),
      { ...step({ inputTokens: 100 }), type: "model.finished" },
    ])).toEqual({
      input: { total: 0, reported: 0, missing: 1 },
      output: { total: 0, reported: 0, missing: 1 },
      cacheRead: { total: 0, reported: 0, missing: 1 },
    });
  });
});
