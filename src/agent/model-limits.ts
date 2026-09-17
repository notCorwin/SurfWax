import type { ModelConfig } from "../types";

const CACHE_KEY = "side-agent:model-limit";
const CATALOG_URL = "https://models.dev/api.json";
const REFRESH_MS = 24 * 60 * 60 * 1000;

export type ModelLimit = {
  provider: string;
  model: string;
  context: number;
  input?: number;
  output?: number;
  source: "models.dev" | "manual";
};

type Catalog = Record<string, {
  id?: string;
  name?: string;
  api?: string;
  models?: Record<string, { name?: string; limit?: { context?: number; input?: number; output?: number } }>;
}>;

type CachedLimit = { key: string; fetchedAt: number; match: ModelLimit };
type Storage = Pick<chrome.storage.StorageArea, "get" | "set">;

function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hostname(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + Number(left[i - 1] !== right[j - 1]));
      previous = old;
    }
  }
  return row[right.length]!;
}

export function matchModel(catalog: Catalog, baseURL: string, modelId: string): ModelLimit | undefined {
  const requested = modelId.toLowerCase();
  const requestedName = normalize(modelId.split("/").at(-1) ?? modelId);
  const host = hostname(baseURL);
  let best: { score: number; match: ModelLimit } | undefined;
  for (const [providerId, provider] of Object.entries(catalog)) {
    const providerHost = hostname(provider.api ?? "");
    const providerMatch = Boolean(host && (host === providerHost || host.includes(providerId.replace(/-/g, ""))));
    for (const [id, details] of Object.entries(provider.models ?? {})) {
      const limit = details.limit;
      if (!validLimit(limit?.context)) continue;
      const name = normalize(id.split("/").at(-1) ?? id);
      const score = (id.toLowerCase() === requested ? 1_000_000 : 0)
        + (normalize(id) === normalize(modelId) ? 100_000 : 0)
        + (name === requestedName ? 10_000 : 0)
        + (providerMatch ? 1_000 : 0)
        - distance(requestedName, name) * 100
        - Math.abs(name.length - requestedName.length);
      if (!best || score > best.score || score === best.score && `${providerId}/${id}` < `${best.match.provider}/${best.match.model}`) {
        best = {
          score,
          match: {
            provider: providerId,
            model: id,
            context: limit.context,
            ...(validLimit(limit.input) ? { input: limit.input } : {}),
            ...(validLimit(limit.output) ? { output: limit.output } : {}),
            source: "models.dev",
          },
        };
      }
    }
  }
  return best?.match;
}

const pending = new Map<string, Promise<ModelLimit | undefined>>();

export function resolveModelLimit(
  config: ModelConfig,
  options: { storage?: Storage; fetch?: typeof globalThis.fetch; now?: () => number; signal?: AbortSignal } = {},
): Promise<ModelLimit | undefined> {
  const key = `${config.baseURL.trim()}\u0000${config.model.trim()}`;
  const storage = options.storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : undefined);
  const task = async () => {
    if (validLimit(config.contextWindowOverride)) {
      return { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" } as ModelLimit;
    }
    const cached = storage ? (await storage.get(CACHE_KEY).catch(() => ({})))[CACHE_KEY] as CachedLimit | undefined : undefined;
    const validCache = cached?.key === key && validLimit(cached.match?.context) ? cached : undefined;
    if (validCache && (options.now ?? Date.now)() - validCache.fetchedAt < REFRESH_MS) return validCache.match;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await (options.fetch ?? fetch)(CATALOG_URL, {
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      const match = matchModel(await response.json() as Catalog, config.baseURL, config.model);
      if (match && storage) await storage.set({ [CACHE_KEY]: { key, fetchedAt: (options.now ?? Date)(), match } satisfies CachedLimit }).catch(() => undefined);
      return match ?? validCache?.match;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return validCache?.match;
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
