import { describe, expect, it, vi } from "vitest";
import { applyModelPreset, contextUsedPercent, inputBudget, loadModelCatalog, matchModel, modelPresetFields, modelProviderPresets, modelSupportsImages, normalizeModelProviderOverride, resolveModelLimit } from "./model-limits";
import { modelConfigErrors, sdkFor } from "./model-sdks";
import { metadata as bundledMetadata } from "../data/models-dev-api";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { modelDiagnosticContext } from "./diagnostics";

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

  it("falls back to the release-pinned catalog on a first offline launch", async () => {
    const storage = { async get() { return {}; }, async set() {} };
    const onStale = vi.fn();
    const result = await loadModelCatalog({ storage, fetch: vi.fn(async () => { throw new Error("offline"); }), bundledFallback: true, onStale });
    expect(Object.keys(result).length).toBeGreaterThan(100);
    expect(result.openai?.models && Object.keys(result.openai.models).length).toBeGreaterThan(0);
    expect(onStale).toHaveBeenCalledOnce();
    expect(Object.keys(result)).toHaveLength(bundledMetadata.providers);
    expect(Object.values(result).reduce((count, provider) => count + Object.keys(provider.models ?? {}).length, 0)).toBe(bundledMetadata.models);
    expect(bundledMetadata).toMatchObject({ source: "https://models.dev/api.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("honors an explicit refresh before falling back on a fresh installation", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetch = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetch);
    try {
      let settled = false;
      const result = loadModelCatalog({ storage: { async get() { return {}; }, async set() {} }, refresh: true }).finally(() => { settled = true; });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      resolve(Response.json({}));
      await expect(result).resolves.toHaveProperty("openai");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects an already-cancelled bundled fallback", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(loadModelCatalog({ storage: { async get() { return {}; }, async set() {} }, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an incomplete successful response and uses the bundled catalog", async () => {
    const onStale = vi.fn();
    const result = await loadModelCatalog({ storage: { async get() { return {}; }, async set() {} },
      fetch: vi.fn(async () => Response.json({})), validateCompleteness: true, bundledFallback: true, onStale });
    expect(Object.keys(result)).toHaveLength(bundledMetadata.providers);
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("rejects a truncated response that clears the old absolute thresholds", async () => {
    const truncated = Object.fromEntries(Array.from({ length: 100 }, (_, providerIndex) => {
      const id = providerIndex === 0 ? "openai" : `provider-${providerIndex}`;
      return [id, { npm: "@ai-sdk/openai-compatible", models: Object.fromEntries(
        Array.from({ length: 10 }, (_, modelIndex) => [`model-${modelIndex}`, { tool_call: true }]),
      ) }];
    }));
    const result = await loadModelCatalog({ storage: { async get() { return {}; }, async set() {} },
      fetch: vi.fn(async () => Response.json(truncated)), validateCompleteness: true, bundledFallback: true });
    expect(Object.keys(result)).toHaveLength(bundledMetadata.providers);
  });

  it("refreshes a fresh catalog and invalidates the cached model limit", async () => {
    const values: Record<string, unknown> = {};
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    const config = { baseURL: "https://api.openai.com/v1", model: "gpt-5" };
    const now = Date.parse(bundledMetadata.fetchedAt) + 1;
    const original = vi.fn(async () => new Response(JSON.stringify(catalog)));
    await expect(resolveModelLimit(config, { storage, fetch: original, now: () => now })).resolves.toMatchObject({ context: 400_000 });

    const updated = vi.fn(async () => new Response(JSON.stringify({
      openai: { ...catalog.openai, models: { "gpt-5": { limit: { context: 500_000 } } } },
    })));
    await expect(loadModelCatalog({ storage, fetch: updated, now: () => now + 1, refresh: true }))
      .resolves.toHaveProperty("openai.models.gpt-5.limit.context", 500_000);
    expect(updated).toHaveBeenCalledWith("https://models.dev/api.json", expect.objectContaining({ cache: "no-cache" }));
    await expect(resolveModelLimit(config, { storage, fetch: original, now: () => now + 2 })).resolves.toMatchObject({ context: 500_000 });
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
      .rejects.toMatchObject({ name: "AbortError" });
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("prefers the release snapshot over an older valid cache while offline", async () => {
    const snapshot = await loadModelCatalog({ storage: { async get() { return {}; }, async set() {} },
      fetch: vi.fn(async () => { throw new Error("offline"); }), bundledFallback: true });
    const staleCatalog = { ...snapshot };
    const values: Record<string, unknown> = { "side-agent:model-catalog": { version: 2, fetchedAt: 1, catalog: staleCatalog } };
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    try {
      const result = await loadModelCatalog({ storage });
      expect(result).toBe(snapshot);
      expect(result).not.toBe(staleCatalog);
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not return a fresh limit backed by a catalog older than the release snapshot", async () => {
    const snapshot = await loadModelCatalog({ storage: { async get() { return {}; }, async set() {} },
      fetch: vi.fn(async () => { throw new Error("offline"); }), bundledFallback: true });
    const modelEntry = Object.entries(snapshot).flatMap(([providerId, provider]) => Object.entries(provider.models ?? {})
      .filter(([, model]) => Boolean(model.limit?.context)).map(([modelId, model]) => ({ providerId, provider, modelId, model })))[0]!;
    const config = { providerId: modelEntry.providerId, baseURL: modelEntry.model.provider?.api ?? modelEntry.provider.api ?? "", model: modelEntry.model.id ?? modelEntry.modelId };
    const key = `${sdkFor(config)}\u0000${config.providerId}\u0000${config.baseURL}\u0000${config.model}\u0000`;
    const staleRevision = "previous-release";
    const values: Record<string, unknown> = {
      "side-agent:model-catalog": { version: 2, fetchedAt: 1, revision: staleRevision, catalog: snapshot },
      "side-agent:model-limit": { key, fetchedAt: 100, catalogRevision: staleRevision,
        match: { provider: modelEntry.providerId, model: config.model, context: 1, source: "models.dev" } },
    };
    const storage = { async get(storageKey: string) { return { [storageKey]: values[storageKey] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    try {
      await expect(resolveModelLimit(config, { storage, now: () => 101 })).resolves.toMatchObject({ context: modelEntry.model.limit!.context });
    } finally { vi.unstubAllGlobals(); }
  });

  it("reuses results for different models and invalidates them on catalog revision", async () => {
    const values: Record<string, unknown> = {};
    const storage = { async get(key: string) { return { [key]: values[key] }; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } };
    const now = Date.parse(bundledMetadata.fetchedAt) + 1;
    const fetch = vi.fn(async () => Response.json(catalog));
    const first = { providerId: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-5" };
    const second = { ...first, model: "gpt-5-mini" };
    const firstMatch = await resolveModelLimit(first, { storage, fetch, now: () => now });
    const secondMatch = await resolveModelLimit(second, { storage, fetch, now: () => now });
    expect(firstMatch?.context).toBe(400_000);
    expect(secondMatch?.context).toBe(128_000);
    expect(await resolveModelLimit(first, { storage, fetch, now: () => now })).toBe(firstMatch);
    expect(await resolveModelLimit(second, { storage, fetch, now: () => now })).toBe(secondMatch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(values).not.toHaveProperty("side-agent:model-limit");

    await loadModelCatalog({ storage, now: () => now + 1, refresh: true, fetch: vi.fn(async () => Response.json({
      openai: { ...catalog.openai, models: { "gpt-5": { limit: { context: 500_000 } } } },
    })) });
    expect(await resolveModelLimit(first, { storage, fetch, now: () => now + 2 })).toMatchObject({ context: 500_000 });
  });

  it("uses only exact provider/model matches and honors input limits", () => {
    expect(matchModel(catalog, "https://openrouter.ai/api/v1", "gpt-5")).toMatchObject({ provider: "openrouter", context: 100_000 });
    expect(matchModel(catalog, "https://api.openai.com/v1", "gpt-5-min")).toBeUndefined();
    expect(inputBudget(matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(272_000);
    expect(contextUsedPercent(136_000, matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(50);
    expect(contextUsedPercent(999_999, matchModel(catalog, "https://api.openai.com/v1", "gpt-5")!)).toBe(100);
  });

  it("measures the input against the available context without reserving output tokens", () => {
    const contextOnly = { provider: "test", model: "test", context: 100_000, output: 80_000, source: "models.dev" as const };
    expect(inputBudget(contextOnly)).toBe(100_000);
    expect(contextUsedPercent(80_000, contextOnly)).toBe(80);
    expect(inputBudget({ ...contextOnly, input: 60_000 })).toBe(60_000);
    expect(contextUsedPercent(48_000, { ...contextOnly, input: 60_000 })).toBe(80);
    expect(inputBudget({ ...contextOnly, input: 120_000 })).toBe(100_000);
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
    const config = { baseURL: "https://api.openai.com/v1", providerSettings: { apiKey: "secret" }, model: "gpt-5" };
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
    const config = { baseURL: "https://api.openai.com/v1", providerSettings: { apiKey: "secret" }, model: "gpt-5" };
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
    expect(estimated).toMatchObject({ context: 256_000, source: "estimated" });
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
    expect(sdkFor(applyModelPreset({ ...config, model: "free-text" }, preset!))).toBe("@ai-sdk/openai");
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

describe("model catalog diagnostics", () => {
  it("links concurrent consumers to the same shared operation without duplicating its request", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: createMemoryEventStore(events) });
    logger.beginRun("one", "run-one"); logger.beginRun("two", "run-two");
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const config = { baseURL: "https://unknown.test/v1", model: "unique-concurrency-test" };
      const first = resolveModelLimit(config, { diagnosticContext: modelDiagnosticContext(logger, "one") });
      const second = resolveModelLimit(config, { diagnosticContext: modelDiagnosticContext(logger, "two") });
      const [firstLimit, secondLimit] = await Promise.all([first, second]);
      expect(secondLimit).toBe(firstLimit);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await logger.flush();
      const links = events.filter((event) => event.type === "model.metadata.linked" && (fromLogValue(event.content, event.valueEncoding) as any).operation === "catalog");
      expect(links.map((event) => [event.conversationId, event.runId])).toEqual([["one", "run-one"], ["two", "run-two"]]);
      expect(new Set(links.map((event) => (fromLogValue(event.content, event.valueEncoding) as any).operationId)).size).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("correlates cache read and fetch failures without exposing credentials while falling back", async () => {
    const diagnostics: import("./diagnostics").ModelDiagnostic[] = [];
    const limit = await resolveModelLimit({ baseURL: "https://provider.test/v1", model: "missing" }, {
      storage: { async get() { throw new Error("disk denied"); }, async set() {} },
      fetch: async () => { throw new Error("offline Bearer top-secret"); },
      onDiagnostic: (event) => diagnostics.push(event),
    });
    expect(limit).toMatchObject({ source: "estimated", context: 256_000 });
    expect(diagnostics.map((item) => item.phase)).toEqual(["cache-read", "fetch", "resolution"]);
    expect(new Set(diagnostics.map((item) => item.operationId)).size).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain("top-secret");
    expect(diagnostics[1]?.error.message).toContain("offline");
  });
  it("records storage write failure without changing the fetched catalog", async () => {
    const diagnostics: import("./diagnostics").ModelDiagnostic[] = [];
    const result = await loadModelCatalog({ storage: { async get() { return {}; }, async set() { throw new Error("quota exceeded"); } },
      fetch: async () => Response.json({ example: { id: "example", models: {} } }), onDiagnostic: (event) => diagnostics.push(event) });
    expect(result).toHaveProperty("example");
    expect(diagnostics).toMatchObject([{ phase: "cache-write", error: { message: "quota exceeded" } }]);
  });
});

it("shares catalog I/O across independently cancelled consumers", async () => {
  let complete!: (response: Response) => void;
  let requestSignal: AbortSignal | undefined;
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve) => { complete = resolve; });
  });
  const storage = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  const first = new AbortController(), second = new AbortController();
  const options = { fetch: fetch as typeof globalThis.fetch, storage, bundledFallback: false };
  const cancelled = loadModelCatalog({ ...options, signal: first.signal });
  const survivor = loadModelCatalog({ ...options, signal: second.signal });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  first.abort(new DOMException("consumer stopped", "AbortError"));
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(requestSignal?.aborted).toBe(false);
  complete(Response.json(catalog));
  await expect(survivor).resolves.toHaveProperty("openai.models.gpt-5");
  expect(storage.get).toHaveBeenCalledOnce();
  expect(storage.set).toHaveBeenCalledOnce();
});

it("aborts abandoned catalog I/O and permits a fresh attempt", async () => {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    const signal = init!.signal as AbortSignal;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const storage = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  const first = new AbortController();
  const options = { fetch: fetch as typeof globalThis.fetch, storage, bundledFallback: false };
  const pending = loadModelCatalog({ ...options, signal: first.signal });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  first.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(signals[0]?.aborted).toBe(true);
  fetch.mockImplementationOnce(async () => Response.json(catalog));
  await expect(loadModelCatalog(options)).resolves.toHaveProperty("openai");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(storage.set).toHaveBeenCalledOnce();
});

it("keeps bundled refresh consumers independent and prevents an abandoned response from overwriting fresh metadata", async () => {
  const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ signal: init!.signal as AbortSignal, resolve });
  })));
  const values: Record<string, unknown> = {};
  const storage = { get: vi.fn(async (key: string) => ({ [key]: values[key] })), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }) };
  const first = new AbortController(), second = new AbortController();
  const options = { storage, validateCompleteness: false };
  const [one, two] = await Promise.all([
    loadModelCatalog({ ...options, signal: first.signal }), loadModelCatalog({ ...options, signal: second.signal }),
  ]);
  expect(one).toBe(two);
  expect(requests).toHaveLength(1);
  first.abort();
  expect(requests[0]!.signal.aborted).toBe(false);
  second.abort();
  expect(requests[0]!.signal.aborted).toBe(true);
  const newer = loadModelCatalog({ ...options, refresh: true });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  requests[1]!.resolve(Response.json(catalog));
  await newer;
  expect(storage.set).toHaveBeenCalledOnce();
  requests[0]!.resolve(Response.json({ obsolete: { models: {} } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(storage.set).toHaveBeenCalledOnce();
  expect((values["side-agent:model-catalog"] as { catalog: unknown }).catalog).toEqual(catalog);
});
