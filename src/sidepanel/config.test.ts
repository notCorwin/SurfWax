import { describe, expect, it } from "vitest";
import { JEV_PROVIDERS, JEV_PROVIDER_PRESETS } from "../jev-providers";
import {
  DEFAULT_JEV_CONFIG,
  JEV_CONFIG_STORAGE_KEY,
  MODEL_CONFIG_STORAGE_KEY,
  isCompleteJevConfig,
  isCompleteModelConfig,
  loadJevConfig,
  loadModelConfig,
  saveJevConfig,
  saveModelConfig,
  type StorageAreaLike,
} from "./config";

function memoryStorage(key: string): StorageAreaLike & { value?: unknown } {
  const storage: StorageAreaLike & { value?: unknown } = {
    value: undefined,
    async get() {
      return { [key]: storage.value };
    },
    async set(items) {
      storage.value = (items as Record<string, unknown>)[key];
    },
  };
  return storage;
}

describe("model config persistence", () => {
  it("recognizes complete configuration without trimming the API key", () => {
    expect(isCompleteModelConfig({ baseURL: " https://provider.test/v1 ", model: " model ", apiKey: " key " })).toBe(true);
    expect(isCompleteModelConfig({ baseURL: "", model: "model", apiKey: "key" })).toBe(false);
  });

  it("saves the three fields and loads them back", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const config = { selectedProviderId: "custom", profiles: { custom: {
      providerId: "custom", sdk: "@ai-sdk/openai-compatible" as const, providerSettings: { apiKey: "secret-key" }, baseURL: " https://provider.test/v1 ", model: " model-id ",
    } } };

    await saveModelConfig(config, storage);
    await expect(loadModelConfig(undefined, storage)).resolves.toEqual({ selectedProviderId: "custom", profiles: { custom: {
      providerId: "custom", sdk: "@ai-sdk/openai-compatible", providerSettings: { apiKey: "secret-key" }, baseURL: "https://provider.test/v1", model: "model-id", imageInput: "auto",
    } } });
  });

  it("persists an optional manual context window", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const config = { selectedProviderId: "vercel", profiles: { vercel: {
      providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "test", contextWindowOverride: 8192,
    } } };
    await saveModelConfig(config, storage);
    await expect(loadModelConfig(undefined, storage)).resolves.toEqual({ selectedProviderId: "vercel", profiles: { vercel: { ...config.profiles.vercel, imageInput: "auto" } } });
  });

  it("migrates the previous single provider config to custom", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    storage.value = { baseURL: "https://provider.test/v1", model: "old", apiKey: "secret" };
    await expect(loadModelConfig(undefined, storage)).resolves.toMatchObject({
      selectedProviderId: "custom",
      profiles: { custom: { providerId: "custom", sdk: "@ai-sdk/openai-compatible", model: "old", providerSettings: { apiKey: "secret" } } },
    });
  });

  it("keeps credentials and model choices isolated by provider", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const settings = { selectedProviderId: "vercel", profiles: {
      vercel: { providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "vercel-key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "openai/gpt" },
      custom: { providerId: "custom", sdk: "@ai-sdk/openai-compatible" as const, providerSettings: { apiKey: "custom-key" }, baseURL: "https://custom.test/v1", model: "custom-model" },
    } };
    await saveModelConfig(settings, storage);
    await expect(loadModelConfig(undefined, storage)).resolves.toEqual({ selectedProviderId: "vercel", profiles: {
      vercel: { ...settings.profiles.vercel, imageInput: "auto" }, custom: { ...settings.profiles.custom, imageInput: "auto" },
    } });
  });
});

describe("Jev config persistence", () => {
  it("defines valid editable defaults for every Jev platform", () => {
    expect(JEV_PROVIDERS).toHaveLength(9);
    for (const provider of JEV_PROVIDERS) {
      expect(JEV_PROVIDER_PRESETS[provider].label).toBeTruthy();
      expect(JEV_PROVIDER_PRESETS[provider].model).toBeTruthy();
      if (JEV_PROVIDER_PRESETS[provider].baseURL) expect(() => new URL(JEV_PROVIDER_PRESETS[provider].baseURL)).not.toThrow();
    }
  });

  it("uses the default endpoint and disables Jev when the API key is empty", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    await expect(loadJevConfig(DEFAULT_JEV_CONFIG, storage)).resolves.toEqual(DEFAULT_JEV_CONFIG);
    expect(isCompleteJevConfig(DEFAULT_JEV_CONFIG)).toBe(false);
    expect(isCompleteJevConfig({ ...DEFAULT_JEV_CONFIG, apiKey: " key " })).toBe(true);
  });

  it("saves and loads Jev independently", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    const config = { provider: "openrouter" as const, baseURL: " https://jev.example/v1/ ", model: " jev-test ", apiKey: "jev-secret", threshold: 0.81 };

    await saveJevConfig(config, storage);
    await expect(loadJevConfig(DEFAULT_JEV_CONFIG, storage)).resolves.toEqual({
      provider: "openrouter",
      baseURL: "https://jev.example/v1/",
      model: "jev-test",
      apiKey: "jev-secret",
      threshold: 0.81,
    });
    await saveJevConfig({ ...config, apiKey: "" }, storage);
    expect(isCompleteJevConfig(await loadJevConfig(DEFAULT_JEV_CONFIG, storage))).toBe(false);
  });

  it("adds the default provider and threshold to an older stored config", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    storage.value = { baseURL: "https://api.typesafe.ai", model: "jev-latest", apiKey: "old-key" };
    expect(await loadJevConfig(DEFAULT_JEV_CONFIG, storage)).toMatchObject({ provider: "typesafe", threshold: 0.5 });
  });
});
