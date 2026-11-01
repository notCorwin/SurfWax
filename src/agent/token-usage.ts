import { fromLogValue, type LogEvent } from "../logging";

export type TokenUsageField = { total: number; reported: number; missing: number };
export type TokenUsageSummary = { input: TokenUsageField; output: TokenUsageField; cacheRead: TokenUsageField };

/** Sum provider-reported agent step usage without treating missing fields as zero. */
export function summarizeTokenUsage(events: readonly LogEvent[]): TokenUsageSummary {
  const result: TokenUsageSummary = {
    input: { total: 0, reported: 0, missing: 0 },
    output: { total: 0, reported: 0, missing: 0 },
    cacheRead: { total: 0, reported: 0, missing: 0 },
  };
  const add = (field: TokenUsageField, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      field.total += value;
      field.reported += 1;
    } else {
      field.missing += 1;
    }
  };
  for (const event of events) {
    if (event.type !== "model.step.finished") continue;
    const usage = fromLogValue(event.usage, event.valueEncoding) as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      inputTokenDetails?: { cacheReadTokens?: unknown } | null;
    } | null | undefined;
    add(result.input, usage?.inputTokens);
    add(result.output, usage?.outputTokens);
    add(result.cacheRead, usage?.inputTokenDetails?.cacheReadTokens);
  }
  return result;
}
