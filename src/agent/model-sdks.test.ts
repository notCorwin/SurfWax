import { describe, expect, it } from "vitest";
import { MODEL_SDKS, type ModelConfig } from "../types";
import { modelConfigErrors, providerSettingFields, resolveEndpoint, sdkFor } from "./model-sdks";
import { modelProviderPresets } from "./model-limits";

const serviceAccount = JSON.stringify({ client_email: "test@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----" });

describe("model SDK registry", () => {
  it("keeps all known providers, including empty catalogs, and ignores future unknown SDKs", () => {
    const catalog = Object.fromEntries(Array.from({ length: 223 }, (_, index) => [`provider-${index}`, {
      npm: MODEL_SDKS[index % MODEL_SDKS.length], models: {},
    }]));
    Object.assign(catalog, { future: { npm: "future-sdk", models: {} } });
    expect(modelProviderPresets(catalog)).toHaveLength(223);
  });

  it("uses the DeepSeek SDK for catalog and saved OpenAI-compatible DeepSeek profiles", () => {
    expect(modelProviderPresets({ deepseek: { npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com", models: {} } })[0]?.sdk)
      .toBe("@ai-sdk/deepseek");
    expect(sdkFor({ providerId: "deepseek", sdk: "@ai-sdk/openai-compatible", baseURL: "https://api.deepseek.com" }))
      .toBe("@ai-sdk/deepseek");
    expect(sdkFor({ providerId: "custom", sdk: "@ai-sdk/openai-compatible", baseURL: "https://api.deepseek.com/v1" }))
      .toBe("@ai-sdk/deepseek");
    expect(sdkFor({ providerId: "custom", sdk: "@ai-sdk/openai-compatible", baseURL: "https://api.deepseek.com.evil.test" }))
      .toBe("@ai-sdk/openai-compatible");
  });

  it("interpolates endpoint variables and derives their fields", () => {
    const api = "https://${ACCOUNT}.example/${REGION}/v1";
    expect(resolveEndpoint(api, { ACCOUNT: "a/b", REGION: "eu west" })).toBe("https://a%2Fb.example/eu%20west/v1");
    expect(providerSettingFields({ id: "template", npm: "@ai-sdk/openai-compatible", api }).map(({ key }) => key))
      .toEqual(["apiKey", "ACCOUNT", "REGION"]);
  });

  it("validates alternative Bedrock and Vertex credentials", () => {
    const bedrock: ModelConfig = { sdk: "@ai-sdk/amazon-bedrock", model: "test-model", baseURL: "",
      providerSettings: { region: "us-east-1", accessKeyId: "access", secretAccessKey: "secret" } };
    expect(modelConfigErrors(bedrock)).toEqual({});
    const vertex: ModelConfig = { sdk: "@ai-sdk/google-vertex", model: "test-model", baseURL: "",
      providerSettings: { project: "project", location: "us-central1", serviceAccountJson: serviceAccount } };
    expect(modelConfigErrors(vertex)).toEqual({});
    vertex.providerSettings!.serviceAccountJson = "not-json";
    expect(modelConfigErrors(vertex)).toHaveProperty("serviceAccountJson");
  });

  it("preserves whole URL placeholders while escaping component placeholders", () => {
    expect(resolveEndpoint("${NEON_AI_GATEWAY_BASE_URL}/openai/v1", { NEON_AI_GATEWAY_BASE_URL: "https://gateway.example/" }))
      .toBe("https://gateway.example/openai/v1");
    expect(resolveEndpoint("https://${ACCOUNT}.example/v1", { ACCOUNT: "https://other.example" }))
      .toBe("https://https%3A%2F%2Fother.example.example/v1");
    expect(resolveEndpoint("${NEON_AI_GATEWAY_BASE_URL}/openai/v1", { NEON_AI_GATEWAY_BASE_URL: "javascript:alert(1)" }))
      .toBe("javascript%3Aalert(1)/openai/v1");
  });

  it.each(["AZURE_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME"])("uses saved Azure resourceName for model template %s", (key) => {
    const api = `https://\${${key}}.services.ai.azure.com/models`;
    const config: ModelConfig = { providerId: "azure", sdk: "@ai-sdk/azure", model: "kimi-k2.6", baseURL: "", providerSettings: { resourceName: "saved-resource", apiKey: "key" }, modelProvider: { npm: "@ai-sdk/openai-compatible", api, shape: "completions" } };
    expect(providerSettingFields({ id: "azure", npm: config.modelProvider!.npm, api }).map(({ key }) => key)).toEqual(["apiKey", "resourceName", "apiVersion"]);
    expect(resolveEndpoint(api, config.providerSettings!)).toBe("https://saved-resource.services.ai.azure.com/models");
    expect(modelConfigErrors(config)).toEqual({});
  });
});
