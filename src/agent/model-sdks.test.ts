import { describe, expect, it } from "vitest";
import { MODEL_SDKS, type ModelConfig, type ModelSdk } from "../types";
import { createModel } from "./model";
import { modelConfigErrors, providerSettingFields, resolveEndpoint, sdkFor } from "./model-sdks";
import { modelProviderPresets } from "./model-limits";

const serviceAccount = JSON.stringify({ client_email: "test@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----" });

function configFor(sdk: ModelSdk): ModelConfig {
  const providerSettings: Record<string, string> = { apiKey: "test-key" };
  let baseURL = "";
  let model = "test-model";
  if (sdk === "@ai-sdk/openai-compatible") baseURL = "https://compatible.test/v1";
  if (sdk === "@ai-sdk/amazon-bedrock") Object.assign(providerSettings, { region: "us-east-1" });
  if (sdk === "@ai-sdk/azure") Object.assign(providerSettings, { resourceName: "test-resource" });
  if (sdk === "@ai-sdk/google-vertex") Object.assign(providerSettings, { project: "test-project", location: "us-central1" });
  if (sdk === "@ai-sdk/google-vertex/anthropic") Object.assign(providerSettings, { project: "test-project", location: "us-east5", serviceAccountJson: serviceAccount });
  if (sdk === "ai-gateway-provider") Object.assign(providerSettings, { accountId: "account", gatewayId: "gateway" });
  if (sdk === "gitlab-ai-provider") model = "duo-chat-gpt-5-1";
  if (sdk === "watsonx-ai-provider") Object.assign(providerSettings, { projectId: "project" });
  if (sdk === "@qvac/ai-sdk-provider") Object.assign(providerSettings, { endpoint: "https://qvac.test/v1" });
  if (sdk === "@jerome-benoit/sap-ai-provider-v2") Object.assign(providerSettings, {
    serviceKeyJson: JSON.stringify({ url: "https://auth.test", clientid: "client", clientsecret: "secret" }),
    deploymentUrl: "https://orchestration.test",
  });
  return { providerId: sdk, sdk, providerSettings, baseURL, model };
}

describe("model SDK registry", () => {
  it("contains all supported SDK identifiers and creates a language model for each", async () => {
    expect(MODEL_SDKS).toHaveLength(29);
    for (const sdk of MODEL_SDKS) {
      const model = await createModel(configFor(sdk));
      expect(model, sdk).toHaveProperty("specificationVersion");
    }
  }, 30_000);

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
    const bedrock = configFor("@ai-sdk/amazon-bedrock");
    bedrock.providerSettings = { region: "us-east-1", accessKeyId: "access", secretAccessKey: "secret" };
    expect(modelConfigErrors(bedrock)).toEqual({});
    const vertex = configFor("@ai-sdk/google-vertex");
    vertex.providerSettings = { project: "project", location: "us-central1", serviceAccountJson: serviceAccount };
    expect(modelConfigErrors(vertex)).toEqual({});
    vertex.providerSettings.serviceAccountJson = "not-json";
    expect(modelConfigErrors(vertex)).toHaveProperty("serviceAccountJson");
  });
});
