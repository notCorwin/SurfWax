import { describe, expect, it, vi } from "vitest";
import { contextUsedPercent, inputBudget, loadModelCatalog, matchModel, modelProviderPresets, resolveModelLimit } from "./model-limits";

const catalog = {
  openai: { api: "https://api.openai.com/v1", models: {
    "gpt-5": { limit: { context: 400_000, input: 272_000, output: 128_000 } },
    "gpt-5-mini": { limit: { context: 128_000, output: 16_000 } },
  } },
  openrouter: { api: "https://openrouter.ai/api/v1", models: {
    "gpt-5": { limit: { context: 100_000, output: 8_000 } },
  } },
};

describe("models.dev limit matching", () => {
  it("lists only directly usable compatible providers and tool-capable text models", () => {
    const providers = modelProviderPresets({
      vercel: { name: "Vercel AI Gateway", npm: "@ai-sdk/gateway", models: { "openai/gpt": { tool_call: true, modalities: { output: ["text"] } } } },
      compatible: { name: "Compatible", npm: "@ai-sdk/openai-compatible", api: "https://provider.test/v1", models: {
        agent: { name: "Agent", tool_call: true, modalities: { output: ["text"] } },
        image: { name: "Image", tool_call: true, modalities: { output: ["image"] } },
        chat: { name: "Chat", tool_call: false, modalities: { output: ["text"] } },
      } },
      template: { npm: "@ai-sdk/openai-compatible", api: "https://${ACCOUNT}.test/v1", models: {} },
      native: { npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", models: {} },
    });
    expect(providers.map(({ id }) => id)).toEqual(["compatible", "vercel"]);
    expect(providers[0]?.models).toEqual([{ id: "agent", name: "Agent" }]);
    expect(providers[1]).toMatchObject({ transport: "gateway", baseURL: "https://ai-gateway.vercel.sh/v4/ai" });
  });

  it("caches the normalized catalog for a day and falls back to stale data offline", async () => {
    const values: Record<string, unknown> = {};
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(catalog)));
    await expect(loadModelCatalog({ storage, fetch, now: () => 100 })).resolves.toHaveProperty("openai.models.gpt-5");
    await expect(loadModelCatalog({ storage, fetch, now: () => 101 })).resolves.toHaveProperty("openrouter");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(loadModelCatalog({ storage, fetch: vi.fn(async () => { throw new Error("offline"); }), now: () => 86_400_101 }))
      .resolves.toHaveProperty("openai");
  });

  it("uses exact provider matches before fuzzy names and honors input limits", () => {
    expect(matchModel(catalog, "https://openrouter.ai/api/v1", "gpt-5")).toMatchObject({ provider: "openrouter", context: 100_000 });
    expect(matchModel(catalog, "https://api.openai.com/v1", "gpt-5-min")?.model).toBe("gpt-5-mini");
    expect(inputBudget(matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(272_000);
    expect(contextUsedPercent(136_000, matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(50);
    expect(contextUsedPercent(999_999, matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(100);
  });

  it("uses effort metadata only from an exact endpoint and model", () => {
    const models = {
      openai: { api: "https://api.openai.com/v1", models: { "gpt-5": { limit: { context: 1000 }, reasoning_options: [{ type: "effort", values: ["none", "low"] }] } } },
    };
    expect(matchModel(models, "https://api.openai.com/v1", "gpt-5")?.reasoningEfforts).toEqual(["none", "low"]);
    expect(matchModel(models, "https://proxy.test/v1", "gpt-5")?.reasoningEfforts).toBeUndefined();
    expect(matchModel(models, "https://proxy.test/v1", "gpt-5", "openai")?.reasoningEfforts).toEqual(["none", "low"]);
    expect(matchModel(models, "https://api.openai.com/v1", "gpt-5-x")?.reasoningEfforts).toBeUndefined();
  });

  it("lets a manual window win and reuses cached data while offline", async () => {
    const values: Record<string, unknown> = {};
    const storage = {
      async get(key: string) { return { [key]: values[key] }; },
      async set(items: Record<string, unknown>) { Object.assign(values, items); },
    };
    const config = { baseURL: "https://api.openai.com/v1", apiKey: "secret", model: "gpt-5" };
    const fetch = vi.fn(async () => new Response(JSON.stringify(catalog)));
    await expect(resolveModelLimit(config, { storage, fetch, now: () => 100 })).resolves.toMatchObject({ context: 400_000 });
    await expect(resolveModelLimit(config, { storage, fetch: vi.fn(async () => { throw new Error("offline"); }), now: () => 100 + 86_400_001 }))
      .resolves.toMatchObject({ context: 400_000 });
    await expect(resolveModelLimit({ ...config, contextWindowOverride: 42_000 }, { storage, fetch, now: () => 101 }))
      .resolves.toMatchObject({ context: 42_000, source: "manual" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
