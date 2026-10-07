import { describe, expect, it, vi } from "vitest";
import { applyModelPreset, contextUsedPercent, inputBudget, loadModelCatalog, matchModel, modelPresetFields, modelProviderPresets, modelSupportsImages, normalizeModelProviderOverride, resolveModelLimit } from "./model-limits";
import { modelConfigErrors, sdkFor } from "./model-sdks";

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
  it("lists every known SDK provider and only tool-capable text models", () => {
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
    expect(providers.map(({ id }) => id)).toEqual(["compatible", "native", "template", "vercel"]);
    expect(providers[0]?.models).toEqual([{ id: "agent", name: "Agent" }]);
    expect(providers[2]?.fields.map(({ key }) => key)).toEqual(["apiKey", "ACCOUNT"]);
    expect(providers[3]).toMatchObject({ sdk: "@ai-sdk/gateway", baseURL: "https://ai-gateway.vercel.sh/v4/ai" });
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

  it("refreshes a fresh catalog and invalidates the cached model limit", async () => {
    const values: Record<string, unknown> = {};
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    const config = { baseURL: "https://api.openai.com/v1", model: "gpt-5" };
    const original = vi.fn(async () => new Response(JSON.stringify(catalog)));
    await expect(resolveModelLimit(config, { storage, fetch: original, now: () => 100 })).resolves.toMatchObject({ context: 400_000 });
    expect(values["side-agent:model-limit"]).toBeTruthy();

    const updated = vi.fn(async () => new Response(JSON.stringify({
      openai: { ...catalog.openai, models: { "gpt-5": { limit: { context: 500_000 } } } },
    })));
    await expect(loadModelCatalog({ storage, fetch: updated, now: () => 101, refresh: true }))
      .resolves.toHaveProperty("openai.models.gpt-5.limit.context", 500_000);
    expect(updated).toHaveBeenCalledWith("https://models.dev/api.json", expect.objectContaining({ cache: "no-cache" }));
    expect(values["side-agent:model-limit"]).toBeNull();
    await expect(resolveModelLimit(config, { storage, fetch: original, now: () => 102 })).resolves.toMatchObject({ context: 500_000 });
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("reports a stale fallback and still rejects an aborted refresh", async () => {
    const values: Record<string, unknown> = { "side-agent:model-catalog": { version: 2, fetchedAt: 100, catalog } };
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    const offline = vi.fn(async () => { throw new Error("offline"); });
    const onStale = vi.fn();
    await expect(loadModelCatalog({ storage, fetch: offline, now: () => 101, refresh: true, onStale }))
      .resolves.toEqual(catalog);
    expect(onStale).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    await expect(loadModelCatalog({ storage, fetch: offline, refresh: true, signal: controller.signal, onStale }))
      .rejects.toThrow("offline");
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("uses only exact provider/model matches and honors input limits", () => {
    expect(matchModel(catalog, "https://openrouter.ai/api/v1", "gpt-5")).toMatchObject({ provider: "openrouter", context: 100_000 });
    expect(matchModel(catalog, "https://api.openai.com/v1", "gpt-5-min")).toBeUndefined();
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

  it("detects image input only from exact catalog metadata or a manual override", async () => {
    const imageCatalog = { openai: { api: "https://api.openai.com/v1", models: { "gpt-5": { limit: { context: 1000 }, modalities: { input: ["text", "image"], output: ["text"] } } } } };
    const storage = { async get() { return {}; }, async set() {} };
    const fetch = vi.fn(async () => new Response(JSON.stringify(imageCatalog)));
    const config = { baseURL: "https://api.openai.com/v1", apiKey: "secret", model: "gpt-5" };
    await expect(modelSupportsImages(config, { storage, fetch })).resolves.toBe(true);
    await expect(modelSupportsImages({ ...config, imageInput: "disabled" }, { storage, fetch })).resolves.toBe(false);
    await expect(modelSupportsImages({ ...config, imageInput: "enabled" }, { storage, fetch })).resolves.toBe(true);
    expect(matchModel(imageCatalog, "https://proxy.test/v1", "gpt-5")?.inputModalities).toBeUndefined();
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

  it("keeps a manual window separate from a concurrent metadata lookup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(catalog))));
    try {
      const config = { baseURL: "https://api.openai.com/v1", model: "gpt-5", contextWindowOverride: 30_000 };
      const [, limit] = await Promise.all([modelSupportsImages(config), resolveModelLimit(config)]);
      expect(limit).toMatchObject({ context: 30_000, source: "manual" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses a conservative 256K estimate without inventing capabilities", async () => {
    const storage = { async get() { return {}; }, async set() {} };
    const estimated = await resolveModelLimit({ baseURL: "https://unknown.test/v1", model: "unknown" }, {
      storage, fetch: vi.fn(async () => new Response(JSON.stringify(catalog))),
    });
    expect(estimated).toMatchObject({ context: 262_144, source: "estimated" });
    expect(estimated).not.toHaveProperty("inputModalities");
    expect(estimated).not.toHaveProperty("reasoningEfforts");
  });

  it("preserves complete per-model routing metadata through catalog normalization and caching", async () => {
    const provider = {
      npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1", shape: "responses",
      body: { nested: { enabled: true, stop: ["END"], limit: 2, nullable: null } }, headers: { "x-model-route": "mantle" },
    };
    const storage = { async get() { return {}; }, set: vi.fn(async () => {}) };
    const result = await loadModelCatalog({ storage, fetch: vi.fn(async () => new Response(JSON.stringify({
      bedrock: { npm: "@ai-sdk/amazon-bedrock", models: { example: { tool_call: true, provider } } },
    }))) });
    expect(result.bedrock?.models?.example?.provider).toEqual(provider);
    expect(storage.set).toHaveBeenCalledWith(expect.objectContaining({ "side-agent:model-catalog": expect.objectContaining({ version: 2, catalog: result }) }));
    expect(modelProviderPresets(result)[0]?.models).toEqual([{ id: "example", name: "example" }]);
  });

  it("uses model overrides ahead of provider defaults and keeps credentials while changing native SDK fields", () => {
    const [preset] = modelProviderPresets({ vertex: { npm: "@ai-sdk/google-vertex", models: {
      claude: { id: "claude-alias", tool_call: true, provider: { npm: "@ai-sdk/google-vertex/anthropic", api: "https://claude.test/v1", headers: { "x-route": "claude" } } },
      gemini: { tool_call: true },
    } } });
    const settings = { project: "project", location: "us-east5", serviceAccountJson: '{"client_email":"a","private_key":"b"}', apiKey: "saved" };
    const config = applyModelPreset({ providerId: "vertex", sdk: "@ai-sdk/google-vertex" as const, baseURL: "", model: "claude-alias", providerSettings: settings }, preset!);
    expect(config).toMatchObject({ sdk: "@ai-sdk/google-vertex/anthropic", baseURL: "https://claude.test/v1", modelProvider: { headers: { "x-route": "claude" } } });
    expect(config.providerSettings).toBe(settings);
    expect(modelPresetFields(config, preset).find(({ key }) => key === "serviceAccountJson")?.required).toBe(true);
    const gemini = applyModelPreset({ ...config, model: "gemini" }, preset!);
    expect(gemini.sdk).toBe("@ai-sdk/google-vertex");
    expect(gemini.modelProvider).toBeUndefined();
    expect(gemini.providerSettings).toBe(settings);
    expect(modelPresetFields(gemini, preset).find(({ key }) => key === "serviceAccountJson")?.required).not.toBe(true);
  });

  it("keeps supported model SDK overrides even when a provider default is unavailable", () => {
    const [preset] = modelProviderPresets({ mixed: { npm: "unsupported-provider", api: "https://mixed.test/v1", models: {
      available: { tool_call: true, provider: { npm: "@ai-sdk/openai" } },
      unavailable: { tool_call: true },
    } } });
    expect(preset?.models).toEqual([{ id: "available", name: "available" }]);
    const config = { providerId: "mixed", baseURL: "", model: "available", providerSettings: { apiKey: "key" } };
    expect(sdkFor(applyModelPreset(config, preset!))).toBe("@ai-sdk/openai");
    expect(modelConfigErrors(applyModelPreset({ ...config, model: "unavailable" }, preset!)).sdk).toContain("unsupported-provider");
    expect(modelConfigErrors(applyModelPreset({ ...config, model: "free-text" }, preset!)).sdk).toContain("unsupported-provider");
  });

  it("does not silently fall back for unsupported overrides on typed or restored models", () => {
    const [preset] = modelProviderPresets({ openai: { npm: "@ai-sdk/openai", models: {
      supported: { tool_call: true },
      unsupported: { tool_call: true, provider: { npm: "unsupported-sdk", shape: "future-shape" } },
    } } });
    expect(preset?.models).toEqual([{ id: "supported", name: "supported" }]);
    const config = applyModelPreset({ providerId: "openai", baseURL: "", model: "unsupported" }, preset!);
    expect(config.modelProvider).toEqual({ npm: "unsupported-sdk", shape: "future-shape" });
    expect(modelConfigErrors(config).sdk).toContain("unsupported-sdk");
    const removed = applyModelPreset({ ...config, model: "removed-from-catalog" }, preset!);
    expect(removed.modelProvider).toEqual(config.modelProvider);
    expect(normalizeModelProviderOverride({ shape: "future-shape" })).toEqual({ shape: "future-shape" });
    expect(() => normalizeModelProviderOverride({ npm: 42 })).toThrow("Invalid model provider npm");
    expect(() => normalizeModelProviderOverride({ headers: { invalid: 42 } })).toThrow("Invalid model provider headers");
  });

  it("refreshes pre-routing catalog caches rather than reusing a normalized catalog that lost overrides", async () => {
    const storage = { async get() { return { "side-agent:model-catalog": { fetchedAt: 100, catalog } }; }, async set() {} };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ refreshed: { npm: "@ai-sdk/openai" } })));
    await expect(loadModelCatalog({ storage, fetch, now: () => 101 })).resolves.toHaveProperty("refreshed");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(loadModelCatalog({ storage, fetch: vi.fn(async () => { throw new Error("offline"); }), now: () => 101 })).rejects.toThrow("offline");
  });

  it("matches model limits at the model-specific endpoint", () => {
    const modelCatalog = { provider: { api: "https://default.test/v1", models: {
      routed: { provider: { api: "https://model.test/v1" }, limit: { context: 42_000 } },
    } } };
    expect(matchModel(modelCatalog, "https://model.test/v1", "routed")?.context).toBe(42_000);
    expect(matchModel(modelCatalog, "https://default.test/v1", "routed")).toBeUndefined();
  });

  it("preserves a saved proxy endpoint but resets an old model endpoint and SDK when switching routes", () => {
    const [preset] = modelProviderPresets({ provider: { npm: "@ai-sdk/openai", api: "https://catalog.test/v1", models: {
      ordinary: { tool_call: true },
      special: { tool_call: true, provider: { npm: "@ai-sdk/anthropic", api: "https://special.test/v1" } },
    } } });
    const profile = { sdk: "@ai-sdk/openai" as const, providerId: "provider", model: "ordinary", baseURL: "https://user-proxy.test/v1", providerSettings: { apiKey: "key" } };
    expect(applyModelPreset(profile, preset!).baseURL).toBe(profile.baseURL);
    const special = applyModelPreset({ ...profile, model: "special" }, preset!);
    expect(special.sdk).toBe("@ai-sdk/anthropic");
    expect(special.baseURL).toBe("https://special.test/v1");
    const ordinary = applyModelPreset({ ...special, model: "ordinary" }, preset!);
    expect(ordinary.sdk).toBe("@ai-sdk/openai");
    expect(ordinary.baseURL).toBe("https://catalog.test/v1");
    expect(ordinary.modelProvider).toBeUndefined();
    expect(ordinary.providerSettings).toEqual(profile.providerSettings);
  });
});
