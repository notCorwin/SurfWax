import { APICallError, type LanguageModel } from "ai";
import type { EventLogger } from "../logging";
import type { ModelConfig, ModelSdk } from "../types";
import { REASONING_EFFORTS, reasoningSettingsFor, type ReasoningEffort, type ReasoningSettings } from "./reasoning";
import { GITLAB_MODELS } from "./gitlab-models";
import { googleCredentials, isOpenAIShapedSdk, modelConfigErrors, resolvedBaseURL, sdkFor, settingsFor } from "./model-sdks";

const MAX_RETRY_DELAY_MS = 5_000;
const INITIAL_RETRY_DELAY_MS = 250;

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || error instanceof Error && error.name === "AbortError");
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof Error && error.name === "NetworkError";
}

export function isRecoverableHttpStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

/** Providers report context overflow as a permanent request error; retry requires a new checkpoint. */
export function isContextOverflowError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current !== "object") return false;
    const value = current as { statusCode?: unknown; status?: unknown; message?: unknown; responseBody?: unknown; cause?: unknown; code?: unknown };
    const status = typeof value.statusCode === "number" ? value.statusCode : value.status;
    const text = [value.message, value.responseBody, value.code].filter((item) => typeof item === "string").join(" ");
    if ((status === undefined || [400, 413, 422].includes(Number(status)))
      && /context[_ -]length[_ -]exceeded|maximum\s+context\s+length|context\s+(?:window|length)[^.\n]{0,100}(?:exceed|too\s+(?:long|large)|limit)|(?:too\s+many|maximum\s+(?:number\s+of\s+)?)\s+(?:input\s+|prompt\s+)?tokens|prompt[^.\n]{0,80}(?:too\s+long|exceeds?)/i.test(text)) return true;
    if (typeof status === "number" && ![400, 413, 422].includes(status)) return false;
    current = value.cause;
  }
  return false;
}

/** Shared by fetch and interrupted stream recovery. Permanent provider errors always win. */
export function isRecoverableModelError(error: unknown, signal?: AbortSignal): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (isAbortError(current, signal)) return false;
    if (typeof current !== "object") return false;
    const value = current as { statusCode?: unknown; status?: unknown; isRetryable?: unknown; cause?: unknown; code?: unknown; name?: unknown };
    const status = typeof value.statusCode === "number" ? value.statusCode : value.status;
    if (typeof status === "number") {
      if (status >= 400) return isRecoverableHttpStatus(status);
      // AI SDK wraps failures while reading an otherwise successful response in
      // APICallError(status=200). Only its underlying network cause is retryable;
      // malformed successful payloads remain terminal.
      current = value.cause;
      continue;
    }
    if (isNetworkError(current) || value.name === "TimeoutError"
      || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(String(value.code))
      || value.isRetryable === true) return true;
    current = value.cause;
  }
  return false;
}

export function retryBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 6));
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(exponential * (0.5 + random())));
}

/** Retry read-only model work, including response-body failures after HTTP success. */
export async function retryModelOperation<T>(operation: () => Promise<T>, options: {
  signal: AbortSignal; logger?: EventLogger; conversationId?: string; purpose: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  let attempt = 0;
  while (true) {
    options.signal.throwIfAborted();
    try { return await operation(); } catch (error) {
      if (!isRecoverableModelError(error, options.signal)) throw error;
      const delayMs = retryBackoffDelay(++attempt);
      await options.logger?.append({ type: "model.request.retrying", conversationId: options.conversationId,
        content: { purpose: options.purpose }, error, retry: { attempt, delayMs } });
      await waitForModelRetry(delayMs, options.signal, options.sleep);
    }
  }
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

export function waitForModelRetry(delayMs: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const sleeping = sleep ? sleep(delayMs) : new Promise<void>((done) => { timer = setTimeout(done, delayMs); });
    void sleeping.then(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
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
  signal?: AbortSignal;
} = {}): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let supportedReasoningEffort: ReasoningEffort | null | undefined;

  return async (input, init) => {
    await options.reasoningSettings?.ready;
    const original = new Request(input instanceof Request ? input.clone() : input, init);
    const originalRequest = new Request(original, { signal: options.signal ? AbortSignal.any([options.signal, original.signal]) : original.signal });
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
        signal.throwIfAborted();
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
        if (!isRecoverableHttpStatus(response.status)) {
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
        const delayMs = retryAfter(response, now) ?? retryBackoffDelay(retries, random);
        const details = await responseDetails(response);
        options.logger?.record({
          type: "request.retry",
          conversationId: options.conversationId,
          content: { url, method, status: response.status, ...details },
          retry: { attempt: retries, status: response.status, delayMs },
          latencyMs: Math.max(0, now() - startedAt),
        });
        if (response.body) await response.body.cancel().catch(() => undefined);
        await waitForModelRetry(delayMs, signal, options.sleep);
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

        if (!isRecoverableModelError(error, signal)) {
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
        const delayMs = retryBackoffDelay(retries, random);
        options.logger?.record({
          type: "request.retry",
          conversationId: options.conversationId,
          content: { url, method, error, reason: "network", diagnosis: "Check endpoint connectivity, CORS, and provider configuration while retrying." },
          retry: { attempt: retries, delayMs },
          latencyMs: Math.max(0, now() - startedAt),
        });
        await waitForModelRetry(delayMs, signal, options.sleep);
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
    case "@ai-sdk/amazon-bedrock/mantle": return import("@ai-sdk/amazon-bedrock/mantle");
    case "@ai-sdk/anthropic": return import("@ai-sdk/anthropic");
    case "@ai-sdk/azure": return import("@ai-sdk/azure");
    case "@ai-sdk/cerebras": return import("@ai-sdk/cerebras");
    case "@ai-sdk/cohere": return import("@ai-sdk/cohere");
    case "@ai-sdk/deepinfra": return import("@ai-sdk/deepinfra");
    case "@ai-sdk/deepseek": return import("@ai-sdk/deepseek");
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

/** Adapt Orchestration v2 SSE as it arrives, including split UTF-8 and tool argument deltas. */
export function sapIncrementalSse(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("SAP streaming request did not return a Server-sent Events response.");
  }
  let buffer = "";
  let finished = false;
  let done = false;
  const encoder = new TextEncoder();
  const transform = new TransformStream<string, Uint8Array>({
    transform(text, controller) {
      buffer += text;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { done = true; controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
        const value = JSON.parse(data);
        if (value.error || frame.startsWith("event: error")) {
          const error = value.error ?? value;
          throw new APICallError({ message: error.message ?? "SAP orchestration stream failed", url: response.url,
            requestBodyValues: {}, statusCode: Number(error.code ?? error.status) || 500, responseBody: data });
        }
        const result = value.final_result ?? (value.choices ? value : undefined);
        if (!result) continue;
        finished ||= result.choices?.some((choice: any) => choice.finish_reason != null) ?? false;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(result)}\n\n`));
      }
    },
    flush(controller) {
      if (!done && !finished) throw new TypeError("SAP stream disconnected before the model finished");
      if (!done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
  return new Response(response.body.pipeThrough(new TextDecoderStream()).pipeThrough(transform), {
    status: response.status, headers: { ...Object.fromEntries(response.headers), "Content-Type": "text/event-stream" },
  });
}

function oauthFetch(options: { tokenUrl: string; clientId: string; clientSecret: string; fetch: typeof globalThis.fetch }) {
  let cached: { token: string; expiresAt: number } | undefined;
  return async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const data = await retryModelOperation(async () => {
      const response = await options.fetch(options.tokenUrl, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials" }), signal,
      });
      if (!response.ok) throw new APICallError({ message: "Model authentication failed", url: response.url, requestBodyValues: {}, statusCode: response.status });
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new Error("OAuth token response did not include access_token");
      return { ...data, access_token: data.access_token };
    }, { signal: signal ?? new AbortController().signal, purpose: "oauth-auth" });
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return cached.token;
  };
}

/** Native Vertex edge auth uses global fetch without AbortSignal. Authenticate
 * at our fetch boundary instead, so token exchange shares request cancellation. */
export function googleServiceAccountFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): typeof globalThis.fetch {
  const credentials = googleCredentials(config)!;
  let cached: { token: string; expiresAt: number } | undefined;
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    if (!cached || cached.expiresAt <= Date.now() + 60_000) {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${json({ alg: "RS256", typ: "JWT", ...(credentials.privateKeyId ? { kid: credentials.privateKeyId } : {}) })}.${json({
        iss: credentials.clientEmail, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
      })}`;
      const pem = credentials.privateKey.replace(/-----[^-]+-----|\s/g, "");
      const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (character) => character.charCodeAt(0)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
      signal.throwIfAborted();
      const token = await retryModelOperation(async () => {
        const response = await authFetch("https://oauth2.googleapis.com/token", { method: "POST", signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${encode(new Uint8Array(signature))}` }) });
        if (!response.ok) throw new APICallError({ message: "Google token exchange failed", url: response.url, requestBodyValues: {}, statusCode: response.status });
        const token = await response.json();
        if (typeof token.access_token !== "string") throw new Error("Google token response did not include access_token");
        return token;
      }, { signal, purpose: "google-auth" });
      cached = { token: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
    }
    const headers = new Headers(request.headers);
    headers.delete("x-goog-api-key"); headers.set("Authorization", `Bearer ${cached.token}`);
    return fetch(new Request(request, { headers }));
  };
}

export function watsonxProtocolFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): typeof globalThis.fetch {
  const settings = settingsFor(config);
  let cached: { token: string; expiresAt: number } | undefined;
  const token = async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token;
    const data = await retryModelOperation(async () => {
      const response = await authFetch("https://iam.cloud.ibm.com/identity/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ibm:params:oauth:grant-type:apikey", apikey: settings.apiKey }), signal,
      });
      if (!response.ok) throw new APICallError({ message: "Model authentication failed", url: response.url, requestBodyValues: {}, statusCode: response.status });
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new Error("IBM IAM response did not include access_token");
      return { ...data, access_token: data.access_token };
    }, { signal: signal ?? new AbortController().signal, purpose: "watsonx-auth" });
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
    const body = { config: { ...(source.stream === true ? { stream: { enabled: true } } : {}), modules: { prompt_templating: {
      model: { name: source.model, params: { ...params, ...(source.stream === true ? { stream_options: { include_usage: true } } : {}) } },
      prompt: { template: source.messages ?? [], ...(source.tools ? { tools: source.tools } : {}), ...(source.response_format ? { response_format: source.response_format } : {}) },
    } } } };
    const response = await fetch(withJsonRequest(request, `${resolvedBaseURL(config)}/v2/completion`, body, {
      Authorization: `Bearer ${await getToken(request.signal)}`, "AI-Resource-Group": settings.resourceGroup || "default",
    }));
    if (!response.ok) return response;
    if (source.stream === true) return sapIncrementalSse(response);
    const data = await response.json() as Record<string, any>;
    return new Response(JSON.stringify(data.final_result ?? data), {
      status: response.status, headers: { "Content-Type": "application/json" },
    });
  };
}

export function gitlabProtocolFetch(config: ModelConfig, fetch: typeof globalThis.fetch, authFetch = fetch): { fetch: typeof globalThis.fetch; mapping: { provider: "openai" | "anthropic"; model: string } } {
  const settings = settingsFor(config);
  const mapping = Object.hasOwn(GITLAB_MODELS, config.model) ? GITLAB_MODELS[config.model] : undefined;
  if (!mapping) throw new Error(`Unsupported GitLab Duo model: ${config.model}`);
  let cached: { token: string; headers: Record<string, string>; expiresAt: number } | undefined;
  const directAccess = async (signal?: AbortSignal) => {
    if (cached && cached.expiresAt > Date.now()) return cached;
    const instance = (settings.instanceUrl || "https://gitlab.com").replace(/\/+$/, "");
    const data = await retryModelOperation(async () => {
      const response = await authFetch(`${instance}/api/v4/ai/third_party_agents/direct_access`, {
        method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }), signal,
      });
      if (!response.ok) throw new APICallError({ message: "Model authentication failed", url: response.url, requestBodyValues: {}, statusCode: response.status });
      const data = await response.json() as { token?: string; headers?: Record<string, string> };
      if (!data.token) throw new Error("GitLab direct access response did not include token");
      return { ...data, token: data.token };
    }, { signal: signal ?? new AbortController().signal, purpose: "gitlab-auth" });
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

function nativeModel(provider: Record<string, any>, config: ModelConfig): Exclude<LanguageModel, string> {
  const shape = config.modelProvider?.shape;
  const method = shape === "responses" ? provider.responses
    : shape === "completions" ? provider.chat ?? provider.chatModel : provider.languageModel;
  if (typeof method !== "function") throw new Error(`SDK ${sdkFor(config)} does not support model API shape: ${shape}`);
  return method.call(provider, config.model);
}

function modelDefaultHeaders(config: ModelConfig): Record<string, string> | undefined {
  if (!config.modelProvider?.headers) return undefined;
  // Catalog metadata must not replace the user's provider authentication.
  return Object.fromEntries(Object.entries(config.modelProvider.headers).filter(([key]) =>
    !["authorization", "x-api-key", "api-key", "x-goog-api-key", "x-amz-security-token", "host", "content-length"].includes(key.toLowerCase()),
  ));
}

function modelDefaultsFetch(config: ModelConfig, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const defaults = config.modelProvider?.body && Object.fromEntries(Object.entries(config.modelProvider.body).filter(([key]) =>
    !["model", "messages", "input", "contents", "prompt", "system", "systemInstruction", "stream", "tools", "tool_choice"].includes(key),
  ));
  if (!defaults || !Object.keys(defaults).length) return fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) {
      throw new Error("Catalog body defaults cannot be applied after AWS SigV4 signing; use a bearer token or remove the body override.");
    }
    if (request.method !== "POST" || !request.body) return fetch(request);
    const body = await request.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Model request body must be a JSON object");
    // SDK-generated model, prompt, tools, stream, and explicit options win.
    return fetch(new Request(request, { body: JSON.stringify({ ...defaults, ...body }) }));
  };
}

function azureInferenceFetch(config: ModelConfig, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const settings = settingsFor(config);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!/\/models\//.test(url.pathname)) return fetch(request);
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", settings.apiVersion || "2024-05-01-preview");
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("api-key", settings.apiKey);
    return fetch(new Request(url, { method: request.method, headers, signal: request.signal,
      ...(request.body ? { body: await request.clone().text() } : {}) }));
  };
}

export async function createModel(config: ModelConfig, logger?: EventLogger, conversationId?: string, options: CreateModelOptions = {}): Promise<LanguageModel> {
  const errors = modelConfigErrors(config);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  const sdk = sdkFor(config);
  const settings = settingsFor(config);
  const baseURL = resolvedBaseURL(config);
  const runFetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    return (options.fetch ?? globalThis.fetch)(new Request(request, { signal: options.signal
      ? AbortSignal.any([options.signal, request.signal]) : request.signal }));
  };
  const baseRetryingFetch = createRetryingFetch({ logger, conversationId, fetch: runFetch, signal: options.signal });
  const retryingFetch = createRetryingFetch({
    logger, conversationId, fetch: runFetch, signal: options.signal,
    reasoningSettings: isOpenAIShapedSdk(sdk) ? reasoningSettingsFor(config) : undefined,
  });
  const module = await loadSdk(sdk, options.loaders?.[sdk]);
  options.signal?.throwIfAborted();
  const vertexCompatibleAuth = config.providerId === "google-vertex" && sdk === "@ai-sdk/openai-compatible" && !settings.apiKey && googleCredentials(config);
  const azureCompatibleAuth = (config.providerId === "azure" || config.providerId === "azure-cognitive-services") && sdk === "@ai-sdk/openai-compatible";
  const transportFetch = vertexCompatibleAuth ? googleServiceAccountFetch(config, retryingFetch, baseRetryingFetch)
    : azureCompatibleAuth ? azureInferenceFetch(config, retryingFetch) : isOpenAIShapedSdk(sdk) ? retryingFetch : baseRetryingFetch;
  const modelFetch = modelDefaultsFetch(config, transportFetch);
  const common = { headers: modelDefaultHeaders(config), apiKey: vertexCompatibleAuth ? "service-account" : settings.apiKey, ...(baseURL ? { baseURL } : {}), fetch: modelFetch };
  let model: LanguageModel;

  switch (sdk) {
    case "@ai-sdk/amazon-bedrock": model = nativeModel(module.createAmazonBedrock({ ...common, region: settings.region, accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, sessionToken: settings.sessionToken }), config); break;
    case "@ai-sdk/amazon-bedrock/mantle": model = nativeModel(module.createBedrockMantle({ ...common, region: settings.region, accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, sessionToken: settings.sessionToken }), config); break;
    case "@ai-sdk/anthropic": model = nativeModel(module.createAnthropic(common), config); break;
    case "@ai-sdk/azure": model = nativeModel(module.createAzure({ ...common, resourceName: settings.resourceName }), config); break;
    case "@ai-sdk/cerebras": model = nativeModel(module.createCerebras(common), config); break;
    case "@ai-sdk/cohere": model = nativeModel(module.createCohere(common), config); break;
    case "@ai-sdk/deepinfra": model = nativeModel(module.createDeepInfra(common), config); break;
    case "@ai-sdk/deepseek": model = nativeModel(module.createDeepSeek(common), config); break;
    case "@ai-sdk/gateway": model = nativeModel(module.createGateway(common), config); break;
    case "@ai-sdk/google": model = nativeModel(module.createGoogle(common), config); break;
    case "@ai-sdk/google-vertex": {
      const serviceAccount = !settings.apiKey && googleCredentials(config);
      model = nativeModel(module.createGoogleVertex({ ...common, project: settings.project, location: settings.location,
        ...(serviceAccount ? { apiKey: "service-account", baseURL: baseURL || `https://${settings.location === "global" ? "" : `${settings.location}-`}aiplatform.googleapis.com/v1beta1/projects/${settings.project}/locations/${settings.location}/publishers/google`,
          fetch: modelDefaultsFetch(config, googleServiceAccountFetch(config, baseRetryingFetch)) } : {}) }), config);
      break;
    }
    case "@ai-sdk/google-vertex/anthropic": model = nativeModel(module.createGoogleVertexAnthropic({ ...common, project: settings.project, location: settings.location,
      generateAuthToken: async () => "service-account", fetch: modelDefaultsFetch(config, googleServiceAccountFetch(config, baseRetryingFetch)) }), config); break;
    case "@ai-sdk/groq": model = nativeModel(module.createGroq(common), config); break;
    case "@ai-sdk/mistral": model = nativeModel(module.createMistral(common), config); break;
    case "@ai-sdk/openai": model = nativeModel(module.createOpenAI(common), config); break;
    case "@ai-sdk/perplexity": {
      const native = nativeModel(module.createPerplexity(common), config);
      // The native Sonar SDK rejects function tools. Use the endpoint's Chat
      // protocol for tool-capable deployments while retaining native search
      // metadata/citations for requests without function tools.
      const compatible = await import("@ai-sdk/openai-compatible");
      const chat = compatible.createOpenAICompatible({ ...common, name: "perplexity",
        baseURL: baseURL || "https://api.perplexity.ai", fetch: modelDefaultsFetch(config, retryingFetch) }).languageModel(config.model);
      model = Object.assign(Object.create(native), {
        doStream: (args: any) => (args.tools?.length ? chat : native).doStream(args),
        doGenerate: (args: any) => (args.tools?.length ? chat : native).doGenerate(args),
      });
      break;
    }
    case "@ai-sdk/togetherai": model = nativeModel(module.createTogetherAI(common), config); break;
    case "@ai-sdk/vercel": model = nativeModel(module.createVercel(common), config); break;
    case "@ai-sdk/xai": model = nativeModel(module.createXai(common), config); break;
    case "@aihubmix/ai-sdk-provider": model = nativeModel(module.createAihubmix(common), config); break;
    case "@openrouter/ai-sdk-provider": model = nativeModel(module.createOpenRouter(common), config); break;
    case "@saladtechnologies-oss/ai-sdk-provider": model = nativeModel(module.createSaladCloud(common), config); break;
    case "merge-gateway-ai-sdk-provider": model = nativeModel(module.createMergeGateway(common), config); break;
    case "watsonx-ai-provider": model = nativeModel(module.createOpenAICompatible({ name: "watsonx", headers: modelDefaultHeaders(config), baseURL: "https://watsonx.invalid/v1", apiKey: settings.apiKey, fetch: modelDefaultsFetch(config, watsonxProtocolFetch(config, retryingFetch, baseRetryingFetch)) }), config); break;
    case "@jerome-benoit/sap-ai-provider-v2": model = nativeModel(module.createOpenAICompatible({ name: "sap-ai-core", headers: modelDefaultHeaders(config), baseURL: "https://sap.invalid/v1", apiKey: "sap-oauth", fetch: modelDefaultsFetch(config, sapProtocolFetch(config, baseRetryingFetch)) }), config); break;
    case "gitlab-ai-provider": {
      const initial = gitlabProtocolFetch(config, baseRetryingFetch);
      const adapter = initial.mapping.provider === "openai" ? gitlabProtocolFetch(config, retryingFetch, baseRetryingFetch) : initial;
      const gateway = (settings.aiGatewayUrl || "https://cloud.gitlab.com").replace(/\/+$/, "");
      if (adapter.mapping.provider === "openai") {
        const openai = await loadSdk("@ai-sdk/openai", options.loaders?.["@ai-sdk/openai"]);
        model = nativeModel(openai.createOpenAI({ baseURL: config.modelProvider?.api !== undefined ? baseURL : `${gateway}/ai/v1/proxy/openai/v1`, apiKey: "gitlab-direct-access", headers: modelDefaultHeaders(config), fetch: modelDefaultsFetch(config, adapter.fetch) }), { ...config, model: adapter.mapping.model });
      } else {
        const anthropic = await loadSdk("@ai-sdk/anthropic", options.loaders?.["@ai-sdk/anthropic"]);
        model = nativeModel(anthropic.createAnthropic({ baseURL: config.modelProvider?.api !== undefined ? baseURL : `${gateway}/ai/v1/proxy/anthropic/v1`, authToken: "gitlab-direct-access", headers: modelDefaultHeaders(config), fetch: modelDefaultsFetch(config, adapter.fetch) }), { ...config, model: adapter.mapping.model });
      }
      break;
    }
    case "ai-gateway-provider": model = nativeModel(module.createOpenAICompatible({ name: "cloudflare-ai-gateway", baseURL, apiKey: settings.apiKey, headers: { ...modelDefaultHeaders(config), "cf-aig-gateway-id": settings.gatewayId }, fetch: modelDefaultsFetch(config, retryingFetch) }), config); break;
    case "@qvac/ai-sdk-provider":
    case "venice-ai-sdk-provider":
    case "@ai-sdk/openai-compatible": {
      if (config.modelProvider?.shape === "responses") {
        // The compatible SDK only implements Chat Completions. Keep Responses
        // on the native OpenAI interface rather than reimplementing its protocol.
        const openai = await loadSdk("@ai-sdk/openai", options.loaders?.["@ai-sdk/openai"]);
        model = nativeModel(openai.createOpenAI(common), config);
      } else {
        model = nativeModel(module.createOpenAICompatible({ ...common, name: config.providerId || "custom", baseURL }), config);
      }
      break;
    }
  }
  options.signal?.throwIfAborted();
  return model;
}
