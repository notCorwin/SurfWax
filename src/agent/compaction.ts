import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { fromLogValue, stringifyLogSafe, type EventLogger, type LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { createPromptSnapshot, readPromptSnapshot, PROMPT_TOOLS, type PromptSnapshot } from "./prompt";
import { inputBudget, resolveModelLimit, type ModelLimit } from "./model-limits";
import { retryModelOperation } from "./model";
import { modelDiagnosticContext } from "./diagnostics";
import { contextPrompt } from "./context-prompt";

export const SUMMARY_PREFIX = "Earlier conversation summary:\n";
const SUMMARY_INSTRUCTIONS = "Summarize the entire supplied conversation faithfully so another agent can continue the browser task. Record the original goal and constraints; unfinished steps and blockers; verified facts and their sources; page and tab identities; completed or uncertain side effects and errors; recovery instructions; and exact data, identifiers, URLs and artifact references needed later. Distinguish verified outcomes from assumptions and dispatched actions. Do not invent facts. Return only the continuation summary.";

export type SummaryCheckpoint = {
  strategy: "summary";
  branchIds: string[];
  sourceCount: number;
  sourceUiCount: number;
  sourceDigest: string;
  /** Older checkpoints remain readable; new checkpoints verify the summary as well as its source. */
  summaryDigest?: string;
  summary: string;
  userAnchors?: number[];
  userAnchorArtifactId?: number;
  /** Estimate immediately after this checkpoint was committed, excluding later appended messages. */
  compactedInputEstimate?: number;
  prompt?: PromptSnapshot;
};

type AppliedSummary = SummaryCheckpoint & { eventId: number };

type EstimateCalibration = {
  branchIds: string[];
  contextVersion: number;
  modelDigest: string;
  baseCount: number;
  baseDigest: string;
  baseEstimate: number;
  promptEstimate: number;
  inputTokens?: number;
  fixedEstimate?: number;
};

function estimateValue(value: unknown): number {
  return 1024 + Math.ceil(new TextEncoder().encode(stringifyLogSafe(value)).length / 3);
}

export function estimateInput(messages: readonly ModelMessage[]): number {
  return estimateValue(messages);
}

/** Fixed instructions and schemas cannot be reduced by summarizing a tiny task. */
export function hasSummarizableHistory(messages: readonly ModelMessage[], limit: ModelLimit): boolean {
  return estimateInput(messages) - estimateInput([]) >= Math.min(1024, inputBudget(limit) * 0.1);
}

export function estimatePromptInput(prompt: {
  instructions?: unknown; messages: readonly ModelMessage[]; tools?: readonly Record<string, unknown>[];
}): number {
  return estimateValue(prompt);
}

async function digestValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stringifyLogSafe(value));
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

async function modelDigest(model: ModelConfig): Promise<string> {
  return digestValue([model.providerId, model.sdk, model.baseURLOverride ?? model.baseURL,
    model.model, model.endpointType, model.modelProvider, model.imageInput]);
}

function isBranchPrefix(prefix: readonly string[], branch: readonly string[]): boolean {
  return prefix.length <= branch.length && prefix.every((id, index) => id === branch[index]);
}

export async function currentSummary(events: readonly LogEvent[], branchIds: readonly string[], messages: readonly ModelMessage[]): Promise<AppliedSummary | undefined> {
  for (const event of [...events].reverse()) {
    if (event.type !== "context.compacted") continue;
    const decoded = fromLogValue(event.content, event.valueEncoding);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
    const value = decoded as Partial<SummaryCheckpoint>;
    if (value.strategy !== undefined && value.strategy !== "summary" || !Array.isArray(value.branchIds)
      || !value.branchIds.every((id) => typeof id === "string") || !isBranchPrefix(value.branchIds, branchIds)
      || !Number.isSafeInteger(value.sourceCount) || value.sourceCount! < 0 || value.sourceCount! > messages.length
      || typeof value.sourceDigest !== "string" || typeof value.summary !== "string" || !value.summary.trim()
      || value.userAnchors !== undefined && (!Array.isArray(value.userAnchors)
        || !value.userAnchors.every((index) => Number.isSafeInteger(index) && index >= 0 && index < value.sourceCount! && messages[index]?.role === "user"))
      || value.userAnchorArtifactId !== undefined && (!Number.isSafeInteger(value.userAnchorArtifactId) || value.userAnchorArtifactId <= 0)
      || value.compactedInputEstimate !== undefined && (typeof value.compactedInputEstimate !== "number"
        || !Number.isFinite(value.compactedInputEstimate) || value.compactedInputEstimate <= 0)
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
  return { checkpoint, messages: checkpoint ? checkpointMessages(checkpoint, raw) : raw };
}

function checkpointMessages(checkpoint: SummaryCheckpoint, raw: ModelMessage[]): ModelMessage[] {
  return [...(checkpoint.userAnchors ?? []).map((index) => raw[index]!),
    ...(checkpoint.userAnchorArtifactId ? [{ role: "user" as const, content: `Earlier user messages are available in full via read_artifact with artifactId ${checkpoint.userAnchorArtifactId}, path ["messages"]. Page the array as needed; each entry contains its original message index and content.` }] : []),
    summaryMessage(checkpoint.summary), ...raw.slice(checkpoint.sourceCount)];
}

function isUserAnchor(message: ModelMessage): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return !text.startsWith("<browser-context>\nSupplemental state only.") && !text.startsWith("Goal mode is still active.") && !text.startsWith("Tool-call protocol recovery:");
}

/** Keep recent complete turns. A tool result cannot be separated from its call. */
function summarySourceCount(raw: readonly ModelMessage[], limit: ModelLimit): number {
  if (raw.length < 4) return raw.length;
  const tailBytes = Math.max(0, (Math.floor(inputBudget(limit) * 0.25) - 1024) * 3);
  const encoder = new TextEncoder();
  let bytes = 2;
  let cut = raw.length;
  while (cut > 1) {
    let start = cut - 1;
    while (start > 0 && raw[start]?.role === "tool") start--;
    if (start === 0) break;
    let groupBytes = 0;
    for (let index = start; index < cut; index++) groupBytes += encoder.encode(stringifyLogSafe(raw[index])).length + 1;
    if (bytes + groupBytes > tailBytes) break;
    bytes += groupBytes;
    cut = start;
  }
  return cut;
}

export async function contextPressure(options: {
  raw: ModelMessage[]; branchIds: string[]; events: LogEvent[]; model: ModelConfig;
  limit?: ModelLimit; signal?: AbortSignal;
  logger?: EventLogger; conversationId?: string;
  instructions?: unknown; tools?: readonly Record<string, unknown>[]; goalMode?: boolean;
}): Promise<{ limit: ModelLimit; estimated: number; threshold: number; messages: ModelMessage[] } | undefined> {
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal: options.signal, diagnosticContext: modelDiagnosticContext(options.logger, options.conversationId) });
  if (!limit) return undefined;
  const { checkpoint, messages } = await effectiveContext(options.events, options.branchIds, options.raw);
  const currentEstimate = estimateInput(messages);
  const contextVersion = checkpoint?.eventId ?? 0;
  const identity = await modelDigest(options.model);
  const prefixDigests = new Map<number, string>();
  let calibration: Partial<EstimateCalibration> | undefined;
  for (const event of [...options.events].reverse()) {
    if (event.type !== "context.estimate.calibrated") continue;
    const value = fromLogValue(event.content, event.valueEncoding) as Partial<EstimateCalibration> | undefined;
    if (!value || !Array.isArray(value.branchIds)
      || !value.branchIds.every((id): id is string => typeof id === "string")
      || !isBranchPrefix(value.branchIds, options.branchIds)
      || value.contextVersion !== contextVersion || value.modelDigest !== identity
      || !Number.isSafeInteger(value.baseCount) || value.baseCount! < 0 || value.baseCount! > messages.length
      || typeof value.baseDigest !== "string"
      || typeof value.baseEstimate !== "number" || !Number.isFinite(value.baseEstimate)
      || value.baseEstimate <= 0
      || typeof value.promptEstimate !== "number" || !Number.isFinite(value.promptEstimate)
      || value.promptEstimate <= 0) continue;
    const count = value.baseCount!;
    let prefixDigest = prefixDigests.get(count);
    if (!prefixDigest) {
      prefixDigest = await digest(messages.slice(0, count));
      prefixDigests.set(count, prefixDigest);
    }
    if (prefixDigest === value.baseDigest) { calibration = value; break; }
  }
  const anchor = typeof calibration?.inputTokens === "number" && Number.isFinite(calibration.inputTokens) && calibration.inputTokens > 0
    ? calibration.inputTokens : calibration?.promptEstimate;
  const snapshot = readPromptSnapshot(options.events, options.branchIds) ?? createPromptSnapshot();
  const fixed = contextPrompt(snapshot, options.goalMode);
  const prompt = { instructions: options.instructions ?? fixed.instructions, tools: options.tools ?? fixed.tools, messages };
  const fixedEstimate = estimatePromptInput(prompt) - currentEstimate;
  const estimated = Math.max(0, Math.ceil(anchor && calibration?.baseEstimate
    ? anchor + currentEstimate - calibration.baseEstimate + (calibration.fixedEstimate !== undefined ? fixedEstimate - calibration.fixedEstimate : 0)
    : estimatePromptInput(prompt)));
  return { limit, estimated, threshold: Math.floor(inputBudget(limit) * 0.8), messages };
}

export async function summarizeContext(options: {
  raw: ModelMessage[]; branchIds: string[]; uiCount: number; model: ModelConfig;
  languageModel: LanguageModel; logger: EventLogger; conversationId: string;
  signal: AbortSignal; limit?: ModelLimit;
  /** Runtime input may contain supplemental browser state. Only raw fingerprints persisted history. */
  prepared?: ModelMessage[]; stepNumber?: number; prompt?: PromptSnapshot; force?: boolean;
}): Promise<string> {
  const { raw, branchIds, logger, conversationId, signal } = options;
  const events = await logger.conversation(conversationId);
  signal.throwIfAborted();
  const { checkpoint: priorCheckpoint, messages: previousMessages } = await effectiveContext(events, branchIds, raw);
  // Every trigger (in-run pressure, overflow recovery, and post-turn upkeep)
  // converges here. Reuse an already committed checkpoint for the exact same
  // branch instead of allowing sequential triggers to summarize it twice.
  const limit = options.limit ?? await resolveModelLimit(options.model, { signal, diagnosticContext: modelDiagnosticContext(logger, conversationId) });
  if (!limit) throw new Error("无法取得模型上下文窗口；请手动设置窗口大小。");
  const sourceCount = options.force ? raw.length : summarySourceCount(raw, limit);
  if (!options.force && priorCheckpoint && sourceCount <= priorCheckpoint.sourceCount) return priorCheckpoint.summary;
  const source = priorCheckpoint
    ? [summaryMessage(priorCheckpoint.summary), ...raw.slice(priorCheckpoint.sourceCount, sourceCount)]
    : raw.slice(0, sourceCount);
  const summary = await generateSummary(source, options.languageModel, logger, conversationId, signal, limit);
  signal.throwIfAborted();
  const userIndices = raw.slice(0, sourceCount).flatMap((message, index) => isUserAnchor(message) ? [index] : []);
  const anchorBudgetBytes = Math.max(0, Math.min(Math.floor(inputBudget(limit) * 0.1) * 3,
    options.force ? Math.floor((estimateInput(previousMessages) - 1024) * 0.3) : Number.POSITIVE_INFINITY));
  const encoder = new TextEncoder();
  const chosen = new Set<number>();
  let anchorBytes = 0;
  // Preserve the original goal first, then the latest corrections within the budget.
  for (const index of [userIndices[0], ...userIndices.slice(1).reverse()]) {
    if (index === undefined) continue;
    const bytes = encoder.encode(stringifyLogSafe(raw[index])).length + 1;
    if (anchorBytes + bytes <= anchorBudgetBytes) { chosen.add(index); anchorBytes += bytes; }
  }
  const userAnchors = userIndices.filter((index) => chosen.has(index));
  const omitted = userIndices.filter((index) => !chosen.has(index));
  let userAnchorArtifactId: number | undefined;
  const previousAnchors = new Set(priorCheckpoint?.userAnchors);
  const previousOmitted = priorCheckpoint?.userAnchorArtifactId
    ? raw.slice(0, priorCheckpoint.sourceCount).flatMap((message, index) => isUserAnchor(message) && !previousAnchors.has(index) ? [index] : []) : [];
  if (omitted.length && previousOmitted.length === omitted.length && omitted.every((index, offset) => index === previousOmitted[offset])) {
    userAnchorArtifactId = priorCheckpoint!.userAnchorArtifactId;
  } else if (omitted.length) {
    const artifact = await logger.append({ type: "tool.result.data", conversationId, content: { purpose: "compacted-user-messages" },
      output: { messages: omitted.map((index) => ({ index, message: raw[index] })) } });
    if (!artifact) throw new Error("用户原文未能保存；原始历史已保留。");
    userAnchorArtifactId = artifact.id;
  }
  const checkpoint: SummaryCheckpoint = { strategy: "summary", branchIds, sourceCount,
    sourceUiCount: options.uiCount, sourceDigest: await digest(raw.slice(0, sourceCount)), summaryDigest: await digestValue(summary), summary,
    userAnchors, ...(userAnchorArtifactId ? { userAnchorArtifactId } : {}),
    prompt: createPromptSnapshot((options.prompt ?? readPromptSnapshot(events, branchIds))?.source) };
  signal.throwIfAborted();
  const projected = checkpointMessages(checkpoint, raw);
  if (estimateInput(projected) >= estimateInput(previousMessages)) {
    if (!options.force) return summarizeContext({ ...options, force: true });
    throw new Error("上下文压缩未能缩短历史；原始历史已保留。请调整上下文窗口或减少固定提示与工具开销。");
  }
  const stored = await logger.append({ type: "context.compacted", conversationId,
    content: { ...checkpoint, compactedInputEstimate: estimateInput(projected), limit, stepNumber: options.stepNumber } });
  if (!stored) throw new Error("上下文摘要未能保存；请重试。");
  return summary;
}

async function generateSummary(messages: ModelMessage[], languageModel: LanguageModel, logger: EventLogger,
  conversationId: string, signal: AbortSignal, limit: ModelLimit): Promise<string> {
  await logger.append({ type: "context.compaction.started", conversationId, content: { strategy: "summary", messageCount: messages.length, limit } });
  try {
    const outputCap = Math.max(1, Math.min(limit.output ?? limit.context, Math.floor(inputBudget(limit) / 4)));
    const maxOutputTokens = Math.min(outputCap, Math.max(256, Math.ceil(estimateInput(messages) / 3)));
    const promptBudget = Math.min(limit.input ?? Number.POSITIVE_INFINITY, limit.context - outputCap);
    const fits = (prompt: string) => estimateInput([{ role: "system", content: SUMMARY_INSTRUCTIONS }, { role: "user", content: prompt }]) <= promptBudget;
    const generate = async (prompt: string, phase: "complete" | "chunk" | "merge", chunk?: number): Promise<string> => {
      signal.throwIfAborted();
      if (!fits(prompt)) throw new Error("摘要模型窗口过小，无法容纳摘要指令；请增大上下文窗口。");
      let budget = maxOutputTokens;
      let result;
      while (true) {
        result = await retryModelOperation(() => generateText({ model: languageModel, maxRetries: 0, maxOutputTokens: budget,
          reasoning: "minimal", abortSignal: signal, system: SUMMARY_INSTRUCTIONS, prompt }),
        { signal, logger, conversationId, purpose: "summary" });
        if (result.finishReason !== "length" || budget >= outputCap) break;
        budget = Math.min(outputCap, budget * 2);
      }
      signal.throwIfAborted();
      if (result.finishReason === "length") throw new Error("摘要因输出长度限制被截断；原始历史已保留。");
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
    const source = stringifyLogSafe(messages)!;
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
  prompt?: PromptSnapshot;
  private calibration?: EstimateCalibration;
  private baseEstimate?: number;
  private baseCount = 0;
  private baseDigest = "";
  private modelDigest = "";
  private contextVersion = 0;
  private warned = false;
  private events?: LogEvent[];
  private compactedBaseEstimate?: number;

  constructor(private options: {
    model: ModelConfig; logger: EventLogger; conversationId: string;
    branchIds: string[]; signal: AbortSignal; prompt?: PromptSnapshot;
  }) { this.prompt = options.prompt; }

  useBranch(branchIds: string[]): void { this.options.branchIds = branchIds; }

  recordPrompt(prompt: { instructions?: unknown; messages: readonly ModelMessage[]; tools?: readonly Record<string, unknown>[] }): void {
    const promptEstimate = this.estimate(prompt.messages, prompt);
    this.calibration = {
      branchIds: this.options.branchIds,
      contextVersion: this.contextVersion,
      modelDigest: this.modelDigest,
      baseCount: this.baseCount,
      baseDigest: this.baseDigest,
      baseEstimate: this.baseEstimate ?? estimateInput(prompt.messages),
      promptEstimate,
      fixedEstimate: estimatePromptInput(prompt) - estimateInput(prompt.messages),
    };
    void this.options.logger.append({ type: "context.estimate.calibrated", conversationId: this.options.conversationId, content: this.calibration });
  }

  recordUsage(inputTokens: number | undefined, stepNumber: number): void {
    if (!inputTokens || !this.calibration) return;
    this.calibration = { ...this.calibration, inputTokens };
    void this.options.logger.append({ type: "context.estimate.calibrated", conversationId: this.options.conversationId, content: { ...this.calibration, stepNumber } });
  }

  async recordBase(messages: readonly ModelMessage[]): Promise<void> {
    this.baseEstimate = estimateInput(messages);
    this.baseCount = messages.length;
    this.baseDigest = await digest(messages);
  }

  estimate(messages: readonly ModelMessage[], prompt?: {
    instructions?: unknown; tools?: readonly Record<string, unknown>[];
  }): number {
    const current = estimateInput(messages);
    const anchor = this.calibration?.inputTokens ?? this.calibration?.promptEstimate;
    return Math.ceil(anchor && this.calibration?.baseEstimate
      ? anchor + current - this.calibration.baseEstimate + (prompt && this.calibration.fixedEstimate !== undefined
        ? estimatePromptInput({ ...prompt, messages }) - current - this.calibration.fixedEstimate : 0)
      : prompt ? estimatePromptInput({ ...prompt, messages }) : current);
  }

  canCompact(messages: readonly ModelMessage[], limit: ModelLimit): boolean {
    if (!hasSummarizableHistory(messages, limit)) return false;
    // Summarizing an unchanged tiny tail cannot reduce fixed tool-schema overhead.
    return this.compactedBaseEstimate === undefined
      || estimateInput(messages) - this.compactedBaseEstimate >= inputBudget(limit) * 0.1;
  }

  async compact(raw: ModelMessage[], prepared: ModelMessage[], stepNumber: number,
    languageModel: LanguageModel, limit: ModelLimit, force = false): Promise<ModelMessage[]> {
    const { model, logger, conversationId, signal, branchIds } = this.options;
    signal.throwIfAborted();
    await summarizeContext({ raw, prepared, stepNumber, branchIds, uiCount: branchIds.length,
      model, languageModel, logger, conversationId, signal, limit, prompt: this.prompt, force });
    this.events = await logger.conversation(conversationId);
    let { checkpoint, messages } = await effectiveContext(this.events, branchIds, raw);
    if (!force && estimateInput(messages) >= estimateInput(prepared)) {
      await summarizeContext({ raw, prepared, stepNumber, branchIds, uiCount: branchIds.length,
        model, languageModel, logger, conversationId, signal, limit, prompt: this.prompt, force: true });
      this.events = await logger.conversation(conversationId);
      ({ checkpoint, messages } = await effectiveContext(this.events, branchIds, raw));
    }
    this.prompt = checkpoint?.prompt ?? this.prompt;
    this.contextVersion = checkpoint?.eventId ?? 0;
    this.calibration = undefined;
    this.baseEstimate = estimateInput(messages);
    this.baseCount = messages.length;
    [this.baseDigest, this.modelDigest] = await Promise.all([digest(messages), modelDigest(model)]);
    this.compactedBaseEstimate = this.baseEstimate;
    return messages;
  }

  async prepare(rawMessages: ModelMessage[], stepNumber: number): Promise<ModelMessage[] | undefined> {
    const { model, logger, conversationId, signal, branchIds } = this.options;
    signal.throwIfAborted();
    if (stepNumber > 0) return undefined;
    const limit = await resolveModelLimit(model, { signal, diagnosticContext: modelDiagnosticContext(logger, conversationId) });
    if (!limit && !this.warned) {
      void logger.append({ type: "context.limit.unavailable", conversationId, content: { model: model.model } });
      this.warned = true;
    }
    this.events ??= await logger.conversation(conversationId);
    const { checkpoint, messages } = await effectiveContext(this.events, branchIds, rawMessages);
    this.prompt = this.prompt ?? readPromptSnapshot(this.events, branchIds);
    this.contextVersion = checkpoint?.eventId ?? 0;
    this.baseEstimate = estimateInput(messages);
    this.baseCount = messages.length;
    [this.baseDigest, this.modelDigest] = await Promise.all([digest(messages), modelDigest(model)]);
    this.compactedBaseEstimate = checkpoint ? checkpoint.compactedInputEstimate
      ?? estimateInput(checkpointMessages(checkpoint, rawMessages.slice(0, checkpoint.sourceCount))) : undefined;
    return messages === rawMessages ? undefined : messages;
  }
}
