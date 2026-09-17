import { describe, expect, it, vi } from "vitest";
import { endpointEfforts, ReasoningSettings } from "./reasoning";

const config = { baseURL: "https://provider.test/v1", model: "test-model", apiKey: "secret" };

function storage() {
  let saved: Record<string, unknown> = {};
  return {
    async get(key: string) { return { [key]: saved[key] }; },
    async set(items: Record<string, unknown>) { saved = { ...saved, ...items }; },
  };
}

describe("reasoning settings", () => {
  it("reads exact endpoint options ahead of Models.dev, including none", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "other", reasoning: { supported_efforts: ["high"] } },
      { id: "test-model", reasoning: { supported_efforts: ["high", "none", "low"] } },
    ] })));
    const settings = new ReasoningSettings(config, {
      fetch,
      modelLimit: async () => ({ provider: "provider", model: "test-model", context: 1000, source: "models.dev", reasoningEfforts: ["medium"] }),
    });
    await settings.ready;
    expect(settings.snapshot()).toMatchObject({ selected: "none", choices: ["none", "low", "high"], source: "endpoint" });
    expect(endpointEfforts({ data: [{ id: "different", reasoning: { supported_efforts: ["high"] } }] }, "test-model")).toBeUndefined();
    expect(endpointEfforts({ data: [{ id: "test-model", reasoning: { supported_efforts: null, mandatory: true } }] }, "test-model"))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("uses provider catalog options and restores a manual choice", async () => {
    const local = storage();
    const options = {
      storage: local,
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
      modelLimit: async () => ({ provider: "provider", model: "test-model", context: 1000, source: "models.dev" as const, reasoningEfforts: ["low", "high"] }),
    };
    const first = new ReasoningSettings(config, options);
    await first.ready;
    expect(first.snapshot()).toMatchObject({ selected: "low", source: "models.dev" });
    first.select("high");
    await vi.waitFor(async () => expect((await local.get("side-agent:reasoning-selections"))["side-agent:reasoning-selections"]).toBeTruthy());
    const restored = new ReasoningSettings(config, options);
    await restored.ready;
    expect(restored.snapshot().selected).toBe("high");
    expect(restored.reject("high", ["low"])).toBe("low");
    expect(restored.snapshot().selected).toBe("low");
    await vi.waitFor(async () => expect(((await local.get("side-agent:reasoning-selections"))["side-agent:reasoning-selections"] as Record<string, any>)["https://provider.test/v1\u0000test-model"].rejected).toContain("high"));
    const learned = new ReasoningSettings(config, options);
    await learned.ready;
    expect(learned.snapshot()).toMatchObject({ selected: "low", choices: ["low"] });
  });

  it("marks absent metadata as unknown and uses tentative lowest effort", async () => {
    const settings = new ReasoningSettings(config, {
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
      modelLimit: async () => undefined,
    });
    await settings.ready;
    expect(settings.snapshot()).toMatchObject({ selected: "none", source: "unknown" });
    expect(settings.reject("none")).toBe("minimal");
    expect(settings.reject("minimal", undefined, true)).toBeNull();
    expect(settings.snapshot()).toMatchObject({ selected: null, choices: [] });
  });
});
