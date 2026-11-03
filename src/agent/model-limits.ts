import { isModelSdk, type JsonValue, type ModelConfig, type ModelProviderOverride, type ModelSdk } from "../types";
import { defaultBaseURL, isCloudflareGateway, providerSettingFields, resolvedBaseURL, sdkFor, type ProviderSettingField } from "./model-sdks";
import { linkModelDiagnostic, modelDiagnostic, type ModelDiagnostic, type ModelDiagnosticContext } from "./diagnostics";
import bundledCatalogGzip, { metadata as bundledCatalogMetadata } from "../data/models-dev-api";

export const CATALOG_CACHE_KEY = "side-agent:model-catalog";
// Older normalized catalogs discarded per-model routes and cannot be reused safely.
const CATALOG_CACHE_VERSION = 2;
export const MODEL_ROUTING_VERSION = 1;
const CATALOG_URL = "https://models.dev/api.json";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const VERCEL_GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai";

export type ModelLimit = {
  provider: string;
  model: string;
  context: number;
  input?: number;
  output?: number;
  source: "models.dev" | "manual" | "estimated";
  reasoningEfforts?: string[];
  inputModalities?: string[];
};

export type ModelCatalog = Record<string, {
  id?: string;
  name?: string;
  api?: string;
  npm?: string;
  env?: string[];
  doc?: string;
  models?: Record<string, {
    id?: string;
    name?: string;
    family?: string;
    canonical_model_id?: string;
    provider?: ModelProviderOverride;
    tool_call?: boolean;
    modalities?: { input?: string[]; output?: string[] };
    reasoning?: boolean;
    reasoning_options?: Array<{ type?: string; values?: string[] }>;
    limit?: { context?: number; input?: number; output?: number };
  }>;
}>;

type CachedCatalog = { version: number; fetchedAt: number; revision?: string; catalog: ModelCatalog };
type Storage = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

export type ModelProviderPreset = {
  id: string;
  name: string;
  baseURL: string;
  sdk: ModelSdk;
  env: string[];
  doc?: string;
  fields: ProviderSettingField[];
  /** Legacy display/tests; request dispatch uses sdk. */
  models: Array<{ id: string; name: string; family?: string; canonicalModelId?: string }>;
  /** Includes unselectable models so a typed/restored unsupported route fails explicitly. */
  modelProviders?: Record<string, ModelProviderOverride>;
  defaultProvider?: ModelProviderOverride;
};

function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hostname(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchModel(catalog: ModelCatalog, baseURL: string, modelId: string, selectedProviderId?: string): ModelLimit | undefined {
  const requested = modelId.toLowerCase();
  const normalized = normalize(modelId);
  const host = hostname(baseURL);
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [id, details] of Object.entries(provider.models ?? {})) {
      const providerHost = hostname(details.provider?.api ?? provider.api ?? "");
      const providerMatch = selectedProviderId === providerId || Boolean(host && providerHost && host === providerHost);
      if (!providerMatch) continue;
      const limit = details.limit;
      if (!validLimit(limit?.context)) continue;
      const alias = typeof details.id === "string" ? details.id : undefined;
      if (id.toLowerCase() !== requested && normalize(id) !== normalized && alias?.toLowerCase() !== requested && normalize(alias ?? "") !== normalized) continue;
      return {
        provider: providerId,
        model: id,
        context: limit.context,
        ...(validLimit(limit.input) ? { input: limit.input } : {}),
        ...(validLimit(limit.output) ? { output: limit.output } : {}),
        ...(id.toLowerCase() === requested || alias?.toLowerCase() === requested ? {
          inputModalities: details.modalities?.input,
          reasoningEfforts: details.reasoning_options?.find((option) => option.type === "effort")?.values
            ?? (details.reasoning === false || details.reasoning_options ? [] : undefined),
        } : {}),
        source: "models.dev",
      };
    }
  }
  return undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(isJsonValue));
}

/** Keep unknown SDK/shape names for validation; never erase an explicit unsupported route. */
export function normalizeModelProviderOverride(value: unknown): ModelProviderOverride | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model provider override");
  const provider = value as Record<string, unknown>;
  for (const key of ["npm", "api", "shape"] as const) {
    if (provider[key] !== undefined && typeof provider[key] !== "string") throw new Error(`Invalid model provider ${key}`);
  }
  if (provider.body !== undefined && (!provider.body || typeof provider.body !== "object" || Array.isArray(provider.body) || !isJsonValue(provider.body))) {
    throw new Error("Invalid model provider body");
  }
  if (provider.headers !== undefined && (!provider.headers || typeof provider.headers !== "object" || Array.isArray(provider.headers)
    || !Object.values(provider.headers).every((header) => typeof header === "string"))) throw new Error("Invalid model provider headers");
  return {
    ...(typeof provider.npm === "string" ? { npm: provider.npm } : {}),
    ...(typeof provider.api === "string" ? { api: provider.api } : {}),
    ...(typeof provider.shape === "string" ? { shape: provider.shape } : {}),
    ...(provider.body !== undefined ? { body: provider.body as Record<string, JsonValue> } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers as Record<string, string> } : {}),
  };
}

function normalizeCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Models.dev returned an invalid catalog");
  return Object.fromEntries(Object.entries(value).flatMap(([providerId, rawProvider]) => {
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) return [];
    const provider = rawProvider as Record<string, unknown>;
    const rawModels = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? provider.models as Record<string, unknown> : {};
    const models = Object.fromEntries(Object.entries(rawModels).flatMap(([modelId, rawModel]) => {
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) return [];
      const model = rawModel as Record<string, unknown>;
      const modelProvider = normalizeModelProviderOverride(model.provider);
      const limit = model.limit && typeof model.limit === "object" ? model.limit as Record<string, unknown> : undefined;
      const modalities = model.modalities && typeof model.modalities === "object" ? model.modalities as Record<string, unknown> : undefined;
      const reasoningOptions = Array.isArray(model.reasoning_options)
        ? model.reasoning_options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) return [];
          const record = option as Record<string, unknown>;
          return [{ type: String(record.type ?? ""), values: Array.isArray(record.values)
            ? record.values.filter((item): item is string => typeof item === "string") : [] }];
        })
        : undefined;
      return [[modelId, {
        ...(typeof model.id === "string" ? { id: model.id } : {}),
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(typeof model.family === "string" ? { family: model.family } : {}),
        ...(typeof model.canonical_model_id === "string" ? { canonical_model_id: model.canonical_model_id } : {}),
        ...(modelProvider ? { provider: modelProvider } : {}),
        ...(typeof model.tool_call === "boolean" ? { tool_call: model.tool_call } : {}),
        ...(modalities ? { modalities: {
          ...(Array.isArray(modalities.input) ? { input: modalities.input.filter((item): item is string => typeof item === "string") } : {}),
          ...(Array.isArray(modalities.output) ? { output: modalities.output.filter((item): item is string => typeof item === "string") } : {}),
        } } : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(reasoningOptions ? { reasoning_options: reasoningOptions } : {}),
        ...(limit ? { limit: {
          ...(validLimit(limit.context) ? { context: Number(limit.context) } : {}),
          ...(validLimit(limit.input) ? { input: Number(limit.input) } : {}),
          ...(validLimit(limit.output) ? { output: Number(limit.output) } : {}),
        } } : {}),
      }]];
    }));
    return [[providerId, {
      ...(typeof provider.id === "string" ? { id: provider.id } : {}),
      ...(typeof provider.name === "string" ? { name: provider.name } : {}),
      ...(typeof provider.api === "string" ? { api: provider.api } : {}),
      ...(typeof provider.npm === "string" ? { npm: provider.npm } : {}),
      ...(Array.isArray(provider.env) ? { env: provider.env.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof provider.doc === "string" ? { doc: provider.doc } : {}),
      models,
    }]];
  }));
}

function validateCatalog(catalog: ModelCatalog, expected?: { providers: number; models: number }): ModelCatalog {
  const providers = Object.keys(catalog).length;
  const models = Object.values(catalog).reduce((count, provider) => count + Object.keys(provider.models ?? {}).length, 0);
  const minimumProviders = Math.floor(bundledCatalogMetadata.providers * 0.8);
  const minimumModels = Math.floor(bundledCatalogMetadata.models * 0.8);
  if (providers < minimumProviders || models < minimumModels || !Object.keys(catalog.openai?.models ?? {}).length) {
    throw new Error(`Models.dev returned an incomplete catalog (${providers}/${bundledCatalogMetadata.providers} providers, ${models}/${bundledCatalogMetadata.models} models)`);
  }
  if (expected && (providers !== expected.providers || models !== expected.models)) throw new Error("Bundled Models.dev catalog metadata does not match its payload");
  return catalog;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A compressed, release-pinned copy keeps provider/model selection and routing
// usable offline without adding the whole JSON text to the main JavaScript chunk.
let bundledCatalogPending: Promise<ModelCatalog> | undefined;
function loadBundledCatalog(): Promise<ModelCatalog> {
  return bundledCatalogPending ??= (async () => {
    const compressed = Uint8Array.from(atob(bundledCatalogGzip), (character) => character.charCodeAt(0));
    const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
    const json = await new Response(stream).text();
    if (await sha256(json) !== bundledCatalogMetadata.sha256) throw new Error("Bundled Models.dev catalog checksum mismatch");
    return validateCatalog(normalizeCatalog(JSON.parse(json)), bundledCatalogMetadata);
  })();
}

export function modelProviderPresets(catalog: ModelCatalog): ModelProviderPreset[] {
  return Object.entries(catalog).flatMap(([id, provider]) => {
    const defaultSdk = id === "deepseek" && provider.npm === "@ai-sdk/openai-compatible" ? "@ai-sdk/deepseek" : provider.npm;
    const defaultProvider = isModelSdk(defaultSdk) ? undefined : { npm: defaultSdk ?? "" };
    const modelProviders = Object.fromEntries(Object.entries(provider.models ?? {}).flatMap(([modelId, model]) => {
      const route = { ...defaultProvider, ...model.provider };
      return [[modelId, route], ...(model.id && model.id !== modelId ? [[model.id, route]] : [])];
    }));
    const models = Object.entries(provider.models ?? {}).filter(([, model]) =>
      isModelSdk(model.provider?.npm ?? defaultSdk) && model.tool_call === true && (model.modalities?.output?.includes("text") ?? true),
    ).map(([modelId, model]) => ({ id: model.id ?? modelId, name: model.name ?? modelId,
      ...(model.family ? { family: model.family } : {}), ...(model.canonical_model_id ? { canonicalModelId: model.canonical_model_id } : {}) }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const sdk = isModelSdk(defaultSdk) ? defaultSdk : modelProviders[models[0]?.id ?? ""]?.npm;
    if (!isModelSdk(sdk)) return [];
    const gateway = sdk === "@ai-sdk/gateway";
    const descriptor = { id, npm: sdk, api: provider.api, env: provider.env };
    return [{ id, name: provider.name ?? id, baseURL: gateway ? VERCEL_GATEWAY_URL : provider.api ?? defaultBaseURL(sdk),
      sdk, env: provider.env ?? [], doc: provider.doc, fields: providerSettingFields(descriptor),
      models, modelProviders,
      ...(defaultProvider ? { defaultProvider } : {}),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Apply the selected model's route without replacing the provider's credentials/settings. */
export function applyModelPreset<T extends ModelConfig>(config: T, preset: ModelProviderPreset): Omit<T, "sdk" | "baseURL" | "modelProvider"> & {
  sdk: ModelSdk; baseURL: string; modelProvider?: ModelProviderOverride; catalogRouteVersion: number;
} {
  const route = preset.modelProviders && Object.hasOwn(preset.modelProviders, config.model.trim())
    ? preset.modelProviders[config.model.trim()] : config.modelProvider;
  const modelProvider = route && Object.keys(route).length ? route : undefined;
  const selected = preset.models.find((model) => model.id === config.model.trim());
  return {
    ...config,
    sdk: isModelSdk(modelProvider?.npm) ? modelProvider.npm : preset.sdk,
    baseURL: modelProvider?.api ?? (config.modelProvider?.api !== undefined ? preset.baseURL : config.baseURL.trim() ? config.baseURL : preset.baseURL),
    modelProvider,
    canonicalModelId: selected?.canonicalModelId,
    modelFamily: selected?.family,
    catalogRouteVersion: MODEL_ROUTING_VERSION,
  };
}

export function modelPresetFields(config: ModelConfig, preset?: ModelProviderPreset): ProviderSettingField[] {
  return providerSettingFields({ id: isCloudflareGateway(config) ? "cloudflare-ai-gateway" : config.providerId ?? "custom", npm: config.modelProvider?.npm ?? sdkFor(config), api: config.baseURL, env: preset?.env });
}

type SharedRequest<T> = { operationId: string; promise: Promise<T>; controller: AbortController; consumers: Set<symbol>; settled: boolean; background?: SharedRequest<T> };
const catalogRequests = new WeakMap<typeof globalThis.fetch, Map<string, SharedRequest<ModelCatalog>>>();
const requestIdentities = new WeakMap<object, number>();
let nextRequestIdentity = 0;
function requestIdentity(value: object | undefined): number {
  if (!value) return 0;
  let identity = requestIdentities.get(value);
  if (identity === undefined) { identity = ++nextRequestIdentity; requestIdentities.set(value, identity); }
  return identity;
}

/** Cancellation belongs to each consumer; the shared I/O stops only after its last consumer leaves. */
function consumeRequest<T>(request: SharedRequest<T>, signal: AbortSignal | undefined, abandoned: () => void): Promise<T> {
  signal?.throwIfAborted();
  const consumer = Symbol();
  request.consumers.add(consumer);
  return new Promise<T>((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener("abort", abort);
      request.consumers.delete(consumer);
      if (!request.settled && !request.consumers.size) { abandoned(); request.controller.abort(new DOMException("Catalog request has no remaining consumers", "AbortError")); }
    };
    const abort = () => { release(); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    request.promise.then((value) => { release(); resolve(value); }, (error) => { release(); reject(error); });
    if (signal?.aborted) abort();
  });
}
const backgroundCatalogRefreshes = new WeakMap<typeof globalThis.fetch, Map<string, SharedRequest<ModelCatalog>>>();
const catalogRevisions = new WeakMap<ModelCatalog, string>();

function cachedCatalogRevision(cached?: CachedCatalog): string {
  return cached?.revision ?? (cached ? `legacy:${cached.fetchedAt}` : `bundle:${bundledCatalogMetadata.sha256}`);
}

export function loadModelCatalog(
  options: { storage?: Storage; fetch?: typeof globalThis.fetch; now?: () => number; signal?: AbortSignal; refresh?: boolean; onStale?: (error: unknown) => void; bundledFallback?: boolean; staleFallback?: boolean; validateCompleteness?: boolean; onDiagnostic?: (diagnostic: ModelDiagnostic) => void; diagnosticOperationId?: string; diagnosticContext?: ModelDiagnosticContext } = {},
): Promise<ModelCatalog> {
  const storage = options.storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : undefined);
  const validateCompleteness = options.validateCompleteness ?? !options.fetch;
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const task = async (operationId: string, signal: AbortSignal, setBackground: (request: SharedRequest<ModelCatalog>) => void) => {
    signal.throwIfAborted();
    const report = (phase: string, error: unknown) => modelDiagnostic(operationId, "catalog", phase, error, options.onDiagnostic, undefined, options.diagnosticContext);
    const stored = storage ? (await storage.get(CATALOG_CACHE_KEY).catch((error) => { report("cache-read", error); return { [CATALOG_CACHE_KEY]: undefined }; }))[CATALOG_CACHE_KEY] as CachedCatalog | undefined : undefined;
    let cached = stored?.version === CATALOG_CACHE_VERSION ? stored : undefined;
    try { if (cached?.catalog && validateCompleteness) validateCatalog(cached.catalog); } catch (error) { report("cache-validation", error); cached = undefined; }
    if (cached?.catalog && validateCompleteness && cached.fetchedAt < Date.parse(bundledCatalogMetadata.fetchedAt)) cached = undefined;
    if (cached?.catalog) catalogRevisions.set(cached.catalog, cached.revision ?? await sha256(JSON.stringify(cached.catalog)));
    if (!options.refresh && cached?.catalog && (options.now ?? Date.now)() - cached.fetchedAt < REFRESH_MS) return cached.catalog;
    const fetchCatalog = async (fetchSignal: AbortSignal | null = signal) => {
      const timeout = AbortSignal.timeout(10_000);
      const response = await (options.fetch ?? fetch)(CATALOG_URL, {
        ...(options.refresh ? { cache: "no-cache" as const } : {}),
        signal: fetchSignal ? AbortSignal.any([fetchSignal, timeout]) : timeout,
      });
      fetchSignal?.throwIfAborted();
      if (!response.ok) throw Object.assign(new Error(`models.dev HTTP ${response.status}`), { statusCode: response.status });
      const json = await response.json();
      fetchSignal?.throwIfAborted();
      const catalog = normalizeCatalog(json);
      if (validateCompleteness) validateCatalog(catalog);
      const fetchedAt = (options.now ?? Date.now)();
      const revision = await sha256(JSON.stringify(catalog));
      fetchSignal?.throwIfAborted();
      catalogRevisions.set(catalog, revision);
      if (storage) await storage.set({
        [CATALOG_CACHE_KEY]: { version: CATALOG_CACHE_VERSION, fetchedAt, revision, catalog } satisfies CachedCatalog,
      }).catch((error) => report("cache-write", error));
      return catalog;
    };
    const fallbackToBundle = async () => {
      signal.throwIfAborted();
      const catalog = await loadBundledCatalog();
      signal.throwIfAborted();
      catalogRevisions.set(catalog, cachedCatalogRevision());
      return catalog;
    };
    if (!cached?.catalog && !options.refresh && !options.fetch && options.bundledFallback !== false) {
      const catalog = await fallbackToBundle();
      const fetcher = globalThis.fetch;
      let refreshes = backgroundCatalogRefreshes.get(fetcher);
      if (!refreshes) { refreshes = new Map(); backgroundCatalogRefreshes.set(fetcher, refreshes); }
      let refresh = refreshes.get(key);
      if (!refresh) {
        const controller = new AbortController();
        refresh = { operationId, controller, consumers: new Set(), settled: false, promise: undefined! };
        const current = refresh;
        current.promise = fetchCatalog(controller.signal).catch((error) => {
          if (!controller.signal.aborted) { report("background-refresh", error); options.onStale?.(error); }
          throw error;
        }).finally(() => {
          current.settled = true;
          if (refreshes!.get(key) === current) refreshes!.delete(key);
        });
        void current.promise.catch(() => undefined);
        refreshes.set(key, current);
      } else linkModelDiagnostic(options.diagnosticContext, refresh.operationId, "catalog-background-refresh");
      setBackground(refresh);
      return catalog;
    }
    try {
      return await fetchCatalog();
    } catch (error) {
      if (signal.aborted) throw error;
      report("fetch", error);
      if (cached?.catalog && options.staleFallback !== false) {
        options.onStale?.(error);
        return cached.catalog;
      }
      // Custom fetchers are generally tests/adapters which need the original
      // failure for retry classification. The normal extension path is offline-safe.
      if (options.staleFallback !== false && (options.bundledFallback ?? !options.fetch)) {
        options.onStale?.(error);
        return fallbackToBundle();
      }
      throw error;
    }
  };
  const fetcher = options.fetch ?? globalThis.fetch;
  let catalogPending = catalogRequests.get(fetcher);
  if (!catalogPending) { catalogPending = new Map(); catalogRequests.set(fetcher, catalogPending); }
  // Signals never participate in the request identity. Overrides with different
  // storage, time or fallback policies must remain independent.
  const key = JSON.stringify([requestIdentity(storage), requestIdentity(options.now), Boolean(options.refresh),
    options.bundledFallback ?? !options.fetch, options.staleFallback !== false, validateCompleteness,
    requestIdentity(options.onStale), requestIdentity(options.onDiagnostic)]);
  let request = catalogPending.get(key);
  if (!request) {
    const operationId = options.diagnosticOperationId ?? crypto.randomUUID();
    const controller = new AbortController();
    request = { operationId, controller, consumers: new Set(), settled: false, promise: undefined! };
    const current = request;
    current.promise = task(operationId, controller.signal, (background) => { current.background = background; }).finally(() => {
      current.settled = true;
      if (catalogPending!.get(key) === current) catalogPending!.delete(key);
    });
    catalogPending.set(key, current);
  }
  const current = request;
  linkModelDiagnostic(options.diagnosticContext, current.operationId, "catalog");
  return consumeRequest(current, options.signal, () => { if (catalogPending!.get(key) === current) catalogPending!.delete(key); }).then((catalog) => {
    // Returning the offline bundle does not detach the caller from its refresh.
    // Its signal remains a consumer until the refresh ends or that caller leaves.
    if (current.background && !options.signal?.aborted) {
      const background = current.background;
      void consumeRequest(background, options.signal, () => {
        const refreshes = backgroundCatalogRefreshes.get(fetcher);
        if (refreshes?.get(key) === background) refreshes.delete(key);
      }).catch(() => undefined);
    }
    return catalog;
  });
}

// Derived matches need not be persisted separately from the authoritative catalog.
// Keep a few revisions so an in-flight lookup against an older snapshot cannot
// invalidate results from a newer one.
const limitMatches = new Map<string, Map<string, ModelLimit>>();

export function modelLimitKey(config: ModelConfig): string {
  return JSON.stringify([sdkFor(config), config.providerId ?? "", resolvedBaseURL(config), config.model.trim(), config.contextWindowOverride ?? null]);
}

export function resolveModelLimit(
  config: ModelConfig,
  options: { storage?: Storage; fetch?: typeof globalThis.fetch; now?: () => number; signal?: AbortSignal; onDiagnostic?: (diagnostic: ModelDiagnostic) => void; diagnosticContext?: ModelDiagnosticContext } = {},
): Promise<ModelLimit | undefined> {
  const key = modelLimitKey(config);
  const task = async (operationId = crypto.randomUUID()): Promise<ModelLimit | undefined> => {
    try {
      const catalog = await loadModelCatalog({ ...options, diagnosticOperationId: operationId });
      const catalogRevision = catalogRevisions.get(catalog) ?? cachedCatalogRevision();
      let matches = limitMatches.get(catalogRevision);
      if (!matches) {
        matches = new Map();
        limitMatches.set(catalogRevision, matches);
        if (limitMatches.size > 4) limitMatches.delete(limitMatches.keys().next().value!);
      }
      const cached = matches.get(key);
      if (cached) return cached;
      const detected = matchModel(catalog, resolvedBaseURL(config), config.model, config.providerId)
        ?? { provider: "unknown", model: config.model, context: 256_000, source: "estimated" } as ModelLimit;
      const match: ModelLimit = validLimit(config.contextWindowOverride)
        ? { ...detected, context: config.contextWindowOverride, input: undefined, source: "manual" } : detected;
      matches.set(key, match);
      return match;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      modelDiagnostic(operationId, "model-limit", "resolution", error, options.onDiagnostic, undefined, options.diagnosticContext);
      return { provider: "unknown", model: config.model, context: config.contextWindowOverride ?? 256_000,
        source: validLimit(config.contextWindowOverride) ? "manual" : "estimated" };
    }
  };
  // Catalog I/O is shared with independent cancellation above; once it resolves,
  // all models reuse the same revision-scoped match cache.
  return task();
}

export function inputBudget(limit: ModelLimit): number {
  return Math.min(limit.input ?? Number.POSITIVE_INFINITY, limit.context);
}

export async function modelSupportsImages(config: ModelConfig, options: Parameters<typeof resolveModelLimit>[1] = {}): Promise<boolean> {
  if (config.imageInput === "enabled") return true;
  if (config.imageInput === "disabled") return false;
  return (await resolveModelLimit({ ...config, contextWindowOverride: undefined }, options))?.inputModalities?.includes("image") ?? false;
}

export function contextUsedPercent(estimated: number, limit: ModelLimit): number {
  return Math.max(0, Math.min(100, Math.round(estimated / inputBudget(limit) * 100)));
}
