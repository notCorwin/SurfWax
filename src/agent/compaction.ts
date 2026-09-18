import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { fromLogValue, type EventLogger, type LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { inputBudget, resolveModelLimit, type ModelLimit } from "./model-limits";

export const SUMMARY_PREFIX = "Earlier conversation summary:\n";
const SUMMARY_INSTRUCTIONS = "Summarize the entire supplied conversation faithfully for continuing the browser task. Preserve the user's goal, constraints, decisions, page and tab identities, browser side effects, tool results, errors, unresolved work, and exact values needed later. Do not invent facts. Return only the concise summary.";

export type SummaryCheckpoint = {
  strategy: "summary";
  branchIds: string[];
  sourceCount: number;
  sourceUiCount: number;
  sourceDigest: string;
  summary: string;
};

export function estimateInput(messages: readonly ModelMessage[]): number {
  return 1024 + Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).length / 3);
}

async function digest(messages: readonly ModelMessage[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isBranchPrefix(prefix: readonly string[], branch: readonly string[]): boolean {
  return prefix.length <= branch.length && prefix.every((id, index) => id === branch[index]);
}

export async function currentSummary(events: readonly LogEvent[], branchIds: readonly string[], messages: readonly ModelMessage[]): Promise<SummaryCheckpoint | undefined> {
  for (const event of [...events].reverse()) {
    if (event.type !== "context.compacted") continue;
    const value = fromLogValue(event.content) as Partial<SummaryCheckpoint>;
    if (value.strategy !== undefined && value.strategy !== "summary" || !Array.isArray(value.branchIds) || !isBranchPrefix(value.branchIds, branchIds)
      || !Number.isSafeInteger(value.sourceCount) || value.sourceCount! > messages.length
      || typeof value.sourceDigest !== "string" || typeof value.summary !== "string") continue;
    if (value.sourceDigest === await digest(messages.slice(0, value.sourceCount))) return {
      ...value,
      sourceUiCount: Number.isSafeInteger(value.sourceUiCount) ? value.sourceUiCount! : -1,
    } as SummaryCheckpoint;
  }
  return undefined;
}

export function summaryMessage(summary: string): ModelMessage {
  return { role: "user", content: SUMMARY_PREFIX + summary };
}

export async function effectiveContext(events: readonly LogEvent[], branchIds: readonly string[], raw: ModelMessage[]) {
  const checkpoint = await currentSummary(events, branchIds, raw);
  return { checkpoint, messages: checkpoint ? [summaryMessage(checkpoint.summary), ...raw.slice(checkpoint.sourceCount)] : raw };
}

export async function saveInheritedSummary(logger: EventLogger, conversationId: string, summary: string): Promise<void> {
  await logger.append({ type: "context.compacted", conversationId, content: {
    strategy: "summary", branchIds: [], sourceCount: 0, sourceUiCount: 0,
    sourceDigest: await digest([]), summary, inherited: true,
  } });
}

export function pendingContextChoice(events: readonly LogEvent[], branchIds: readonly string[]): boolean {
  let pending = false;
  for (const event of events) {
    if (event.type !== "context.choice.required" && event.type !== "context.choice.resolved") continue;
    const content = fromLogValue(event.content) as { branchIds?: string[] };
    if (Array.isArray(content?.branchIds) && isBranchPrefix(content.branchIds, branchIds)) pending = event.type === "context.choice.required";
  }
  return pending;
}

export async function contextPressure(options: {
  raw: ModelMessage[]; branchIds: string[]; events: LogEvent[]; model: ModelConfig;
  limit?: ModelLimit; signal?: AbortSignal;
}): Promise<{ limit: ModelLimit; estimated: number; threshold: number; messages: ModelMessage[] } | undefined> {
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal: options.signal });
  if (!limit) return undefined;
  const { messages } = await effectiveContext(options.events, options.branchIds, options.raw);
  const calibrated = [...options.events].reverse().find((event) => event.type === "context.estimate.calibrated");
  const scale = (fromLogValue(calibrated?.content) as { scale?: unknown } | undefined)?.scale;
  const estimated = Math.ceil(estimateInput(messages) * (typeof scale === "number" && Number.isFinite(scale) ? scale : 1));
  return { limit, estimated, threshold: Math.floor(inputBudget(limit) * 0.8), messages };
}

export async function summarizeContext(options: {
  raw: ModelMessage[]; branchIds: string[]; uiCount: number; model: ModelConfig;
  languageModel: LanguageModel; logger: EventLogger; conversationId: string;
  signal: AbortSignal; limit?: ModelLimit;
}): Promise<string> {
  const { raw, branchIds, logger, conversationId, signal } = options;
  const events = await logger.conversation(conversationId);
  const { messages } = await effectiveContext(events, branchIds, raw);
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal });
  if (!limit) throw new Error("无法取得模型上下文窗口；请手动设置窗口大小。");
  const maxOutputTokens = Math.max(128, Math.min(2048, Math.floor(inputBudget(limit) / 10)));
  const prompt = `Complete conversation:\n${JSON.stringify(messages)}`;
  if (estimateInput([{ role: "system", content: SUMMARY_INSTRUCTIONS }, { role: "user", content: prompt }]) + maxOutputTokens > limit.context) {
    throw new Error("完整历史超出摘要模型的上下文窗口；请换用更大窗口的模型。");
  }
  await logger.append({ type: "context.compaction.started", conversationId, content: { strategy: "summary", messageCount: messages.length, limit } });
  try {
    const result = await generateText({ model: options.languageModel, maxRetries: 0, maxOutputTokens,
      reasoning: "minimal", abortSignal: signal, system: SUMMARY_INSTRUCTIONS, prompt });
    const summary = result.text.trim();
    if (!summary) throw new Error("Model returned an empty context summary");
    await logger.append({ type: "model.compaction.finished", conversationId,
      content: { text: summary }, stopReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata });
    const checkpoint: SummaryCheckpoint = { strategy: "summary", branchIds, sourceCount: raw.length,
      sourceUiCount: options.uiCount, sourceDigest: await digest(raw), summary };
    await logger.append({ type: "context.compacted", conversationId, content: { ...checkpoint, limit } });
    return summary;
  } catch (error) {
    await logger.append({ type: signal.aborted ? "context.compaction.aborted" : "context.compaction.failed", conversationId,
      content: { strategy: "summary" }, ...(signal.aborted ? { abort: { reason: signal.reason } } : { error }) });
    throw error;
  }
}

export class ContextCompactor {
  private lastEstimate = 0;
  private warned = false;
  private events?: LogEvent[];

  constructor(private options: {
    model: ModelConfig; logger: EventLogger; conversationId: string;
    branchIds: string[]; signal: AbortSignal;
  }) {}

  recordUsage(inputTokens: number | undefined): void {
    if (!inputTokens || !this.lastEstimate) return;
    const scale = Math.max(0.5, Math.min(8, inputTokens / this.lastEstimate));
    this.options.logger.record({ type: "context.estimate.calibrated", conversationId: this.options.conversationId, content: { scale } });
  }

  async prepare(rawMessages: ModelMessage[], stepNumber: number): Promise<ModelMessage[] | undefined> {
    const { model, logger, conversationId, signal, branchIds } = this.options;
    signal.throwIfAborted();
    if (stepNumber > 0) { this.lastEstimate = estimateInput(rawMessages); return undefined; }
    const limit = await resolveModelLimit(model, { signal });
    if (!limit && !this.warned) {
      logger.record({ type: "context.limit.unavailable", conversationId, content: { model: model.model } });
      this.warned = true;
    }
    this.events ??= await logger.conversation(conversationId);
    const { messages } = await effectiveContext(this.events, branchIds, rawMessages);
    this.lastEstimate = estimateInput(messages);
    return messages === rawMessages ? undefined : messages;
  }
}
