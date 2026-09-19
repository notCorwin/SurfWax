import { describe, expect, it, vi } from "vitest";
import { contextUsedPercent, inputBudget, matchModel, resolveModelLimit } from "./model-limits";

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
    expect(matchModel(models, "https://api.openai.com/v1", "gpt-5-x")?.reasoningEfforts).toBeUndefined();
  });

  it("lets a manual window win and reuses cached data while offline", async () => {
    let cache: unknown;
    const storage = {
      async get() { return { "side-agent:model-limit": cache }; },
      async set(items: Record<string, unknown>) { cache = items["side-agent:model-limit"]; },
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
