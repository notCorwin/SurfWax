import { createGateway } from "@ai-sdk/gateway";
import { noul, TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";
import { experimental_evaluate as evaluate, type ModelMessage } from "ai";
import { z } from "zod";
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
type JevBatchResponse = {
  model: string;
  answers: Record<string, { noul: number }>;
  usage: { input_tokens: number; output_tokens: number };
};
type JevEvaluator = (
  context: readonly ModelMessage[], candidates: readonly JevCandidate[], signal: AbortSignal,
) => Promise<JevBatchResponse>;
export type JevSelectorOptions = {
  evaluate?: JevEvaluator;
  fetch?: typeof globalThis.fetch;
  logger?: EventLogger;
  conversationId?: string;
};

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.object({ noul: z.number() }).passthrough()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

function stateFor(context: readonly ModelMessage[]) {
  return { conversation: JSON.stringify(context) };
}

function questionsFor(candidates: readonly JevCandidate[]) {
  return Object.fromEntries(candidates.map(({ index, message }) => [`m${index}`,
    noul({ instruction: KEEP_INSTRUCTIONS, message: JSON.stringify(message) }, { true: KEEP_TRUE, false: KEEP_FALSE })]));
}

function booleanQuestionsFor(candidates: readonly JevCandidate[]) {
  return Object.fromEntries(candidates.map(({ index, message }) => [`m${index}`, {
    type: "boolean" as const,
    instructions: { instruction: KEEP_INSTRUCTIONS, message: JSON.stringify(message) },
    criteria: { true: KEEP_TRUE, false: KEEP_FALSE },
  }]));
}

function withoutTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, "");
}

async function postJson(fetch: typeof globalThis.fetch, url: string, apiKey: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Jev request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response.json() as Promise<unknown>;
}

function evaluatorFor(config: JevConfig, options: JevSelectorOptions): JevEvaluator {
  if (options.evaluate) return options.evaluate;
  const retryingFetch = createRetryingFetch({ fetch: options.fetch, logger: options.logger, conversationId: options.conversationId });
  const baseURL = withoutTrailingSlash(config.baseURL);

  if (["typesafe", "litellm", "opper", "custom-systemone"].includes(config.provider)) {
    const client = new TypeSafeClient({
      apiKey: config.apiKey.trim(), baseURL, defaultModel: config.model.trim(), dangerouslyAllowBrowser: true,
      logLevel: "off", retry: { maxRetries: 0 }, fetch: retryingFetch as TypeSafeClientConfig["fetch"],
    });
    return async (context, candidates, signal) => responseSchema.parse(await client.systemOne({
      state: stateFor(context), questions: questionsFor(candidates), model: config.model.trim(),
    }, { signal }));
  }

  if (config.provider === "vercel") {
    const gateway = createGateway({ apiKey: config.apiKey.trim(), baseURL, fetch: retryingFetch });
    return async (context, candidates, signal) => {
      const result = await evaluate({
        model: gateway.evaluationModel(config.model.trim()),
        state: stateFor(context),
        questions: booleanQuestionsFor(candidates),
        maxRetries: 0,
        abortSignal: signal,
      });
      return {
        model: result.response.modelId,
        answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, { noul: answer.probability }])),
        usage: { input_tokens: result.usage.inputTokens ?? 0, output_tokens: result.usage.outputTokens ?? 0 },
      };
    };
  }

  return async (context, candidates, signal) => {
    const request = { state: stateFor(context), questions: questionsFor(candidates), model: config.model.trim() };
    const endpoint = config.provider === "openrouter" ? `${baseURL}/alpha/decisions`
      : config.provider === "cloudflare" ? `${baseURL}/run`
        : `${baseURL}/v1/decisions`;
    const body = config.provider === "cloudflare"
      ? { model: request.model, input: { state: request.state, questions: request.questions } }
      : request;
    return responseSchema.parse(await postJson(retryingFetch, endpoint, config.apiKey, body, signal));
  };
}

export class JevSelector {
  private readonly evaluate: JevEvaluator;
  constructor(private readonly config: JevConfig, options: JevSelectorOptions = {}) {
    this.evaluate = evaluatorFor(config, options);
  }

  async score(context: readonly ModelMessage[], candidates: readonly JevCandidate[], signal: AbortSignal): Promise<JevSelectionScores> {
    const probabilities = new Map<number, number>();
    let input_tokens = 0;
    let output_tokens = 0;
    let model = this.config.model;
    for (let start = 0; start < candidates.length; start += JEV_MAX_BATCH_MESSAGES) {
      signal.throwIfAborted();
      const batch = candidates.slice(start, start + JEV_MAX_BATCH_MESSAGES);
      const response = await this.evaluate(context, batch, signal);
      signal.throwIfAborted();
      model = response.model;
      input_tokens += response.usage.input_tokens;
      output_tokens += response.usage.output_tokens;
      for (const { index } of batch) {
        const probability = response.answers?.[`m${index}`]?.noul;
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
