import { isModelSdk, type ModelConfig, type ModelSdk } from "../types";
import { modelConfigErrors } from "../agent/model-sdks";
import { isAbortError, retryModelOperation } from "../agent/model";
import { loadModelCatalog, MODEL_ROUTING_VERSION, normalizeModelProviderOverride, type ModelCatalog } from "../agent/model-limits";

export const MODEL_CONFIG_STORAGE_KEY = "side-agent:model-config";
export type ModelProfile = ModelConfig & { providerId: string; sdk: ModelSdk; providerSettings: Record<string, string>; catalogRouteVersion?: number };
export type PersistedModelConfig = { selectedProviderId: string; profiles: Record<string, ModelProfile>; systemPrompt?: string };
export const EMPTY_MODEL_CONFIG: PersistedModelConfig = { selectedProviderId: "", profiles: {} };

export type StorageAreaLike = Pick<chrome.storage.StorageArea, "get" | "set">;

export function isCompleteModelConfig(config: ModelConfig | undefined): boolean {
  return Boolean(config && Object.keys(modelConfigErrors(config)).length === 0);
}

export function selectedModelConfig(config: PersistedModelConfig): ModelProfile | undefined {
  return config.profiles[config.selectedProviderId];
}

function getStorageArea(): StorageAreaLike | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

export async function loadModelConfig(
  fallback: PersistedModelConfig = EMPTY_MODEL_CONFIG,
  storage = getStorageArea(),
  options: {
    loadCatalog?: (options: { signal: AbortSignal }) => Promise<ModelCatalog>;
    migrateCatalogRouting?: boolean;
    persistMigration?: boolean;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PersistedModelConfig> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (!storage) return fallback;

  const stored = await storage.get(MODEL_CONFIG_STORAGE_KEY);
  signal.throwIfAborted();
  const value = stored[MODEL_CONFIG_STORAGE_KEY];
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Record<string, unknown>;
  if (candidate.profiles && typeof candidate.profiles === "object" && !Array.isArray(candidate.profiles)) {
    const profiles = Object.fromEntries(Object.entries(candidate.profiles).flatMap(([providerId, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const profile = raw as Record<string, unknown>;
      const restoredProvider = normalizeModelProviderOverride(profile.modelProvider);
      // An unavailable persisted SDK is an error, not permission to use another protocol.
      const modelProvider = typeof profile.sdk === "string" && !isModelSdk(profile.sdk) && restoredProvider?.npm === undefined
        ? { ...restoredProvider, npm: profile.sdk } : restoredProvider;
      const sdk = isModelSdk(profile.sdk) ? profile.sdk : profile.transport === "gateway" ? "@ai-sdk/gateway" : "@ai-sdk/openai-compatible";
      const rawSettings = profile.providerSettings && typeof profile.providerSettings === "object" && !Array.isArray(profile.providerSettings)
        ? profile.providerSettings as Record<string, unknown> : {};
      const providerSettings = Object.fromEntries(Object.entries(rawSettings).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (!providerSettings.apiKey && typeof profile.apiKey === "string") providerSettings.apiKey = profile.apiKey;
      return [[providerId, {
        providerId,
        sdk,
        ...(profile.catalogRouteVersion === MODEL_ROUTING_VERSION ? { catalogRouteVersion: MODEL_ROUTING_VERSION } : {}),
        ...(modelProvider ? { modelProvider } : {}),
        providerSettings,
        baseURL: typeof profile.baseURL === "string" ? profile.baseURL : "",
        model: typeof profile.model === "string" ? profile.model : "",
        imageInput: profile.imageInput === "enabled" || profile.imageInput === "disabled" ? profile.imageInput : "auto",
        ...(Number.isSafeInteger(profile.contextWindowOverride) && Number(profile.contextWindowOverride) > 0
          ? { contextWindowOverride: Number(profile.contextWindowOverride) } : {}),
      } satisfies ModelProfile]];
    }));
    const result: PersistedModelConfig = {
      selectedProviderId: typeof candidate.selectedProviderId === "string" ? candidate.selectedProviderId : "",
      profiles,
      ...(typeof candidate.systemPrompt === "string" && candidate.systemPrompt.trim() ? { systemPrompt: candidate.systemPrompt } : {}),
    };
    const selected = selectedModelConfig(result);
    if (options.migrateCatalogRouting !== false && selected && selected.providerId !== "custom" && !selected.modelProvider && selected.catalogRouteVersion !== MODEL_ROUTING_VERSION) {
      // Profiles created before model-level routing must be enriched before dispatch.
      // Recoverable catalog failures retry until recovery or cancellation. Permanent
      // failures leave storage untouched rather than selecting the wrong protocol.
      let catalog: ModelCatalog;
      try {
        catalog = await retryModelOperation(() => (options.loadCatalog ?? loadModelCatalog)({ signal }), {
          signal, purpose: "model-catalog-migration", sleep: options.sleep,
        });
      } catch (cause) {
        if (isAbortError(cause, signal)) throw cause;
        throw new Error("模型路由目录更新失败，请检查配置后重试。", { cause });
      }
      signal.throwIfAborted();
      const provider = catalog[selected.providerId];
      if (!provider) throw new Error(`模型目录中找不到 Provider：${selected.providerId}；请在设置中重新选择 Provider。`);
      const model = provider.models?.[selected.model] ?? Object.values(provider.models ?? {}).find((model) => model.id === selected.model);
      const modelProvider = normalizeModelProviderOverride(model?.provider)
        ?? (provider.npm !== undefined && !isModelSdk(provider.npm) ? { npm: provider.npm } : undefined);
      result.profiles[selected.providerId] = {
        ...selected,
        ...(modelProvider ? { modelProvider } : {}),
        sdk: isModelSdk(modelProvider?.npm) ? modelProvider.npm : selected.sdk,
        baseURL: modelProvider?.api ?? selected.baseURL,
        catalogRouteVersion: MODEL_ROUTING_VERSION,
      };
      if (options.persistMigration !== false) {
        const current = await storage.get(MODEL_CONFIG_STORAGE_KEY);
        signal.throwIfAborted();
        if (JSON.stringify(current[MODEL_CONFIG_STORAGE_KEY]) !== JSON.stringify(value)) {
          throw new DOMException("Model configuration changed during migration", "AbortError");
        }
        await storage.set({ [MODEL_CONFIG_STORAGE_KEY]: result });
        signal.throwIfAborted();
      }
    }
    return result;
  }

  const legacy = candidate as Partial<Record<keyof ModelConfig, unknown>>;
  if (typeof legacy.baseURL !== "string" && typeof legacy.apiKey !== "string" && typeof legacy.model !== "string") return fallback;
  return { selectedProviderId: "custom", profiles: { custom: {
    providerId: "custom",
    sdk: "@ai-sdk/openai-compatible",
    providerSettings: { apiKey: typeof legacy.apiKey === "string" ? legacy.apiKey : "" },
    baseURL: typeof legacy.baseURL === "string" ? legacy.baseURL : "",
    model: typeof legacy.model === "string" ? legacy.model : "",
    imageInput: legacy.imageInput === "enabled" || legacy.imageInput === "disabled" ? legacy.imageInput : "auto",
    ...(Number.isSafeInteger(legacy.contextWindowOverride) && Number(legacy.contextWindowOverride) > 0
      ? { contextWindowOverride: Number(legacy.contextWindowOverride) } : {}),
  } } };
}

export async function saveModelConfig(
  config: PersistedModelConfig,
  storage = getStorageArea(),
): Promise<void> {
  if (!storage) throw new Error("Chrome storage is unavailable");

  await storage.set({
    [MODEL_CONFIG_STORAGE_KEY]: {
      selectedProviderId: config.selectedProviderId,
      profiles: Object.fromEntries(Object.entries(config.profiles).map(([providerId, profile]) => [providerId, {
        providerId,
        sdk: profile.sdk,
        ...(profile.catalogRouteVersion === MODEL_ROUTING_VERSION ? { catalogRouteVersion: MODEL_ROUTING_VERSION } : {}),
        ...(profile.modelProvider ? { modelProvider: normalizeModelProviderOverride(profile.modelProvider) } : {}),
        providerSettings: Object.fromEntries(Object.entries(profile.providerSettings).map(([key, value]) => [key, value.trim()])),
        baseURL: profile.baseURL.trim(),
        model: profile.model.trim(),
        imageInput: profile.imageInput ?? "auto",
        ...(profile.contextWindowOverride ? { contextWindowOverride: profile.contextWindowOverride } : {}),
      }])),
      ...(config.systemPrompt?.trim() ? { systemPrompt: config.systemPrompt } : {}),
    } satisfies PersistedModelConfig,
  });
}
