import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import { loadProviderModule, providerAdapterFor } from "./provider-adapters";

const config = (value: Partial<ModelConfig>): ModelConfig => ({ baseURL: "", model: "test", ...value });

describe("provider adapters", () => {
  it.each([
    [config({ sdk: "@ai-sdk/openai" }), { sdk: "@ai-sdk/openai", protocol: "openai", auth: "api-key" }],
    [config({ sdk: "@ai-sdk/anthropic" }), { sdk: "@ai-sdk/anthropic", protocol: "native", requiresMaxTokens: true }],
    [config({ providerId: "azure", sdk: "@ai-sdk/openai-compatible" }), { auth: "azure-api-key" }],
    [config({ sdk: "gitlab-ai-provider" }), { auth: "gitlab-direct-access" }],
    [config({ sdk: "watsonx-ai-provider" }), { auth: "oauth" }],
  ] as const)("describes routing and authentication for %#", (input, expected) => {
    expect(providerAdapterFor(input)).toMatchObject(expected);
  });

  it("uses an injected loader at the adapter boundary", async () => {
    const module = { create: vi.fn() };
    const loader = vi.fn(async () => module);
    await expect(loadProviderModule("@ai-sdk/openai", loader)).resolves.toBe(module);
    expect(loader).toHaveBeenCalledOnce();
  });
});
