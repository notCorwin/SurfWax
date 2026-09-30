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
  /** Older checkpoints remain readable; new checkpoints verify the summary as well as its source. */
  summaryDigest?: string;
  summary: string;
};

type AppliedSummary = SummaryCheckpoint & { eventId: number };

type EstimateCalibration = {
  branchIds: string[];
  contextVersion: number;
  baseEstimate: number;
  promptEstimate: number;
  inputTokens?: number;
};

function estimateValue(value: unknown): number {
  return 1024 + Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3);
}

export function estimateInput(messages: readonly ModelMessage[]): number {
  return estimateValue(messages);
}

export function estimatePromptInput(prompt: {
  instructions?: unknown; messages: readonly ModelMessage[]; tools?: readonly Record<string, unknown>[];
}): number {
  return estimateValue(prompt);
}

async function digestValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// SDK response messages and messages reconstructed from the UI may use a string or
// a single text part for the same content. Fingerprint their equivalent canonical form.
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized = "role" in record && typeof record.content === "string" && record.role !== "system"
    ? { ...record, content: [{ type: "text", text: record.content }] } : record;
  return Object.fromEntries(Object.keys(normalized).sort().filter((key) => normalized[key] !== undefined)
    .map((key) => [key, canonicalValue(normalized[key])]));
}

async function digest(messages: readonly ModelMessage[]): Promise<string> {
  return digestValue(canonicalValue(messages));
}

function isBranchPrefix(prefix: readonly string[], branch: readonly string[]): boolean {
  return prefix.length <= branch.length && prefix.every((id, index) => id === branch[index]);
}

export async function currentSummary(events: readonly LogEvent[], branchIds: readonly string[], messages: readonly ModelMessage[]): Promise<AppliedSummary | undefined> {
  for (const event of [...events].reverse()) {
    if (event.type !== "context.compacted") continue;
    const decoded = fromLogValue(event.content);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
    const value = decoded as Partial<SummaryCheckpoint>;
    if (value.strategy !== undefined && value.strategy !== "summary" || !Array.isArray(value.branchIds)
      || !value.branchIds.every((id) => typeof id === "string") || !isBranchPrefix(value.branchIds, branchIds)
      || !Number.isSafeInteger(value.sourceCount) || value.sourceCount! < 0 || value.sourceCount! > messages.length
      || typeof value.sourceDigest !== "string" || typeof value.summary !== "string" || !value.summary.trim()
      || value.summaryDigest !== undefined && value.summaryDigest !== await digestValue(value.summary)) continue;
    const source = messages.slice(0, value.sourceCount);
    if (value.sourceDigest === await digest(source)
      || value.summaryDigest === undefined && value.sourceDigest === await digestValue(source)) return {
      ...value,
      sourceUiCount: Number.isSafeInteger(value.sourceUiCount) ? value.sourceUiCount! : -1,
      eventId: event.id,
    } as AppliedSummary;
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
  instructions?: unknown; tools?: readonly Record<string, unknown>[];
}): Promise<{ limit: ModelLimit; estimated: number; threshold: number; messages: ModelMessage[] } | undefined> {
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal: options.signal });
  if (!limit) return undefined;
  const { checkpoint, messages } = await effectiveContext(options.events, options.branchIds, options.raw);
  const currentEstimate = estimateInput(messages);
  const contextVersion = checkpoint?.eventId ?? 0;
  const calibrated = [...options.events].reverse().find((event) => {
    if (event.type !== "context.estimate.calibrated") return false;
    const value = fromLogValue(event.content) as Partial<EstimateCalibration> | undefined;
    if (!value) return false;
    return Array.isArray(value.branchIds)
      && value.branchIds.every((id): id is string => typeof id === "string")
      && isBranchPrefix(value.branchIds, options.branchIds)
      && value.contextVersion === contextVersion
      && typeof value.baseEstimate === "number" && Number.isFinite(value.baseEstimate)
      && value.baseEstimate > 0 && value.baseEstimate <= currentEstimate
      && typeof value.promptEstimate === "number" && Number.isFinite(value.promptEstimate)
      && value.promptEstimate > 0;
  });
  const calibration = fromLogValue(calibrated?.content) as Partial<EstimateCalibration> | undefined;
  const anchor = typeof calibration?.inputTokens === "number" && Number.isFinite(calibration.inputTokens) && calibration.inputTokens > 0
    ? calibration.inputTokens : calibration?.promptEstimate;
  const estimated = Math.ceil(anchor && calibration?.baseEstimate
    ? anchor + currentEstimate - calibration.baseEstimate
    : options.instructions !== undefined || options.tools !== undefined
      ? estimatePromptInput({ instructions: options.instructions, messages, tools: options.tools }) : currentEstimate);
  return { limit, estimated, threshold: Math.floor(inputBudget(limit) * 0.8), messages };
}

export async function summarizeContext(options: {
  raw: ModelMessage[]; branchIds: string[]; uiCount: number; model: ModelConfig;
  languageModel: LanguageModel; logger: EventLogger; conversationId: string;
  signal: AbortSignal; limit?: ModelLimit;
  /** Runtime input may contain supplemental browser state. Only raw fingerprints persisted history. */
  prepared?: ModelMessage[]; stepNumber?: number;
}): Promise<string> {
  const { raw, branchIds, logger, conversationId, signal } = options;
  const events = await logger.conversation(conversationId);
  signal.throwIfAborted();
  const { messages } = await effectiveContext(events, branchIds, raw);
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal });
  if (!limit) throw new Error("无法取得模型上下文窗口；请手动设置窗口大小。");
  const summary = await generateSummary(options.prepared ?? messages, options.languageModel, logger, conversationId, signal, limit);
  signal.throwIfAborted();
  const checkpoint: SummaryCheckpoint = { strategy: "summary", branchIds, sourceCount: raw.length,
    sourceUiCount: options.uiCount, sourceDigest: await digest(raw), summaryDigest: await digestValue(summary), summary };
  signal.throwIfAborted();
  const stored = await logger.append({ type: "context.compacted", conversationId, content: { ...checkpoint, limit, stepNumber: options.stepNumber } });
  if (!stored) throw new Error("上下文摘要未能保存；请重试。");
  return summary;
}

async function generateSummary(messages: ModelMessage[], languageModel: LanguageModel, logger: EventLogger,
  conversationId: string, signal: AbortSignal, limit: ModelLimit): Promise<string> {
  await logger.append({ type: "context.compaction.started", conversationId, content: { strategy: "summary", messageCount: messages.length, limit } });
  try {
    const maxOutputTokens = Math.max(1, Math.min(limit.output ?? 2048, 2048, Math.max(128, Math.floor(inputBudget(limit) / 10))));
    const promptBudget = Math.min(limit.input ?? Number.POSITIVE_INFINITY, limit.context - maxOutputTokens);
    const fits = (prompt: string) => estimateInput([{ role: "system", content: SUMMARY_INSTRUCTIONS }, { role: "user", content: prompt }]) <= promptBudget;
    const generate = async (prompt: string, phase: "complete" | "chunk" | "merge", chunk?: number): Promise<string> => {
      signal.throwIfAborted();
      if (!fits(prompt)) throw new Error("摘要模型窗口过小，无法容纳摘要指令；请增大上下文窗口。");
      const result = await generateText({ model: languageModel, maxRetries: 0, maxOutputTokens,
        reasoning: "minimal", abortSignal: signal, system: SUMMARY_INSTRUCTIONS, prompt });
      signal.throwIfAborted();
      const summary = result.text.trim();
      if (!summary) throw new Error("Model returned an empty context summary");
      await logger.append({ type: "model.compaction.finished", conversationId,
        content: { text: summary, phase, chunk }, stopReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata });
      return summary;
    };
    // Split the serialized source, including an oversized individual tool result,
    // without dropping or rewriting any source bytes. Fragments are explicitly labeled.
    const split = (source: string, label: string): string[] => {
      const parts: string[] = [];
      let offset = 0;
      while (offset < source.length) {
        let low = 0;
        let high = source.length - offset;
        const prefix = `${label}, sequential fragment ${parts.length + 1} (may begin/end inside a value):\n`;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(prefix + source.slice(offset, offset + middle))) low = middle;
          else high = middle - 1;
        }
        // Keep a UTF-16 surrogate pair together at fragment boundaries.
        if (low > 0 && offset + low < source.length && /[\uD800-\uDBFF]/.test(source[offset + low - 1]!)) low -= 1;
        if (!low) throw new Error("摘要模型窗口过小，无法容纳摘要指令；请增大上下文窗口。");
        parts.push(prefix + source.slice(offset, offset + low));
        offset += low;
      }
      return parts;
    };
    const source = JSON.stringify(messages);
    const completePrompt = `Complete conversation:\n${source}`;
    if (fits(completePrompt)) return await generate(completePrompt, "complete");
    const prompts = split(source, "Serialized conversation source");
    let summaries: string[] = [];
    for (let index = 0; index < prompts.length; index += 1) summaries.push(await generate(prompts[index]!, "chunk", index));
    while (summaries.length > 1) {
      const mergedSource = JSON.stringify(summaries);
      const mergePrompt = `Merge these ordered summaries into one faithful continuation summary. Preserve all exact facts and unresolved work:\n${mergedSource}`;
      if (fits(mergePrompt)) return await generate(mergePrompt, "merge");
      const mergeParts = split(mergedSource, "Ordered intermediate summaries to merge");
      const next: string[] = [];
      for (let index = 0; index < mergeParts.length; index += 1) next.push(await generate(mergeParts[index]!, "merge", index));
      if (JSON.stringify(next).length >= mergedSource.length) throw new Error("摘要模型未缩短分块结果；原始历史已保留，请重试。");
      summaries = next;
    }
    return summaries[0]!;
  } catch (error) {
    await logger.append({ type: signal.aborted ? "context.compaction.aborted" : "context.compaction.failed", conversationId,
      content: { strategy: "summary" }, ...(signal.aborted ? { abort: { reason: signal.reason } } : { error }) });
    throw error;
  }
}

export class ContextCompactor {
  private calibration?: EstimateCalibration;
  private usageRecorded = false;
  private baseEstimate?: number;
  private contextVersion = 0;
  private warned = false;
  private events?: LogEvent[];
  private compactedBaseEstimate?: number;

  constructor(private options: {
    model: ModelConfig; logger: EventLogger; conversationId: string;
    branchIds: string[]; signal: AbortSignal;
  }) {}

  recordPrompt(prompt: { instructions?: unknown; messages: readonly ModelMessage[]; tools?: readonly Record<string, unknown>[] }): void {
    if (this.calibration) return;
    this.calibration = {
      branchIds: this.options.branchIds,
      contextVersion: this.contextVersion,
      baseEstimate: this.baseEstimate ?? estimateInput(prompt.messages),
      promptEstimate: estimatePromptInput(prompt),
    };
    this.options.logger.record({ type: "context.estimate.calibrated", conversationId: this.options.conversationId, content: this.calibration });
  }

  recordUsage(inputTokens: number | undefined, stepNumber: number): void {
    if (!inputTokens || !this.calibration || this.usageRecorded) return;
    this.usageRecorded = true;
    this.calibration = { ...this.calibration, inputTokens };
    this.options.logger.record({ type: "context.estimate.calibrated", conversationId: this.options.conversationId, content: { ...this.calibration, stepNumber } });
  }

  estimate(messages: readonly ModelMessage[], prompt?: {
    instructions?: unknown; tools?: readonly Record<string, unknown>[];
  }): number {
    const current = estimateInput(messages);
    const anchor = this.calibration?.inputTokens ?? this.calibration?.promptEstimate;
    return Math.ceil(anchor && this.calibration?.baseEstimate
      ? anchor + current - this.calibration.baseEstimate
      : prompt ? estimatePromptInput({ ...prompt, messages }) : current);
  }

  canCompact(messages: readonly ModelMessage[], limit: ModelLimit): boolean {
    // Summarizing an unchanged tiny tail cannot reduce fixed tool-schema overhead.
    return this.compactedBaseEstimate === undefined
      || estimateInput(messages) - this.compactedBaseEstimate >= inputBudget(limit) * 0.1;
  }

  async compact(raw: ModelMessage[], prepared: ModelMessage[], stepNumber: number,
    languageModel: LanguageModel, limit: ModelLimit): Promise<ModelMessage[]> {
    const { model, logger, conversationId, signal, branchIds } = this.options;
    signal.throwIfAborted();
    const summary = await summarizeContext({ raw, prepared, stepNumber, branchIds, uiCount: branchIds.length,
      model, languageModel, logger, conversationId, signal, limit });
    const messages = [summaryMessage(summary)];
    this.events = await logger.conversation(conversationId);
    this.contextVersion = (await currentSummary(this.events, branchIds, raw))?.eventId ?? 0;
    this.calibration = undefined;
    this.usageRecorded = false;
    this.baseEstimate = estimateInput(messages);
    this.compactedBaseEstimate = this.baseEstimate;
    return messages;
  }

  async prepare(rawMessages: ModelMessage[], stepNumber: number): Promise<ModelMessage[] | undefined> {
    const { model, logger, conversationId, signal, branchIds } = this.options;
    signal.throwIfAborted();
    if (stepNumber > 0) return undefined;
    const limit = await resolveModelLimit(model, { signal });
    if (!limit && !this.warned) {
      logger.record({ type: "context.limit.unavailable", conversationId, content: { model: model.model } });
      this.warned = true;
    }
    this.events ??= await logger.conversation(conversationId);
    const { checkpoint, messages } = await effectiveContext(this.events, branchIds, rawMessages);
    this.contextVersion = checkpoint?.eventId ?? 0;
    this.baseEstimate = estimateInput(messages);
    this.compactedBaseEstimate = checkpoint ? this.baseEstimate : undefined;
    return messages === rawMessages ? undefined : messages;
  }
}
