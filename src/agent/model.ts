import type { LanguageModel } from "ai";
import type { EventLogger } from "../logging";
import type { ModelConfig, ModelSdk } from "../types";
import { REASONING_EFFORTS, reasoningSettingsFor, type ReasoningEffort, type ReasoningSettings } from "./reasoning";
import { googleCredentials, isOpenAIShapedSdk, modelConfigErrors, resolvedBaseURL, sdkFor, settingsFor } from "./model-sdks";

const MAX_RETRY_DELAY_MS = 10_000;
const INITIAL_RETRY_DELAY_MS = 250;

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || error instanceof Error && error.name === "AbortError");
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof Error && error.name === "NetworkError";
}

function retryableStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryDelay(attempt: number, random: () => number): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 6));
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(exponential * (0.5 + random())));
}

function retryAfter(response: Response, now: () => number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(MAX_RETRY_DELAY_MS, Math.round(delay))) : undefined;
}

async function responseDetails(response: Response): Promise<Record<string, unknown>> {
  const headers = Object.fromEntries(response.headers.entries());
  return {
    responseBody: await response.clone().text().catch(() => ""), headers,
    requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("cf-ray") ?? undefined,
  };
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
    const typeErrors = new Map<string, number>();

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
          const details = response.ok ? {} : await responseDetails(response);
          options.logger?.record({
            type: "request.completed",
            conversationId: options.conversationId,
            content: { url, method, status: response.status, retries, reasoningEffort: reasoningEffort ?? "provider-default", ...details },
            latencyMs: Math.max(0, now() - startedAt),
          });
          return response;
        }

        retries += 1;
        const delayMs = retryAfter(response, now) ?? retryDelay(retries, random);
        const details = await responseDetails(response);
        options.logger?.record({
          type: "request.retry",
          conversationId: options.conversationId,
          content: { url, method, status: response.status, ...details },
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

        const key = `${error instanceof Error ? error.name : typeof error}:${error instanceof Error ? error.message : String(error)}`;
        const repeated = (typeErrors.get(key) ?? 0) + 1;
        typeErrors.set(key, repeated);
        const confirmedTransient = error instanceof Error && error.name === "NetworkError"
          || typeof navigator !== "undefined" && navigator.onLine === false;
        if (!confirmedTransient && error instanceof TypeError && repeated >= 3) {
          const diagnostic = new Error(`Provider network request failed repeatedly; check the endpoint URL, CORS policy, Chrome host permissions, and provider configuration. Last error: ${error.message}`, { cause: error });
          options.logger?.record({ type: "request.failed", conversationId: options.conversationId,
            content: { url, method, attempts: repeated, diagnosis: "provider-network-or-cors", error: diagnostic }, error: diagnostic,
            latencyMs: Math.max(0, now() - startedAt) });
          throw diagnostic;
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

type ModuleLoader = () => Promise<Record<string, any>>;
export type CreateModelOptions = { fetch?: typeof globalThis.fetch; loaders?: Partial<Record<ModelSdk, ModuleLoader>>; signal?: AbortSignal };

async function loadSdk(sdk: ModelSdk, override?: ModuleLoader): Promise<Record<string, any>> {
  if (override) return override();
  switch (sdk) {
    case "@ai-sdk/amazon-bedrock": return import("@ai-sdk/amazon-bedrock");
    case "@ai-sdk/anthropic": return import("@ai-sdk/anthropic");
    case "@ai-sdk/azure": return import("@ai-sdk/azure");
    case "@ai-sdk/cerebras": return import("@ai-sdk/cerebras");
    case "@ai-sdk/cohere": return import("@ai-sdk/cohere");
    case "@ai-sdk/deepinfra": return import("@ai-sdk/deepinfra");
    case "@ai-sdk/gateway": return import("@ai-sdk/gateway");
    case "@ai-sdk/google": return import("@ai-sdk/google");
    case "@ai-sdk/google-vertex": return import("@ai-sdk/google-vertex/edge");
    case "@ai-sdk/google-vertex/anthropic": return import("@ai-sdk/google-vertex/anthropic/edge");
    case "@ai-sdk/groq": return import("@ai-sdk/groq");
    case "@ai-sdk/mistral": return import("@ai-sdk/mistral");
    case "@ai-sdk/openai": return import("@ai-sdk/openai");
    case "@ai-sdk/openai-compatible": return import("@ai-sdk/openai-compatible");
    case "@ai-sdk/perplexity": return import("@ai-sdk/perplexity");
    case "@ai-sdk/togetherai": return import("@ai-sdk/togetherai");
    case "@ai-sdk/vercel": return import("@ai-sdk/vercel");
    case "@ai-sdk/xai": return import("@ai-sdk/xai");
    case "@aihubmix/ai-sdk-provider": return import("@aihubmix/ai-sdk-provider");
    case "@openrouter/ai-sdk-provider": return import("@openrouter/ai-sdk-provider");
    case "@saladtechnologies-oss/ai-sdk-provider": return import("@saladtechnologies-oss/ai-sdk-provider");
    case "merge-gateway-ai-sdk-provider": return import("merge-gateway-ai-sdk-provider");
    case "@qvac/ai-sdk-provider":
    case "venice-ai-sdk-provider":
    case "ai-gateway-provider":
    case "gitlab-ai-provider":
    case "watsonx-ai-provider":
    case "@jerome-benoit/sap-ai-provider-v2": return import("@ai-sdk/openai-compatible");
  }
}

function withJsonRequest(request: Request, url: string, body: unknown, headers: HeadersInit = {}): Request {
  const merged = new Headers(request.headers);
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Request(url, { method: "POST", headers: merged, body: JSON.stringify(body), signal: request.signal });
}

function oneChunkSse(value: Record<string, any>): Response {
  const result = value.final_result ?? value;
  const chunks = (result.choices ?? []).flatMap((choice: Record<string, any>) => [
    { ...result, usage: undefined, choices: [{ index: choice.index ?? 0, delta: choice.message ?? {}, finish_reason: null }] },
    { ...result, usage: result.usage, choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] },
  ]);
  const text = `${chunks.map((chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function oauthFetch(options: { tokenUrl: string; clientId: string; clientSecret: string; fetch: typeof globalThis.fetch }) {
  let cached: { token: string; expiresAt: number } | undefined;
  return async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const response = await options.fetch(options.tokenUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }), signal,
    });
    if (!response.ok) throw new Error(`OAuth token request failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("OAuth token response did not include access_token");
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return cached.token;
  };
}

export function watsonxProtocolFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): typeof globalThis.fetch {
  const settings = settingsFor(config);
  let cached: { token: string; expiresAt: number } | undefined;
  const token = async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token;
    const response = await authFetch("https://iam.cloud.ibm.com/identity/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ibm:params:oauth:grant-type:apikey", apikey: settings.apiKey }), signal,
    });
    if (!response.ok) throw new Error(`IBM IAM request failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("IBM IAM response did not include access_token");
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return cached.token;
  };
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
    const stream = body.stream === true;
    delete body.stream;
    delete body.stream_options;
    body.model_id = body.model;
    body.project_id = settings.projectId;
    delete body.model;
    const url = `${resolvedBaseURL(config)}/ml/v1/text/${stream ? "chat_stream" : "chat"}?version=2026-04-20`;
    return fetch(withJsonRequest(request, url, body, { Authorization: `Bearer ${await token(request.signal)}` }));
  };
}

export function sapProtocolFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): typeof globalThis.fetch {
  const settings = settingsFor(config);
  const serviceKey = JSON.parse(settings.serviceKeyJson) as Record<string, any>;
  const getToken = oauthFetch({
    tokenUrl: `${String(serviceKey.url ?? serviceKey.uaa?.url).replace(/\/+$/, "")}/oauth/token`,
    clientId: String(serviceKey.clientid ?? serviceKey.uaa?.clientid ?? ""),
    clientSecret: String(serviceKey.clientsecret ?? serviceKey.uaa?.clientsecret ?? ""), fetch: authFetch,
  });
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const source = JSON.parse(await request.clone().text()) as Record<string, any>;
    const params = Object.fromEntries(Object.entries(source).filter(([key]) => ["temperature", "top_p", "max_tokens", "stop", "tool_choice"].includes(key)));
    const body = { config: { modules: { prompt_templating: {
      model: { name: source.model, params },
      prompt: { template: source.messages ?? [], ...(source.tools ? { tools: source.tools } : {}), ...(source.response_format ? { response_format: source.response_format } : {}) },
    } } } };
    const response = await fetch(withJsonRequest(request, `${settings.deploymentUrl.replace(/\/+$/, "")}/v2/completion`, body, {
      Authorization: `Bearer ${await getToken(request.signal)}`, "AI-Resource-Group": settings.resourceGroup || "default",
    }));
    if (!response.ok) return response;
    const data = await response.json() as Record<string, any>;
    return source.stream === true ? oneChunkSse(data) : new Response(JSON.stringify(data.final_result ?? data), {
      status: response.status, headers: { "Content-Type": "application/json" },
    });
  };
}

const GITLAB_MODELS: Record<string, { provider: "openai" | "anthropic"; model: string }> = {
  "duo-chat-fable-5-1": { provider: "anthropic", model: "claude-fable-5-1" },
  "duo-chat-fable-5": { provider: "anthropic", model: "claude-fable-5" },
  "duo-chat-opus-5": { provider: "anthropic", model: "claude-opus-5" },
  "duo-chat-opus-4-8": { provider: "anthropic", model: "claude-opus-4-8" },
  "duo-chat-opus-4-7": { provider: "anthropic", model: "claude-opus-4-7" },
  "duo-chat-opus-4-6": { provider: "anthropic", model: "claude-opus-4-6" },
  "duo-chat-sonnet-5": { provider: "anthropic", model: "claude-sonnet-5" },
  "duo-chat-sonnet-4-6": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "duo-chat-opus-4-5": { provider: "anthropic", model: "claude-opus-4-5-20251101" },
  "duo-chat-sonnet-4-5": { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  "duo-chat-haiku-4-5": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  "duo-chat-gpt-6-astra": { provider: "openai", model: "gpt-6-astra" },
  "duo-chat-gpt-5-1": { provider: "openai", model: "gpt-5.1-2025-11-13" },
  "duo-chat-gpt-5-2": { provider: "openai", model: "gpt-5.2-2025-12-11" },
  "duo-chat-gpt-5-4": { provider: "openai", model: "gpt-5.4-2026-03-05" },
  "duo-chat-gpt-5-5": { provider: "openai", model: "gpt-5.5-2026-04-23" },
  "duo-chat-gpt-5-mini": { provider: "openai", model: "gpt-5-mini-2025-08-07" },
  "duo-chat-gpt-5-4-mini": { provider: "openai", model: "gpt-5.4-mini" },
  "duo-chat-gpt-5-4-nano": { provider: "openai", model: "gpt-5.4-nano" },
  "duo-chat-gpt-5-6-sol": { provider: "openai", model: "gpt-5.6-sol" },
  "duo-chat-gpt-5-6-terra": { provider: "openai", model: "gpt-5.6-terra" },
  "duo-chat-gpt-5-6-luna": { provider: "openai", model: "gpt-5.6-luna" },
  "duo-chat-gpt-5-codex": { provider: "openai", model: "gpt-5-codex" },
  "duo-chat-gpt-5-2-codex": { provider: "openai", model: "gpt-5.2-codex" },
  "duo-chat-gpt-5-3-codex": { provider: "openai", model: "gpt-5.3-codex" },
};

export function gitlabProtocolFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): { fetch: typeof globalThis.fetch; mapping: { provider: "openai" | "anthropic"; model: string } } {
  const settings = settingsFor(config);
  const mapping = GITLAB_MODELS[config.model];
  if (!mapping) throw new Error(`Unsupported GitLab Duo model: ${config.model}`);
  let cached: { token: string; headers: Record<string, string>; expiresAt: number } | undefined;
  const directAccess = async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now()) return cached;
    const instance = (settings.instanceUrl || "https://gitlab.com").replace(/\/+$/, "");
    const response = await authFetch(`${instance}/api/v4/ai/third_party_agents/direct_access`, {
      method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }), signal,
    });
    if (!response.ok) throw new Error(`GitLab direct access failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as { token?: string; headers?: Record<string, string> };
    if (!data.token) throw new Error("GitLab direct access response did not include token");
    cached = { token: data.token, headers: data.headers ?? {}, expiresAt: Date.now() + 25 * 60_000 };
    return cached;
  };
  return { mapping, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const access = await directAccess(request.signal);
    const headers = new Headers(request.headers);
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${access.token}`);
    Object.entries(access.headers).forEach(([key, value]) => { if (key.toLowerCase() !== "x-api-key") headers.set(key, value); });
    return fetch(new Request(request, { headers }));
  } };
}

export async function createModel(config: ModelConfig, logger?: EventLogger, conversationId?: string, options: CreateModelOptions = {}): Promise<LanguageModel> {
  const errors = modelConfigErrors(config);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  const sdk = sdkFor(config);
  const settings = settingsFor(config);
  const baseURL = resolvedBaseURL(config);
  const baseRetryingFetch = createRetryingFetch({ logger, conversationId, fetch: options.fetch });
  const retryingFetch = createRetryingFetch({
    logger, conversationId, fetch: options.fetch,
    reasoningSettings: isOpenAIShapedSdk(sdk) ? reasoningSettingsFor(config) : undefined,
  });
  const module = await loadSdk(sdk, options.loaders?.[sdk]);
  options.signal?.throwIfAborted();
  const common = { apiKey: settings.apiKey, ...(baseURL ? { baseURL } : {}), fetch: isOpenAIShapedSdk(sdk) ? retryingFetch : baseRetryingFetch };
  let model: LanguageModel;

  switch (sdk) {
    case "@ai-sdk/amazon-bedrock": model = module.createAmazonBedrock({ ...common, region: settings.region, accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, sessionToken: settings.sessionToken }).languageModel(config.model); break;
    case "@ai-sdk/anthropic": model = module.createAnthropic(common).languageModel(config.model); break;
    case "@ai-sdk/azure": model = module.createAzure({ ...common, resourceName: settings.resourceName }).languageModel(config.model); break;
    case "@ai-sdk/cerebras": model = module.createCerebras(common).languageModel(config.model); break;
    case "@ai-sdk/cohere": model = module.createCohere(common).languageModel(config.model); break;
    case "@ai-sdk/deepinfra": model = module.createDeepInfra(common).languageModel(config.model); break;
    case "@ai-sdk/gateway": model = module.createGateway(common).languageModel(config.model); break;
    case "@ai-sdk/google": model = module.createGoogle(common).languageModel(config.model); break;
    case "@ai-sdk/google-vertex": model = module.createGoogleVertex({ ...common, project: settings.project, location: settings.location, googleCredentials: googleCredentials(config) }).languageModel(config.model); break;
    case "@ai-sdk/google-vertex/anthropic": model = module.createGoogleVertexAnthropic({ ...common, project: settings.project, location: settings.location, googleCredentials: googleCredentials(config) }).languageModel(config.model); break;
    case "@ai-sdk/groq": model = module.createGroq(common).languageModel(config.model); break;
    case "@ai-sdk/mistral": model = module.createMistral(common).languageModel(config.model); break;
    case "@ai-sdk/openai": model = module.createOpenAI(common).languageModel(config.model); break;
    case "@ai-sdk/perplexity": model = module.createPerplexity(common).languageModel(config.model); break;
    case "@ai-sdk/togetherai": model = module.createTogetherAI(common).languageModel(config.model); break;
    case "@ai-sdk/vercel": model = module.createVercel(common).languageModel(config.model); break;
    case "@ai-sdk/xai": model = module.createXai(common).languageModel(config.model); break;
    case "@aihubmix/ai-sdk-provider": model = module.createAihubmix(common).languageModel(config.model); break;
    case "@openrouter/ai-sdk-provider": model = module.createOpenRouter(common).languageModel(config.model); break;
    case "@saladtechnologies-oss/ai-sdk-provider": model = module.createSaladCloud(common).languageModel(config.model); break;
    case "merge-gateway-ai-sdk-provider": model = module.createMergeGateway(common).languageModel(config.model); break;
    case "watsonx-ai-provider": model = module.createOpenAICompatible({ name: "watsonx", baseURL: "https://watsonx.invalid/v1", apiKey: settings.apiKey, fetch: watsonxProtocolFetch(config, retryingFetch, baseRetryingFetch) }).languageModel(config.model); break;
    case "@jerome-benoit/sap-ai-provider-v2": model = module.createOpenAICompatible({ name: "sap-ai-core", baseURL: "https://sap.invalid/v1", apiKey: "sap-oauth", fetch: sapProtocolFetch(config, baseRetryingFetch) }).languageModel(config.model); break;
    case "gitlab-ai-provider": {
      const initial = gitlabProtocolFetch(config, baseRetryingFetch);
      const adapter = initial.mapping.provider === "openai" ? gitlabProtocolFetch(config, retryingFetch, baseRetryingFetch) : initial;
      const gateway = (settings.aiGatewayUrl || "https://cloud.gitlab.com").replace(/\/+$/, "");
      if (adapter.mapping.provider === "openai") {
        const openai = await import("@ai-sdk/openai");
        model = openai.createOpenAI({ baseURL: `${gateway}/ai/v1/proxy/openai/v1`, apiKey: "gitlab-direct-access", fetch: adapter.fetch }).languageModel(adapter.mapping.model);
      } else {
        const anthropic = await import("@ai-sdk/anthropic");
        model = anthropic.createAnthropic({ baseURL: `${gateway}/ai/v1/proxy/anthropic`, authToken: "gitlab-direct-access", fetch: adapter.fetch }).languageModel(adapter.mapping.model);
      }
      break;
    }
    case "ai-gateway-provider": model = module.createOpenAICompatible({ name: "cloudflare-ai-gateway", baseURL, apiKey: settings.apiKey, headers: { "cf-aig-gateway-id": settings.gatewayId }, fetch: retryingFetch }).languageModel(config.model); break;
    case "@qvac/ai-sdk-provider":
    case "venice-ai-sdk-provider":
    case "@ai-sdk/openai-compatible": model = module.createOpenAICompatible({ name: config.providerId || "custom", baseURL, apiKey: settings.apiKey, fetch: retryingFetch }).languageModel(config.model); break;
  }
  options.signal?.throwIfAborted();
  return model;
}
