import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { REASONING_EFFORTS, reasoningSettingsFor, type ReasoningEffort, type ReasoningSettings } from "./reasoning";

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

async function reasoningEffortOf(request: Request): Promise<ReasoningEffort | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  try {
    const body = JSON.parse(await request.clone().text()) as { reasoning_effort?: unknown };
    return REASONING_EFFORTS.find((effort) => effort === body.reasoning_effort);
  } catch {
    return undefined;
  }
}

async function withReasoningEffort(request: Request, effort: ReasoningEffort | null): Promise<Request> {
  const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
  if (effort === null) delete body.reasoning_effort;
  else body.reasoning_effort = effort;
  return new Request(request, { body: JSON.stringify(body) });
}

async function reasoningRejection(response: Response): Promise<{ fieldUnsupported: boolean; supported?: ReasoningEffort[] } | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  const message = (await response.clone().text().catch(() => "")).toLowerCase();
  if (!/reasoning[\s_-]*(effort|level)?/.test(message)) return undefined;
  const fieldUnsupported = /(?:unknown|unrecognized|unexpected|unsupported|not permitted)[\s_-]+(?:parameter|field)[\s_-]*["']?reasoning[\s_-]*effort/.test(message)
    || /reasoning[\s_-]*effort(?: parameter)? (?:is )?(?:unknown|unrecognized|not supported)/.test(message)
    || /(?:does not|doesn't) support (?:the )?reasoning/.test(message);
  if (fieldUnsupported) return { fieldUnsupported: true };
  if (!/(?:unsupported|invalid)\s+(?:value|parameter|field)[^.\n]{0,60}reasoning[\s_-]*effort|(?:unsupported|invalid)\s+reasoning[\s_-]*effort|reasoning[\s_-]*effort[^.\n]{0,60}(?:unsupported|invalid|not supported|not allowed|must be|expected)|(?:supported|allowed|valid)\s+reasoning[\s_-]*effort\s+values/.test(message)) return undefined;
  const listed = message.match(/(?:supported|allowed|valid)[^:\n]{0,90}(?:values|efforts)?\s*:\s*([^}\]\n]+)/)?.[1];
  const supported = listed ? REASONING_EFFORTS.filter((effort) => new RegExp(`\\b${effort}\\b`).test(listed)) : undefined;
  return { fieldUnsupported: false, ...(supported?.length ? { supported } : {}) };
}

export function createRetryingFetch(options: {
  logger?: EventLogger;
  conversationId?: string;
  fetch?: typeof globalThis.fetch;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  reasoningSettings?: ReasoningSettings;
} = {}): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let supportedReasoningEffort: ReasoningEffort | null | undefined;

  return async (input, init) => {
    await options.reasoningSettings?.ready;
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const originalRequest = request?.clone() ?? new Request(input, init);
    const requestedReasoningEffort = await reasoningEffortOf(originalRequest);
    let reasoningEffort: ReasoningEffort | null | undefined = options.reasoningSettings
      ? options.reasoningSettings.snapshot().selected
      : requestedReasoningEffort === undefined ? undefined
        : supportedReasoningEffort === undefined ? requestedReasoningEffort : supportedReasoningEffort;
    let activeRequest = options.reasoningSettings || supportedReasoningEffort !== undefined && requestedReasoningEffort !== undefined
      ? await withReasoningEffort(originalRequest, reasoningEffort ?? null)
      : originalRequest;
    const url = originalRequest.url;
    const method = originalRequest.method;
    const signal = originalRequest.signal;
    const startedAt = now();
    let retries = 0;

    while (true) {
      try {
        const response = await baseFetch(activeRequest.clone());
        const rejection = reasoningEffort == null ? undefined : await reasoningRejection(response);
        if (rejection) {
          retries += 1;
          const previousEffort = reasoningEffort!;
          const fallback = options.reasoningSettings
            ? options.reasoningSettings.reject(previousEffort, rejection.supported, rejection.fieldUnsupported)
            : rejection.fieldUnsupported ? null : rejection.supported?.find((candidate) => candidate !== previousEffort)
              ?? REASONING_EFFORTS[REASONING_EFFORTS.indexOf(previousEffort) + 1] ?? null;
          reasoningEffort = fallback;
          options.logger?.record({
            type: "request.retry",
            conversationId: options.conversationId,
            content: { url, method, status: response.status, rejectedReasoningEffort: previousEffort, reasoningEffort: fallback ?? "provider-default" },
            retry: { attempt: retries, status: response.status, delayMs: 0 },
            latencyMs: Math.max(0, now() - startedAt),
          });
          if (response.body) await response.body.cancel().catch(() => undefined);
          activeRequest = await withReasoningEffort(originalRequest, fallback);
          continue;
        }
        if (!retryableStatus(response.status)) {
          if (response.ok && requestedReasoningEffort !== undefined && !options.reasoningSettings) supportedReasoningEffort = reasoningEffort;
          options.logger?.record({
            type: "request.completed",
            conversationId: options.conversationId,
            content: { url, method, status: response.status, retries, reasoningEffort: reasoningEffort ?? "provider-default" },
            latencyMs: Math.max(0, now() - startedAt),
          });
          return response;
        }

        retries += 1;
        const delayMs = retryDelay(retries, random);
        options.logger?.record({
          type: "request.retry",
          conversationId: options.conversationId,
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
            conversationId: options.conversationId,
            content: { url, method },
            abort: { reason: error instanceof Error ? error.message : String(error) },
            latencyMs: Math.max(0, now() - startedAt),
          });
          throw error;
        }

        if (!isNetworkError(error)) {
          options.logger?.record({
            type: "request.failed",
            conversationId: options.conversationId,
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
          conversationId: options.conversationId,
          content: { url, method, error },
          retry: { attempt: retries, delayMs },
          latencyMs: Math.max(0, now() - startedAt),
        });
        await waitForRetry(delayMs, signal, options.sleep);
      }
    }
  };
}

export function createModel(config: ModelConfig, logger?: EventLogger, conversationId?: string): LanguageModel {
  if (config.transport !== "gateway" && !config.baseURL.trim()) throw new Error("Model base URL is required");
  if (!config.apiKey.trim()) throw new Error("Model API key is required");
  if (!config.model.trim()) throw new Error("Model id is required");

  const retryingFetch = createRetryingFetch({ logger, conversationId, reasoningSettings: reasoningSettingsFor(config) });
  if (config.transport === "gateway") {
    return createGateway({ apiKey: config.apiKey, fetch: retryingFetch }).languageModel(config.model);
  }

  const provider = createOpenAICompatible({
    name: "side-agent-provider",
    baseURL: config.baseURL.replace(/\/+$/, ""),
    apiKey: config.apiKey,
    fetch: retryingFetch,
  });

  return provider.languageModel(config.model);
}
