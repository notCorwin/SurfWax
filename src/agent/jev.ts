import { noul, TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";
import type { ModelMessage } from "ai";
import type { EventLogger } from "../logging";
import type { JevConfig } from "../types";
import { createRetryingFetch } from "./model";

export const JEV_MAX_BATCH_MESSAGES = 64;
export const JEV_MAX_BATCH_BYTES = 256 * 1024;
export const JEV_MESSAGE_PREVIEW_CHARS = 4_000;

const KEEP_INSTRUCTIONS = "Should this message be retained as context for continuing the current browser task?";
const KEEP_TRUE = "It contains a user constraint, decision, durable fact, browser state, useful tool evidence, or unresolved work that may be needed later.";
const KEEP_FALSE = "It is redundant, stale, transient narration, or otherwise unlikely to help continue the current task.";

export type JevCandidate = {
  index: number;
  message: ModelMessage;
};

export type JevSelectionScores = {
  probabilities: Map<number, number>;
  batches: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
};

type JevClient = Pick<TypeSafeClient, "systemOne">;

export type JevSelectorOptions = {
  client?: JevClient;
  fetch?: typeof globalThis.fetch;
  logger?: EventLogger;
  conversationId?: string;
};

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  try { return JSON.stringify(message.content); } catch { return String(message.content); }
}

function previewText(text: string): string {
  if (text.length <= JEV_MESSAGE_PREVIEW_CHARS) return text;
  const marker = "\n[…truncated…]\n";
  const edge = Math.floor(JEV_MESSAGE_PREVIEW_CHARS / 2);
  return `${text.slice(0, edge)}${marker}${text.slice(-edge)}`;
}

export function previewMessage(message: ModelMessage): string {
  return previewText(messageText(message));
}

function questionsFor(candidates: readonly JevCandidate[]) {
  return Object.fromEntries(candidates.map(({ index }) => [
    `m${index}`,
    noul(KEEP_INSTRUCTIONS, { true: KEEP_TRUE, false: KEEP_FALSE }),
  ]));
}

function stateFor(task: string, candidates: readonly JevCandidate[]) {
  return {
    task: previewText(task),
    messages: candidates.map(({ index, message }) => ({
      id: `m${index}`,
      index,
      role: message.role,
      content: previewMessage(message),
    })),
  };
}

function requestBytes(task: string, candidates: readonly JevCandidate[]): number {
  const body = { state: stateFor(task, candidates), questions: questionsFor(candidates) };
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

function batches(task: string, candidates: readonly JevCandidate[]): JevCandidate[][] {
  const result: JevCandidate[][] = [];
  let current: JevCandidate[] = [];
  for (const candidate of candidates) {
    const next = [...current, candidate];
    if (current.length > 0 && (next.length > JEV_MAX_BATCH_MESSAGES || requestBytes(task, next) > JEV_MAX_BATCH_BYTES)) {
      result.push(current);
      current = [candidate];
    } else {
      current = next;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function clientFor(config: JevConfig, options: JevSelectorOptions): JevClient {
  if (options.client) return options.client;
  const fetch = createRetryingFetch({
    fetch: options.fetch,
    logger: options.logger,
    conversationId: options.conversationId,
  });
  return new TypeSafeClient({
    apiKey: config.apiKey.trim(),
    baseURL: config.baseURL.trim().replace(/\/+$/, ""),
    defaultModel: config.model.trim(),
    dangerouslyAllowBrowser: true,
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: fetch as TypeSafeClientConfig["fetch"],
  });
}

export class JevSelector {
  private readonly client: JevClient;

  constructor(private readonly config: JevConfig, options: JevSelectorOptions = {}) {
    this.client = clientFor(config, options);
  }

  async score(task: string, candidates: readonly JevCandidate[], signal: AbortSignal): Promise<JevSelectionScores> {
    const probabilities = new Map<number, number>();
    const requestBatches = batches(task, candidates);
    let input_tokens = 0;
    let output_tokens = 0;
    let model = this.config.model;

    for (const batch of requestBatches) {
      signal.throwIfAborted();
      const response = await this.client.systemOne({
        state: stateFor(task, batch),
        questions: questionsFor(batch),
        model: this.config.model,
      }, { signal });
      model = response.model;
      input_tokens += response.usage.input_tokens;
      output_tokens += response.usage.output_tokens;
      const answers = response.answers as Record<string, { noul?: unknown }>;
      for (const { index } of batch) {
        const probability = answers[`m${index}`]?.noul;
        probabilities.set(index, typeof probability === "number" && Number.isFinite(probability)
          ? Math.max(0, Math.min(1, probability)) : 0);
      }
    }

    return { probabilities, batches: requestBatches.length, usage: { input_tokens, output_tokens }, model };
  }
}

export type JevSelectionScorer = Pick<JevSelector, "score">;
