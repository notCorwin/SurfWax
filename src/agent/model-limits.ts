import { isModelSdk, type ModelConfig, type ModelSdk } from "../types";
import { defaultBaseURL, providerSettingFields, resolvedBaseURL, sdkFor, type ProviderSettingField } from "./model-sdks";

const CACHE_KEY = "side-agent:model-limit";
const CATALOG_CACHE_KEY = "side-agent:model-catalog";
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
    tool_call?: boolean;
    modalities?: { input?: string[]; output?: string[] };
    reasoning?: boolean;
    reasoning_options?: Array<{ type?: string; values?: string[] }>;
    limit?: { context?: number; input?: number; output?: number };
  }>;
}>;

type CachedLimit = { key: string; fetchedAt: number; match: ModelLimit };
type CachedCatalog = { fetchedAt: number; catalog: ModelCatalog };
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
  transport: "gateway" | "openai-compatible";
  models: Array<{ id: string; name: string }>;
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
    const providerHost = hostname(provider.api ?? "");
    const providerMatch = selectedProviderId === providerId || Boolean(host && providerHost && host === providerHost);
    if (!providerMatch) continue;
    for (const [id, details] of Object.entries(provider.models ?? {})) {
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

export function modelProviderPresets(catalog: ModelCatalog): ModelProviderPreset[] {
  return Object.entries(catalog).flatMap(([id, provider]) => {
    if (!isModelSdk(provider.npm)) return [];
    const gateway = provider.npm === "@ai-sdk/gateway";
    const models = Object.entries(provider.models ?? {}).filter(([, model]) =>
      model.tool_call === true && (model.modalities?.output?.includes("text") ?? true),
    ).map(([modelId, model]) => ({ id: model.id ?? modelId, name: model.name ?? modelId }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const descriptor = { id, npm: provider.npm, api: provider.api, env: provider.env };
    return [{ id, name: provider.name ?? id, baseURL: gateway ? VERCEL_GATEWAY_URL : provider.api ?? defaultBaseURL(provider.npm),
      sdk: provider.npm, env: provider.env ?? [], doc: provider.doc, fields: providerSettingFields(descriptor),
      transport: gateway ? "gateway" as const : "openai-compatible" as const, models }];
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

const catalogPending = new Map<string, Promise<ModelCatalog>>();

export function loadModelCatalog(
  options: { storage?: Storage; fetch?: typeof globalThis.fetch; now?: () => number; signal?: AbortSignal } = {},
): Promise<ModelCatalog> {
  const storage = options.storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : undefined);
  const task = async () => {
    const cached = storage ? (await storage.get(CATALOG_CACHE_KEY).catch(() => ({ [CATALOG_CACHE_KEY]: undefined })))[CATALOG_CACHE_KEY] as CachedCatalog | undefined : undefined;
    if (cached?.catalog && (options.now ?? Date.now)() - cached.fetchedAt < REFRESH_MS) return cached.catalog;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await (options.fetch ?? fetch)(CATALOG_URL, {
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      const catalog = normalizeCatalog(await response.json());
      if (storage) await storage.set({ [CATALOG_CACHE_KEY]: { fetchedAt: (options.now ?? Date.now)(), catalog } satisfies CachedCatalog }).catch(() => undefined);
      return catalog;
    } catch (error) {
      if (options.signal?.aborted || !cached?.catalog) throw error;
      return cached.catalog;
    }
  };
  if (options.signal || options.fetch || options.storage || options.now) return task();
  const existing = catalogPending.get(CATALOG_URL);
  if (existing) return existing;
  const result = task().finally(() => catalogPending.delete(CATALOG_URL));
  catalogPending.set(CATALOG_URL, result);
  return result;
}

const pending = new Map<string, Promise<ModelLimit | undefined>>();

export function resolveModelLimit(
  config: ModelConfig,
  options: { storage?: Storage; fetch?: typeof globalThis.fetch; now?: () => number; signal?: AbortSignal } = {},
): Promise<ModelLimit | undefined> {
  const key = `${sdkFor(config)}\u0000${config.providerId ?? ""}\u0000${resolvedBaseURL(config)}\u0000${config.model.trim()}`;
  const storage = options.storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : undefined);
  const task = async () => {
    if (validLimit(config.contextWindowOverride)) {
      return { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" } as ModelLimit;
    }
    const cached = storage ? (await storage.get(CACHE_KEY).catch(() => ({ [CACHE_KEY]: undefined })))[CACHE_KEY] as CachedLimit | undefined : undefined;
    const validCache = cached?.key === key && validLimit(cached.match?.context) ? cached : undefined;
    if (validCache && (options.now ?? Date.now)() - validCache.fetchedAt < REFRESH_MS) return validCache.match;
    try {
      const catalog = await loadModelCatalog(options);
      const match = matchModel(catalog, resolvedBaseURL(config), config.model, config.providerId);
      if (match && storage) await storage.set({ [CACHE_KEY]: { key, fetchedAt: (options.now ?? Date.now)(), match } satisfies CachedLimit }).catch(() => undefined);
      return match ?? validCache?.match ?? { provider: "unknown", model: config.model, context: 262_144, source: "estimated" };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return validCache?.match ?? { provider: "unknown", model: config.model, context: 262_144, source: "estimated" };
    }
  };
  if (options.signal || options.fetch || options.storage || options.now) return task();
  const existing = pending.get(key);
  if (existing) return existing;
  const result = task().finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

export function inputBudget(limit: ModelLimit): number {
  return Math.min(limit.input ?? Number.POSITIVE_INFINITY, limit.context - Math.min(limit.output ?? 4096, Math.floor(limit.context / 5)));
}

export async function modelSupportsImages(config: ModelConfig, options: Parameters<typeof resolveModelLimit>[1] = {}): Promise<boolean> {
  if (config.imageInput === "enabled") return true;
  if (config.imageInput === "disabled") return false;
  return (await resolveModelLimit({ ...config, contextWindowOverride: undefined }, options))?.inputModalities?.includes("image") ?? false;
}

export function contextUsedPercent(estimated: number, limit: ModelLimit): number {
  return Math.max(0, Math.min(100, Math.round(estimated / inputBudget(limit) * 100)));
}
