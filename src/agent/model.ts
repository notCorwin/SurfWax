import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";

const MAX_RETRY_DELAY_MS = 10_000;
const INITIAL_RETRY_DELAY_MS = 250;

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || error instanceof Error && error.name === "AbortError");
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof Error && error.name === "NetworkError";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

function retryDelay(attempt: number, random: () => number): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 6));
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(exponential * (0.5 + random())));
}

function waitForRetry(delayMs: number, signal?: AbortSignal, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void sleep(delayMs).then(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

export function createRetryingFetch(options: {
  logger?: EventLogger;
  fetch?: typeof globalThis.fetch;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  return async (input, init) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (request?.method ?? "GET");
    const signal = init?.signal ?? request?.signal;
    const startedAt = now();
    let retries = 0;

    while (true) {
      try {
        const response = await baseFetch(request ? request.clone() : input, init);
        if (!retryableStatus(response.status)) {
          options.logger?.record({
            type: "request.completed",
            content: { url, method, status: response.status, retries },
            latencyMs: Math.max(0, now() - startedAt),
          });
          return response;
        }

        retries += 1;
        const delayMs = retryDelay(retries, random);
        options.logger?.record({
          type: "request.retry",
          content: { url, method, status: response.status },
          retry: { attempt: retries, status: response.status, delayMs },
          latencyMs: Math.max(0, now() - startedAt),
        });
        if (response.body) await response.body.cancel().catch(() => undefined);
        await waitForRetry(delayMs, signal, options.sleep);
      } catch (error) {
        if (isAbortError(error, signal)) {
          options.logger?.record({
            type: "request.aborted",
            content: { url, method },
            abort: { reason: error instanceof Error ? error.message : String(error) },
            latencyMs: Math.max(0, now() - startedAt),
          });
          throw error;
        }

        if (!isNetworkError(error)) {
          options.logger?.record({
            type: "request.failed",
            content: { url, method, error },
            error,
            latencyMs: Math.max(0, now() - startedAt),
          });
          throw error;
        }

        retries += 1;
        const delayMs = retryDelay(retries, random);
        options.logger?.record({
          type: "request.retry",
          content: { url, method, error },
          retry: { attempt: retries, delayMs },
          latencyMs: Math.max(0, now() - startedAt),
        });
        await waitForRetry(delayMs, signal, options.sleep);
      }
    }
  };
}

export function createModel(config: ModelConfig, logger?: EventLogger): LanguageModel {
  if (!config.baseURL.trim()) throw new Error("Model base URL is required");
  if (!config.apiKey.trim()) throw new Error("Model API key is required");
  if (!config.model.trim()) throw new Error("Model id is required");

  const provider = createOpenAICompatible({
    name: "side-agent-provider",
    baseURL: config.baseURL.replace(/\/+$/, ""),
    apiKey: config.apiKey,
    fetch: createRetryingFetch({ logger }),
  });

  return provider.languageModel(config.model);
}
