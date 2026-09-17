import { describe, expect, it } from "vitest";
import {
  MODEL_CONFIG_STORAGE_KEY,
  isCompleteModelConfig,
  loadModelConfig,
  saveModelConfig,
  type StorageAreaLike,
} from "./config";

function memoryStorage(): StorageAreaLike & { value?: unknown } {
  const storage: StorageAreaLike & { value?: unknown } = {
    value: undefined,
    async get() {
      return { [MODEL_CONFIG_STORAGE_KEY]: storage.value };
    },
    async set(items) {
      storage.value = (items as Record<string, unknown>)[MODEL_CONFIG_STORAGE_KEY];
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
    const storage = memoryStorage();
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
    const storage = memoryStorage();
    const config = { baseURL: "https://provider.test/v1", model: "test", apiKey: "key", contextWindowOverride: 8192 };
    await saveModelConfig(config, storage);
    await expect(loadModelConfig(config, storage)).resolves.toEqual(config);
  });
});
