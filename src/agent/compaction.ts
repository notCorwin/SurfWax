import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { fromLogValue, type EventLogger, type LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { inputBudget, resolveModelLimit, type ModelLimit } from "./model-limits";

const SUMMARY_PREFIX = "Earlier conversation summary:\n";
const SUMMARY_INSTRUCTIONS = "Summarize the conversation evidence faithfully for continuing the browser task. Preserve the user's goal, constraints, decisions, page and tab identities, browser side effects, tool results, errors, unresolved work, and exact values needed later. Do not invent facts. Return only the concise summary.";

type Checkpoint = {
  branchIds: string[];
  sourceCount: number;
  sourceDigest: string;
  summary: string;
  reusable: boolean;
};

function estimate(messages: readonly ModelMessage[]): number {
  return 1024 + Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).length / 3);
}

async function digest(messages: readonly ModelMessage[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkpointOf(event: LogEvent): Checkpoint | undefined {
  if (event.type !== "context.compacted") return undefined;
  const value = fromLogValue(event.content) as Partial<Checkpoint>;
  return Array.isArray(value?.branchIds) && typeof value.sourceCount === "number"
    && typeof value.sourceDigest === "string" && typeof value.summary === "string"
    && typeof value.reusable === "boolean" ? value as Checkpoint : undefined;
}

function isBranchPrefix(prefix: readonly string[], branch: readonly string[]): boolean {
  return prefix.length <= branch.length && prefix.every((id, index) => id === branch[index]);
}

async function reusableCheckpoint(events: readonly LogEvent[], branchIds: readonly string[], messages: readonly ModelMessage[]): Promise<Checkpoint | undefined> {
  for (const event of [...events].reverse()) {
    const checkpoint = checkpointOf(event);
    if (!checkpoint?.reusable || !isBranchPrefix(checkpoint.branchIds, branchIds) || checkpoint.sourceCount >= messages.length) continue;
    if (checkpoint.sourceDigest === await digest(messages.slice(0, checkpoint.sourceCount))) return checkpoint;
  }
  return undefined;
}

function summaryMessage(summary: string): ModelMessage {
  return { role: "user", content: SUMMARY_PREFIX + summary };
}

function lastRole(messages: readonly ModelMessage[], role: ModelMessage["role"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === role) return index;
  return -1;
}

function splitSource(source: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < source.length; index += chunkSize) chunks.push(source.slice(index, index + chunkSize));
  return chunks;
}

export class ContextCompactor {
  private scale = 1;
  private lastEstimate = 0;
  private warned = false;
  private events?: LogEvent[];
  private limitPromise?: Promise<ModelLimit | undefined>;

  constructor(private options: {
    model: ModelConfig;
    languageModel: LanguageModel;
    logger: EventLogger;
    conversationId: string;
    branchIds: string[];
    signal: AbortSignal;
    limit?: ModelLimit;
  }) {}

  recordUsage(inputTokens: number | undefined): void {
    if (inputTokens && this.lastEstimate) this.scale = Math.max(0.5, Math.min(8, inputTokens / this.lastEstimate));
  }

  async prepare(rawMessages: ModelMessage[], stepNumber: number): Promise<ModelMessage[] | undefined> {
    const { model, logger, conversationId, signal } = this.options;
    if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
    this.limitPromise ??= this.options.limit ? Promise.resolve(this.options.limit) : resolveModelLimit(model, { signal });
    const limit = await this.limitPromise;
    if (!limit) {
      if (!this.warned) logger.record({ type: "context.limit.unavailable", conversationId, content: { model: model.model } });
      this.warned = true;
      return undefined;
    }
    const budget = inputBudget(limit);
    if (budget <= 0) throw new Error("Model context window is too small for an output reserve");
    let messages = rawMessages;
    let applied: Checkpoint | undefined;
    if (stepNumber === 0) {
      this.events ??= await logger.conversation(conversationId);
      applied = await reusableCheckpoint(this.events, this.options.branchIds, rawMessages);
      if (applied) {
        messages = [summaryMessage(applied.summary), ...rawMessages.slice(applied.sourceCount)];
        logger.record({ type: "context.checkpoint.applied", conversationId, content: { sourceCount: applied.sourceCount, model: model.model } });
      }
    }
    this.lastEstimate = estimate(messages);
    if (this.lastEstimate * this.scale < budget * 0.8) return messages === rawMessages ? undefined : messages;

    const lastUser = lastRole(messages, "user");
    let start = 0;
    let cut = lastUser;
    if (cut > 0) {
      const previousUser = lastRole(messages.slice(0, cut), "user");
      if (previousUser > 0 && estimate([summaryMessage("Summary"), ...messages.slice(previousUser)]) * this.scale < budget * 0.7) {
        cut = previousUser;
      }
    }
    if (cut <= 0 || estimate(messages.slice(0, cut)) - 1024 < (this.lastEstimate - 1024) / 10) {
      // Within a turn, preserve the user's request and summarize complete tool exchanges.
      const lastAssistant = lastRole(messages, "assistant");
      if (lastUser < 0 || lastAssistant <= lastUser) return messages === rawMessages ? undefined : messages;
      start = lastUser + 1;
      cut = lastAssistant > start ? lastAssistant : messages.at(-1)?.role === "tool" ? messages.length : start;
    }
    const source = messages.slice(start, cut);
    if (source.length === 0) return messages === rawMessages ? undefined : messages;
    await logger.append({ type: "context.compaction.started", conversationId, content: { stepNumber, limit, estimatedInputTokens: Math.ceil(this.lastEstimate * this.scale) } });
    try {
      const maxOutputTokens = Math.max(128, Math.min(2048, Math.floor(budget / 10)));
      const sourceText = JSON.stringify(source);
      const chunks = splitSource(sourceText, Math.max(512, Math.min(40_000, Math.floor(budget))));
      let summary = "";
      let usage = 0;
      for (const [index, chunk] of chunks.entries()) {
        if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
        const result = await generateText({
          model: this.options.languageModel,
          maxRetries: 0,
          maxOutputTokens,
          reasoning: "minimal",
          abortSignal: signal,
          system: SUMMARY_INSTRUCTIONS,
          prompt: `${summary ? `Summary so far:\n${summary}\n\n` : ""}Source segment ${index + 1}/${chunks.length}:\n${chunk}`,
        });
        summary = result.text.trim();
        usage += result.usage.inputTokens ?? 0;
        await logger.append({
          type: "model.compaction.finished", conversationId,
          content: { segment: index + 1, segments: chunks.length, text: summary },
          stopReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata,
        });
        if (!summary) throw new Error("Model returned an empty context summary");
      }
      const compacted = [...messages.slice(0, start), summaryMessage(summary), ...messages.slice(cut)];
      if (estimate(compacted) >= this.lastEstimate) throw new Error("Context summary did not reduce the prompt");
      const sourceCount = applied && start === 0 ? applied.sourceCount + cut - 1 : cut;
      const reusable = stepNumber === 0 && start === 0;
      const checkpoint: Checkpoint = {
        branchIds: this.options.branchIds,
        sourceCount,
        sourceDigest: await digest(rawMessages.slice(0, sourceCount)),
        summary,
        reusable,
      };
      await logger.append({ type: "context.compacted", conversationId, content: { ...checkpoint, stepNumber, limit, inputBudget: budget, summaryUsageInputTokens: usage } });
      this.lastEstimate = estimate(compacted);
      return compacted;
    } catch (error) {
      await logger.append({ type: signal.aborted ? "context.compaction.aborted" : "context.compaction.failed", conversationId,
        content: { stepNumber, limit }, ...(signal.aborted ? { abort: { reason: signal.reason } } : { error }) });
      throw error;
    }
  }
}
