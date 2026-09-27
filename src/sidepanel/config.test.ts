import { describe, expect, it } from "vitest";
import {
  MODEL_CONFIG_STORAGE_KEY,
  isCompleteModelConfig,
  loadModelConfig,
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

  it("persists one global system prompt across provider profiles", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const profiles = {
      vercel: { providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "vercel-key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "openai/gpt" },
      custom: { providerId: "custom", sdk: "@ai-sdk/openai-compatible" as const, providerSettings: { apiKey: "custom-key" }, baseURL: "https://custom.test/v1", model: "custom-model" },
    };
    await saveModelConfig({ selectedProviderId: "vercel", profiles, systemPrompt: "  Preserve this prompt exactly.  " }, storage);
    await expect(loadModelConfig(undefined, storage)).resolves.toMatchObject({
      selectedProviderId: "vercel", systemPrompt: "  Preserve this prompt exactly.  ", profiles: { vercel: expect.any(Object), custom: expect.any(Object) },
    });

    await saveModelConfig({ selectedProviderId: "custom", profiles, systemPrompt: "   " }, storage);
    expect(storage.value).not.toHaveProperty("systemPrompt");
    await expect(loadModelConfig(undefined, storage)).resolves.not.toHaveProperty("systemPrompt");
  });
});
