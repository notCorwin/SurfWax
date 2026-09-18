import { noul, TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";
import type { ModelMessage } from "ai";
import type { EventLogger } from "../logging";
import type { JevConfig } from "../types";
import { createRetryingFetch } from "./model";

export const JEV_MAX_BATCH_MESSAGES = 255;
const KEEP_INSTRUCTIONS = "Considering the entire browser conversation, should this message remain in context for continuing the task?";
const KEEP_TRUE = "It contains a useful constraint, decision, durable fact, browser state, tool evidence, or unresolved work.";
const KEEP_FALSE = "It is redundant, stale, or unlikely to help continue the task.";

export type JevCandidate = { index: number; message: ModelMessage };
export type JevSelectionScores = {
  probabilities: Map<number, number>;
  batches: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
};
type JevClient = Pick<TypeSafeClient, "systemOne">;
export type JevSelectorOptions = { client?: JevClient; fetch?: typeof globalThis.fetch; logger?: EventLogger; conversationId?: string };

function questionsFor(candidates: readonly JevCandidate[]) {
  return Object.fromEntries(candidates.map(({ index, message }) => [`m${index}`,
    noul({ instruction: KEEP_INSTRUCTIONS, message: JSON.stringify(message) }, { true: KEEP_TRUE, false: KEEP_FALSE })]));
}

function clientFor(config: JevConfig, options: JevSelectorOptions): JevClient {
  if (options.client) return options.client;
  const fetch = createRetryingFetch({ fetch: options.fetch, logger: options.logger, conversationId: options.conversationId });
  return new TypeSafeClient({
    apiKey: config.apiKey.trim(), baseURL: config.baseURL.trim().replace(/\/+$/, ""), defaultModel: config.model.trim(),
    dangerouslyAllowBrowser: true, logLevel: "off", retry: { maxRetries: 0 }, fetch: fetch as TypeSafeClientConfig["fetch"],
  });
}

export class JevSelector {
  private readonly client: JevClient;
  constructor(private readonly config: JevConfig, options: JevSelectorOptions = {}) { this.client = clientFor(config, options); }

  async score(context: readonly ModelMessage[], candidates: readonly JevCandidate[], signal: AbortSignal): Promise<JevSelectionScores> {
    const probabilities = new Map<number, number>();
    let input_tokens = 0;
    let output_tokens = 0;
    let model = this.config.model;
    for (let start = 0; start < candidates.length; start += JEV_MAX_BATCH_MESSAGES) {
      signal.throwIfAborted();
      const batch = candidates.slice(start, start + JEV_MAX_BATCH_MESSAGES);
      const response = await this.client.systemOne({
        state: { conversation: JSON.stringify(context) }, questions: questionsFor(batch), model: this.config.model,
      }, { signal });
      signal.throwIfAborted();
      model = response.model;
      input_tokens += response.usage.input_tokens;
      output_tokens += response.usage.output_tokens;
      const answers = response.answers as Record<string, { noul?: unknown }>;
      for (const { index } of batch) {
        const probability = answers?.[`m${index}`]?.noul;
        if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error(`Jev returned an invalid score for message ${index}`);
        }
        probabilities.set(index, probability);
      }
    }
    return { probabilities, batches: Math.ceil(candidates.length / JEV_MAX_BATCH_MESSAGES),
      usage: { input_tokens, output_tokens }, model };
  }
}
