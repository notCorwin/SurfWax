import { describe, expect, it, vi } from "vitest";
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
      providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "test", contextWindowOverride: 8192, catalogRouteVersion: 1,
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
      vercel: { providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "vercel-key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "openai/gpt", catalogRouteVersion: 1 },
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
      vercel: { providerId: "vercel", sdk: "@ai-sdk/gateway" as const, providerSettings: { apiKey: "vercel-key" }, baseURL: "https://ai-gateway.vercel.sh/v4/ai", model: "openai/gpt", catalogRouteVersion: 1 },
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

  it("round-trips native model routes and all provider credentials without flattening routing metadata", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const modelProvider = {
      npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1", shape: "responses",
      body: { reasoning: { effort: "high" }, flags: [true, null, 2] }, headers: { "x-route": "keep value " },
    };
    const profile = {
      providerId: "bedrock", sdk: "@ai-sdk/amazon-bedrock/mantle" as const, baseURL: modelProvider.api, model: "model-id", modelProvider,
      providerSettings: { region: "us-east-1", accessKeyId: "access", secretAccessKey: "secret", sessionToken: "session" },
    };
    await saveModelConfig({ selectedProviderId: "bedrock", profiles: { bedrock: profile } }, storage);
    await expect(loadModelConfig(undefined, storage)).resolves.toEqual({ selectedProviderId: "bedrock", profiles: { bedrock: { ...profile, imageInput: "auto" } } });
  });

  it("keeps unsupported persisted SDKs and model shapes as explicit configuration errors", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    storage.value = { selectedProviderId: "provider", profiles: { provider: {
      sdk: "unavailable-sdk", baseURL: "https://provider.test/v1", model: "model", providerSettings: { apiKey: "key" },
    } } };
    const restored = await loadModelConfig(undefined, storage);
    expect(restored.profiles.provider?.modelProvider?.npm).toBe("unavailable-sdk");
    expect(isCompleteModelConfig(restored.profiles.provider)).toBe(false);
    storage.value = { selectedProviderId: "provider", profiles: { provider: {
      sdk: "@ai-sdk/openai", baseURL: "https://provider.test/v1", model: "model", providerSettings: { apiKey: "key" }, modelProvider: { shape: "future-shape" },
    } } };
    const unknownShape = await loadModelConfig(undefined, storage);
    expect(unknownShape.profiles.provider?.modelProvider?.shape).toBe("future-shape");
    expect(isCompleteModelConfig(unknownShape.profiles.provider)).toBe(false);
  });

  it("migrates an existing selected profile to its model route before dispatch, then reuses the persisted route", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const providerSettings = { region: "eu-west-1", apiKey: " saved-key ", accessKeyId: "access", secretAccessKey: "secret" };
    storage.value = { selectedProviderId: "bedrock", profiles: { bedrock: {
      sdk: "@ai-sdk/amazon-bedrock", baseURL: "https://user-endpoint.test", model: "alias", providerSettings,
    } } };
    const provider = { npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://mantle.test/v1", shape: "responses" };
    const loadCatalog = vi.fn(async () => ({ bedrock: { npm: "@ai-sdk/amazon-bedrock", models: { key: { id: "alias", provider } } } }));
    const migrated = await loadModelConfig(undefined, storage, { loadCatalog });
    expect(migrated.profiles.bedrock).toMatchObject({ sdk: "@ai-sdk/amazon-bedrock/mantle", baseURL: "https://mantle.test/v1", modelProvider: provider, providerSettings, catalogRouteVersion: 1 });
    await expect(loadModelConfig(undefined, storage, { loadCatalog })).resolves.toEqual(migrated);
    expect(loadCatalog).toHaveBeenCalledOnce();
  });

  it("preserves existing endpoints and credentials when migrating models without overrides", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    storage.value = { selectedProviderId: "openai", profiles: { openai: {
      sdk: "@ai-sdk/openai", baseURL: "https://user-proxy.test/v1", model: "custom-model", providerSettings: { apiKey: "key", customSetting: "value" },
    } } };
    const loadCatalog = vi.fn(async () => ({ openai: { npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", models: {} } }));
    const migrated = await loadModelConfig(undefined, storage, { loadCatalog });
    expect(migrated.profiles.openai).toMatchObject({ sdk: "@ai-sdk/openai", baseURL: "https://user-proxy.test/v1", providerSettings: { apiKey: "key", customSetting: "value" }, catalogRouteVersion: 1 });
    expect(migrated.profiles.openai?.modelProvider).toBeUndefined();
  });

  it("does not dispatch or mark legacy catalog routing as migrated when the catalog is unavailable", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const original = { selectedProviderId: "vertex", profiles: { vertex: { sdk: "@ai-sdk/google-vertex", baseURL: "", model: "claude" } } };
    storage.value = original;
    await expect(loadModelConfig(undefined, storage, { loadCatalog: async () => { throw new Error("offline"); } })).rejects.toThrow("模型路由目录更新失败");
    expect(storage.value).toBe(original);
    await expect(loadModelConfig(undefined, storage, { loadCatalog: async () => ({}) })).rejects.toThrow("模型目录中找不到 Provider");
    expect(storage.value).toBe(original);
  });

  it("restores every profile and the system prompt for the repair UI without requiring catalog access", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const profiles = {
      vertex: { providerId: "vertex", sdk: "@ai-sdk/google-vertex", baseURL: "", model: "claude", providerSettings: { project: "project", serviceAccountJson: "saved credentials" } },
      openai: { providerId: "openai", sdk: "@ai-sdk/openai", baseURL: "https://proxy.test/v1", model: "gpt", providerSettings: { apiKey: "saved key" } },
    };
    const original = { selectedProviderId: "vertex", profiles, systemPrompt: "Preserve this prompt" };
    storage.value = original;
    const loadCatalog = vi.fn(async () => { throw new Error("offline"); });
    const restored = await loadModelConfig(undefined, storage, { migrateCatalogRouting: false, loadCatalog });
    expect(restored).toMatchObject(original);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(storage.value).toBe(original);
    await saveModelConfig(restored, storage);
    expect(storage.value).toMatchObject(original);
  });
});
