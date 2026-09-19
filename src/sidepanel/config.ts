import type { JevConfig, ModelConfig } from "../types";
import { isJevProvider } from "../jev-providers";

export const MODEL_CONFIG_STORAGE_KEY = "side-agent:model-config";
export const JEV_CONFIG_STORAGE_KEY = "side-agent:jev-config";
export const DEFAULT_JEV_CONFIG: JevConfig = {
  provider: "typesafe",
  baseURL: "https://api.typesafe.ai",
  apiKey: "",
  model: "jev-latest",
  threshold: 0.5,
};

export type PersistedModelConfig = ModelConfig;
export type PersistedJevConfig = JevConfig;

export type StorageAreaLike = Pick<chrome.storage.StorageArea, "get" | "set">;

export function isCompleteModelConfig(config: PersistedModelConfig): boolean {
  return Boolean(config.baseURL.trim() && config.apiKey.trim() && config.model.trim());
}

export function isCompleteJevConfig(config: PersistedJevConfig): boolean {
  return Boolean(isJevProvider(config.provider) && config.baseURL.trim() && config.apiKey.trim() && config.model.trim());
}

function getStorageArea(): StorageAreaLike | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

export async function loadModelConfig(
  fallback: PersistedModelConfig,
  storage = getStorageArea(),
): Promise<PersistedModelConfig> {
  if (!storage) return fallback;

  const stored = await storage.get(MODEL_CONFIG_STORAGE_KEY);
  const value = stored[MODEL_CONFIG_STORAGE_KEY];
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Partial<Record<keyof PersistedModelConfig, unknown>>;
  return {
    baseURL: typeof candidate.baseURL === "string" ? candidate.baseURL : fallback.baseURL,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : fallback.apiKey,
    model: typeof candidate.model === "string" ? candidate.model : fallback.model,
    ...(Number.isSafeInteger(candidate.contextWindowOverride) && Number(candidate.contextWindowOverride) > 0
      ? { contextWindowOverride: Number(candidate.contextWindowOverride) } : {}),
  };
}

export async function saveModelConfig(
  config: PersistedModelConfig,
  storage = getStorageArea(),
): Promise<void> {
  if (!storage) throw new Error("Chrome storage is unavailable");

  await storage.set({
    [MODEL_CONFIG_STORAGE_KEY]: {
      baseURL: config.baseURL.trim(),
      apiKey: config.apiKey,
      model: config.model.trim(),
      ...(config.contextWindowOverride ? { contextWindowOverride: config.contextWindowOverride } : {}),
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
