import { afterEach, expect, it, vi } from "vitest";
import { loadModelConfig, saveModelConfig, MODEL_CONFIG_STORAGE_KEY, ModelConfigConflictError } from "./config";

afterEach(() => vi.unstubAllGlobals());

it("rejects a stale settings draft without replacing another page's saved credentials", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, operation: () => Promise<void>) => {
    const next = tail.then(operation); tail = next.catch(() => {}); return next;
  } } });
  let value: unknown = { selectedProviderId: "custom", profiles: { custom: { providerId: "custom", sdk: "@ai-sdk/openai-compatible", providerSettings: { apiKey: "secret" }, baseURL: "https://example.test", model: "original", imageInput: "auto" } } };
  const storage = { get: async () => ({ [MODEL_CONFIG_STORAGE_KEY]: structuredClone(value) }), set: async (data: Record<string, unknown>) => { value = structuredClone(data[MODEL_CONFIG_STORAGE_KEY]); } } as unknown as chrome.storage.StorageArea;
  let aBaseline: unknown, bBaseline: unknown;
  const a = await loadModelConfig(undefined, storage, { migrateCatalogRouting: false, onBaseline: v => { aBaseline = v; } });
  const b = await loadModelConfig(undefined, storage, { migrateCatalogRouting: false, onBaseline: v => { bBaseline = v; } });
  a.profiles.custom.model = "updated";
  b.systemPrompt = "draft";
  await saveModelConfig(a, storage, { value: aBaseline });
  await expect(saveModelConfig(b, storage, { value: bBaseline })).rejects.toBeInstanceOf(ModelConfigConflictError);
  const result = await loadModelConfig(undefined, storage, { migrateCatalogRouting: false });
  expect(result.profiles.custom.model).toBe("updated");
  expect(result.profiles.custom.providerSettings.apiKey).toBe("secret");
  expect(result.systemPrompt).toBeUndefined();
  expect(b.systemPrompt).toBe("draft");
});

it("compares raw storage values independently of object key order", async () => {
  vi.stubGlobal("navigator", { locks: { request: (_name: string, operation: () => Promise<void>) => operation() } });
  const original = { selectedProviderId: "custom", profiles: {}, unknown: { first: 1, second: ["a", "b"] } };
  let value: unknown = { unknown: { second: ["a", "b"], first: 1 }, profiles: {}, selectedProviderId: "custom" };
  const storage = { get: async () => ({ [MODEL_CONFIG_STORAGE_KEY]: structuredClone(value) }), set: async (data: Record<string, unknown>) => { value = structuredClone(data[MODEL_CONFIG_STORAGE_KEY]); } } as unknown as chrome.storage.StorageArea;
  const config = await loadModelConfig(undefined, storage, { migrateCatalogRouting: false });
  await saveModelConfig(config, storage, { value: original });
  value = { ...original, unknown: { first: 2, second: ["a", "b"] } };
  await expect(saveModelConfig(config, storage, { value: original })).rejects.toBeInstanceOf(ModelConfigConflictError);
  value = { ...original, unknown: { first: 1, second: ["b", "a"] } };
  await expect(saveModelConfig(config, storage, { value: original })).rejects.toBeInstanceOf(ModelConfigConflictError);
});
