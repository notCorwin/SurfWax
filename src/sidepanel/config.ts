import { isModelSdk, type JevConfig, type ModelConfig, type ModelSdk } from "../types";
import { isJevProvider } from "../jev-providers";
import { modelConfigErrors } from "../agent/model-sdks";

export const MODEL_CONFIG_STORAGE_KEY = "side-agent:model-config";
export const JEV_CONFIG_STORAGE_KEY = "side-agent:jev-config";
export const DEFAULT_JEV_CONFIG: JevConfig = {
  provider: "typesafe",
  baseURL: "https://api.typesafe.ai",
  apiKey: "",
  model: "jev-latest",
  threshold: 0.5,
};

export type ModelProfile = ModelConfig & { providerId: string; sdk: ModelSdk; providerSettings: Record<string, string> };
export type PersistedModelConfig = { selectedProviderId: string; profiles: Record<string, ModelProfile>; systemPrompt?: string };
export type PersistedJevConfig = JevConfig;
export const EMPTY_MODEL_CONFIG: PersistedModelConfig = { selectedProviderId: "", profiles: {} };

export type StorageAreaLike = Pick<chrome.storage.StorageArea, "get" | "set">;

export function isCompleteModelConfig(config: ModelConfig | undefined): boolean {
  return Boolean(config && Object.keys(modelConfigErrors(config)).length === 0);
}

export function selectedModelConfig(config: PersistedModelConfig): ModelProfile | undefined {
  return config.profiles[config.selectedProviderId];
}

export function isCompleteJevConfig(config: PersistedJevConfig): boolean {
  return Boolean(isJevProvider(config.provider) && config.baseURL.trim() && config.apiKey.trim() && config.model.trim());
}

function getStorageArea(): StorageAreaLike | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

export async function loadModelConfig(
  fallback: PersistedModelConfig = EMPTY_MODEL_CONFIG,
  storage = getStorageArea(),
): Promise<PersistedModelConfig> {
  if (!storage) return fallback;

  const stored = await storage.get(MODEL_CONFIG_STORAGE_KEY);
  const value = stored[MODEL_CONFIG_STORAGE_KEY];
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Record<string, unknown>;
  if (candidate.profiles && typeof candidate.profiles === "object" && !Array.isArray(candidate.profiles)) {
    const profiles = Object.fromEntries(Object.entries(candidate.profiles).flatMap(([providerId, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const profile = raw as Record<string, unknown>;
      const sdk = isModelSdk(profile.sdk) ? profile.sdk : profile.transport === "gateway" ? "@ai-sdk/gateway" : "@ai-sdk/openai-compatible";
      const rawSettings = profile.providerSettings && typeof profile.providerSettings === "object" && !Array.isArray(profile.providerSettings)
        ? profile.providerSettings as Record<string, unknown> : {};
      const providerSettings = Object.fromEntries(Object.entries(rawSettings).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (!providerSettings.apiKey && typeof profile.apiKey === "string") providerSettings.apiKey = profile.apiKey;
      return [[providerId, {
        providerId,
        sdk,
        providerSettings,
        baseURL: typeof profile.baseURL === "string" ? profile.baseURL : "",
        model: typeof profile.model === "string" ? profile.model : "",
        imageInput: profile.imageInput === "enabled" || profile.imageInput === "disabled" ? profile.imageInput : "auto",
        ...(Number.isSafeInteger(profile.contextWindowOverride) && Number(profile.contextWindowOverride) > 0
          ? { contextWindowOverride: Number(profile.contextWindowOverride) } : {}),
      } satisfies ModelProfile]];
    }));
    return {
      selectedProviderId: typeof candidate.selectedProviderId === "string" ? candidate.selectedProviderId : "",
      profiles,
      ...(typeof candidate.systemPrompt === "string" && candidate.systemPrompt.trim() ? { systemPrompt: candidate.systemPrompt } : {}),
    };
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

export async function loadJevConfig(
  fallback: PersistedJevConfig = DEFAULT_JEV_CONFIG,
  storage = getStorageArea(),
): Promise<PersistedJevConfig> {
  if (!storage) return fallback;

  const stored = await storage.get(JEV_CONFIG_STORAGE_KEY);
  const value = stored[JEV_CONFIG_STORAGE_KEY];
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Partial<Record<keyof PersistedJevConfig, unknown>>;
  return {
    provider: isJevProvider(candidate.provider) ? candidate.provider : fallback.provider,
    baseURL: typeof candidate.baseURL === "string" ? candidate.baseURL : fallback.baseURL,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : fallback.apiKey,
    model: typeof candidate.model === "string" ? candidate.model : fallback.model,
    threshold: typeof candidate.threshold === "number" && Number.isInteger(Math.round(candidate.threshold * 100))
      && candidate.threshold >= 0.01 && candidate.threshold <= 0.99
      && Math.abs(candidate.threshold * 100 - Math.round(candidate.threshold * 100)) < 1e-8
      ? candidate.threshold : fallback.threshold,
  };
}

export async function saveJevConfig(
  config: PersistedJevConfig,
  storage = getStorageArea(),
): Promise<void> {
  if (!storage) throw new Error("Chrome storage is unavailable");

  await storage.set({
    [JEV_CONFIG_STORAGE_KEY]: {
      provider: config.provider,
      baseURL: config.baseURL.trim(),
      apiKey: config.apiKey,
      model: config.model.trim(),
      threshold: config.threshold,
    } satisfies PersistedJevConfig,
  });
}
