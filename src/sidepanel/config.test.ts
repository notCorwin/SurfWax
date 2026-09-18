import { describe, expect, it } from "vitest";
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
    const config = {
      baseURL: " https://provider.test/v1 ",
      model: " model-id ",
      apiKey: "secret-key",
    };

    await saveModelConfig(config, storage);
    await expect(loadModelConfig({ baseURL: "fallback", model: "fallback", apiKey: "fallback" }, storage))
      .resolves.toEqual({ baseURL: "https://provider.test/v1", model: "model-id", apiKey: "secret-key" });
  });

  it("persists an optional manual context window", async () => {
    const storage = memoryStorage(MODEL_CONFIG_STORAGE_KEY);
    const config = { baseURL: "https://provider.test/v1", model: "test", apiKey: "key", contextWindowOverride: 8192 };
    await saveModelConfig(config, storage);
    await expect(loadModelConfig(config, storage)).resolves.toEqual(config);
  });
});

describe("Jev config persistence", () => {
  it("uses the default endpoint and disables Jev when the API key is empty", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    await expect(loadJevConfig(DEFAULT_JEV_CONFIG, storage)).resolves.toEqual(DEFAULT_JEV_CONFIG);
    expect(isCompleteJevConfig(DEFAULT_JEV_CONFIG)).toBe(false);
    expect(isCompleteJevConfig({ ...DEFAULT_JEV_CONFIG, apiKey: " key " })).toBe(true);
  });

  it("saves and loads Jev independently", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    const config = { baseURL: " https://jev.example/v1/ ", model: " jev-test ", apiKey: "jev-secret", threshold: 0.81 };

    await saveJevConfig(config, storage);
    await expect(loadJevConfig(DEFAULT_JEV_CONFIG, storage)).resolves.toEqual({
      baseURL: "https://jev.example/v1/",
      model: "jev-test",
      apiKey: "jev-secret",
      threshold: 0.81,
    });
    await saveJevConfig({ ...config, apiKey: "" }, storage);
    expect(isCompleteJevConfig(await loadJevConfig(DEFAULT_JEV_CONFIG, storage))).toBe(false);
  });

  it("adds the default threshold to an older stored config", async () => {
    const storage = memoryStorage(JEV_CONFIG_STORAGE_KEY);
    storage.value = { baseURL: "https://api.typesafe.ai", model: "jev-latest", apiKey: "old-key" };
    expect((await loadJevConfig(DEFAULT_JEV_CONFIG, storage)).threshold).toBe(0.5);
  });
});
