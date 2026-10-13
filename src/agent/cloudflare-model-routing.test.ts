import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import { createModel } from "./model";
import { applyModelPreset, modelPresetFields, modelProviderPresets } from "./model-limits";
import { modelConfigErrors, resolvedBaseURL, sdkFor } from "./model-sdks";

// Models.dev's Cloudflare AI Gateway routes (2026-10-07): native overrides
// specify only npm, so the account endpoint and gateway remain provider-owned.
const preset = modelProviderPresets({ "cloudflare-ai-gateway": {
  npm: "ai-gateway-provider", models: {
    "deepseek/deepseek-v4-pro": { tool_call: true },
    "anthropic/claude-opus-4.5": { tool_call: true, provider: { npm: "@ai-sdk/anthropic" } },
    "openai/gpt-5.4": { tool_call: true, provider: { npm: "@ai-sdk/openai" } },
  },
} })[0]!;
const routes = [
  { model: "deepseek/deepseek-v4-pro", sdk: "ai-gateway-provider", path: "chat/completions", protocol: "chat" },
  { model: "anthropic/claude-opus-4.5", sdk: "@ai-sdk/anthropic", path: "messages", protocol: "anthropic" },
  { model: "openai/gpt-5.4", sdk: "@ai-sdk/openai", path: "responses", protocol: "responses" },
] as const;

function configFor(model: string): ModelConfig {
  return applyModelPreset({ providerId: preset.id, sdk: preset.sdk, baseURL: preset.baseURL, model, apiKey: "legacy-token",
    providerSettings: { apiKey: "saved-token", accountId: "saved-account", gatewayId: "saved-gateway" },
  }, preset);
}

function responseFor(protocol: typeof routes[number]["protocol"]): Response {
  if (protocol === "anthropic") return Response.json({ id: "response", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  if (protocol === "responses") return Response.json({ id: "response", created_at: 1, model: "test",
    output: [{ type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  return Response.json({ id: "response", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

describe.each(routes)("Cloudflare $protocol model route", ({ model: modelId, sdk, path, protocol }) => {
  it("retains the required account and gateway settings after model selection", () => {
    const config = configFor(modelId);
    expect(sdkFor(config)).toBe(sdk);
    expect(modelPresetFields(config, preset).map(({ key, required }) => ({ key, required }))).toEqual([
      { key: "apiKey", required: true }, { key: "accountId", required: true }, { key: "gatewayId", required: true },
    ]);
    expect(modelConfigErrors(config)).toEqual({});
    expect(resolvedBaseURL(config)).toBe("https://api.cloudflare.com/client/v4/accounts/saved-account/ai/v1");
  });

  it.each([undefined, { "cf-aig-gateway-id": "catalog-lower", "Cf-Aig-Gateway-Id": "catalog-mixed", "CF-AIG-GATEWAY-ID": "catalog-upper",
    Authorization: "catalog-bearer", "X-API-KEY": "catalog-key", "x-catalog": "retained" }])(
    "sends the saved gateway and token through the installed SDK despite catalog headers %j", async (headers) => {
      const config = configFor(modelId);
      config.modelProvider = { ...config.modelProvider, ...(headers ? { headers } : {}) };
      const requests: Request[] = [];
      const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => { requests.push(new Request(input, init)); return responseFor(protocol); } });
      expect((await generateText({ model, prompt: "hello", maxRetries: 0, maxOutputTokens: 16 })).text).toBe("done");
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/saved-account/ai/v1/${path}`);
      expect(request.headers.get("cf-aig-gateway-id")).toBe("saved-gateway");
      expect(request.headers.get("authorization")).toBe("Bearer saved-token");
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("x-catalog")).toBe(headers ? "retained" : null);
      const body = await request.json();
      expect(body.model).toBe(modelId);
      expect(body[protocol === "responses" ? "input" : "messages"]).toEqual(expect.any(Array));
      if (protocol === "anthropic") expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    },
  );

  it.each(["", "   "])("rejects a missing gateway ID (%j) before any request", async (gatewayId) => {
    const config = configFor(modelId);
    config.providerSettings = { ...config.providerSettings, gatewayId };
    expect(modelConfigErrors(config)).toHaveProperty("gatewayId");
    expect(modelConfigErrors(config, modelPresetFields(config, preset))).toHaveProperty("gatewayId");
    const fetch = vi.fn();
    await expect(createModel(config, undefined, undefined, { fetch })).rejects.toThrow("AI Gateway ID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives the saved account endpoint even without a stored base URL", () => {
    const config = configFor(modelId);
    config.baseURL = "";
    config.providerSettings!.accountId = "account/with space";
    expect(resolvedBaseURL(config)).toBe("https://api.cloudflare.com/client/v4/accounts/account%2Fwith%20space/ai/v1");
    expect(modelConfigErrors(config)).toEqual({});
    config.providerSettings!.accountId = "";
    expect(modelConfigErrors(config)).toHaveProperty("accountId");
  });

  it("honors an explicit model endpoint while retaining the gateway settings", () => {
    const config = configFor(modelId);
    config.modelProvider = { ...config.modelProvider, api: "https://model-route.test/accounts/${CLOUDFLARE_ACCOUNT_ID}/v1/" };
    expect(resolvedBaseURL(config)).toBe("https://model-route.test/accounts/saved-account/v1");
    expect(modelConfigErrors(config)).toEqual({});
  });
});

describe("unrelated provider identity", () => {
  it.each([undefined, "legacy-cloudflare"])("retains fields and validation for a legacy SDK-only gateway with providerId %j", (providerId) => {
    const config: ModelConfig = { providerId, sdk: "ai-gateway-provider", model: "openai/gpt-5.4", baseURL: "", providerSettings: { apiKey: "saved-token", accountId: "saved-account" },
      modelProvider: { npm: "@ai-sdk/openai" } };
    expect(modelPresetFields(config).map(({ key }) => key)).toEqual(["apiKey", "accountId", "gatewayId"]);
    expect(modelConfigErrors(config)).toHaveProperty("gatewayId");
    expect(modelConfigErrors(config, modelPresetFields(config))).toHaveProperty("gatewayId");
    expect(resolvedBaseURL(config)).toBe("https://api.cloudflare.com/client/v4/accounts/saved-account/ai/v1");
  });

  it("keeps native Anthropic API-key authentication without requiring a gateway", async () => {
    const config: ModelConfig = { providerId: "anthropic", sdk: "@ai-sdk/anthropic", model: "claude-opus-4.5", baseURL: "https://api.anthropic.com/v1",
      providerSettings: { apiKey: "anthropic-key", gatewayId: "unrelated-setting" }, modelProvider: { headers: { "Cf-Aig-Gateway-Id": "explicit-catalog-header" } } };
    expect(modelPresetFields(config).map(({ key }) => key)).toEqual(["apiKey"]);
    expect(modelConfigErrors(config)).toEqual({});
    const requests: Request[] = [];
    const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => { requests.push(new Request(input, init)); return responseFor("anthropic"); } });
    expect((await generateText({ model, prompt: "hello", maxRetries: 0, maxOutputTokens: 16 })).text).toBe("done");
    expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]!.headers.get("x-api-key")).toBe("anthropic-key");
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.headers.get("cf-aig-gateway-id")).toBe("explicit-catalog-header");
  });

  it("does not require or inject a gateway for the separate Workers AI provider", async () => {
    const config: ModelConfig = { providerId: "cloudflare-workers-ai", sdk: "@ai-sdk/openai-compatible", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      baseURL: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1", providerSettings: { apiKey: "workers-key", accountId: "workers-account" } };
    expect(modelPresetFields(config).map(({ key }) => key)).toEqual(["apiKey", "accountId"]);
    expect(modelConfigErrors(config)).toEqual({});
    const requests: Request[] = [];
    const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => { requests.push(new Request(input, init)); return responseFor("chat"); } });
    expect((await generateText({ model, prompt: "hello", maxRetries: 0, maxOutputTokens: 16 })).text).toBe("done");
    expect(requests[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/workers-account/ai/v1/chat/completions");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer workers-key");
    expect(requests[0]!.headers.get("cf-aig-gateway-id")).toBeNull();
  });
});
