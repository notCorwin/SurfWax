import { generateText } from "ai";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import { createModel } from "./model";
import { modelConfigErrors, resolvedBaseURL, sdkFor } from "./model-sdks";

const usage = { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const responses = () => Response.json({ id: "response", created_at: 1, model: "test", output: [{ type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }], usage });
const chat = () => Response.json({ id: "response", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

describe("model-specific SDK routes", () => {
  it("uses native Mantle Responses at the model endpoint with saved provider credentials", async () => {
    const config: ModelConfig = { providerId: "amazon-bedrock", sdk: "@ai-sdk/amazon-bedrock", baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com", model: "openai.gpt-6.1-sol", apiKey: "legacy-key",
      providerSettings: { apiKey: "user-key", region: "eu-west-1" }, modelProvider: { npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1", shape: "responses", headers: { "x-catalog": "model", Authorization: "catalog-key" }, body: { service_tier: "priority", model: "wrong", input: "wrong", stream: true } } };
    const requests: Request[] = [];
    const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => { requests.push(new Request(input, init)); return responses(); } });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://bedrock-mantle.eu-west-1.api.aws/openai/v1/responses");
    expect(request.headers.get("authorization")).toBe("Bearer user-key");
    expect(request.headers.get("x-catalog")).toBe("model");
    const body = await request.json();
    expect(body.model).toBe(config.model);
    expect(body.input).toEqual(expect.any(Array));
    expect(body.service_tier).toBe("priority");
    // Catalog defaults cannot change the operation or inject prompt/tool fields.
    expect(body.stream).not.toBe(true);
  });

  it("selects native OpenAI Chat Completions instead of its default Responses interface", async () => {
    const requests: Request[] = [];
    const model = await createModel({ sdk: "@ai-sdk/openai", baseURL: "https://default.test/v1", model: "test", apiKey: "key", modelProvider: { api: "https://model.test/v1", shape: "completions" } }, undefined, undefined, {
      fetch: async (input, init) => { requests.push(new Request(input, init)); return chat(); },
    });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests[0]!.url).toBe("https://model.test/v1/chat/completions");
  });

  it("uses native OpenAI Responses for a compatible provider with a Responses-shaped model", async () => {
    const requests: Request[] = [];
    const model = await createModel({ providerId: "sakana", sdk: "@ai-sdk/openai-compatible", baseURL: "https://provider.test/v1", model: "fugu", apiKey: "key", modelProvider: { shape: "responses" } }, undefined, undefined, {
      fetch: async (input, init) => { requests.push(new Request(input, init)); return responses(); },
    });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests[0]!.url).toBe("https://provider.test/v1/responses");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer key");
  });

  it("does not rewrite a native signed Mantle request", async () => {
    const requests: Request[] = [];
    const config: ModelConfig = { sdk: "@ai-sdk/amazon-bedrock/mantle", baseURL: "https://bedrock-mantle.us-east-1.api.aws/v1", model: "test", providerSettings: { region: "us-east-1", accessKeyId: "TESTACCESS", secretAccessKey: "test-secret" } };
    const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => { requests.push(new Request(input, init)); return chat(); } });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(modelConfigErrors({ ...config, modelProvider: { body: { service_tier: "priority" } } })).toHaveProperty("body");
  });

  it("rejects unknown model SDKs and unsupported shapes before sending requests", async () => {
    const fetch = vi.fn();
    const config: ModelConfig = { sdk: "@ai-sdk/openai", apiKey: "key", baseURL: "https://provider.test/v1", model: "test" };
    await expect(createModel({ ...config, modelProvider: { npm: "future-sdk" } }, undefined, undefined, { fetch })).rejects.toThrow("Unsupported model SDK");
    await expect(createModel({ ...config, modelProvider: { shape: "future-shape" } }, undefined, undefined, { fetch })).rejects.toThrow("Unsupported model API shape");
    await expect(createModel({ ...config, sdk: "@ai-sdk/anthropic", modelProvider: { shape: "responses" } }, undefined, undefined, { fetch })).rejects.toThrow("does not support model API shape");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets explicit model routes override DeepSeek provider inference", () => {
    const config: ModelConfig = { providerId: "deepseek", sdk: "@ai-sdk/openai-compatible", baseURL: "https://api.deepseek.com", model: "test", modelProvider: { npm: "@ai-sdk/anthropic", api: "https://messages.test" } };
    expect(sdkFor(config)).toBe("@ai-sdk/anthropic");
    expect(resolvedBaseURL(config)).toBe("https://messages.test");
  });

  it("preserves Vertex service-account authentication for a compatible model override", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    const config: ModelConfig = { providerId: "google-vertex", sdk: "@ai-sdk/google-vertex", baseURL: "", model: "deepseek-ai/deepseek-v3.1-maas", providerSettings: {
      project: "saved-project", location: "us-east5", serviceAccountJson: JSON.stringify({ client_email: "test@example.iam.gserviceaccount.com", private_key: privateKey }),
    }, modelProvider: { npm: "@ai-sdk/openai-compatible", api: "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/endpoints/openapi" } };
    expect(modelConfigErrors(config)).toEqual({});
    const requests: Request[] = [];
    const model = await createModel(config, undefined, undefined, { fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      return request.url === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "vertex-token", expires_in: 3600 }) : chat();
    } });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe("https://us-east5-aiplatform.googleapis.com/v1/projects/saved-project/locations/us-east5/endpoints/openapi/chat/completions");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer vertex-token");
    expect(requests[1]!.headers.get("x-goog-api-key")).toBeNull();
  });

  it("honors a GitLab model endpoint and shape without changing its token issuer", async () => {
    const requests: Request[] = [];
    const model = await createModel({ providerId: "gitlab", sdk: "gitlab-ai-provider", baseURL: "", model: "duo-chat-gpt-6-sol", providerSettings: { apiKey: "gitlab-key", instanceUrl: "https://gitlab.test" }, modelProvider: { api: "https://model-proxy.test/v1", shape: "completions", body: { service_tier: "priority" } } }, undefined, undefined, {
      fetch: async (input, init) => { const request = new Request(input, init); requests.push(request); return request.url.includes("direct_access") ? Response.json({ token: "direct-token" }) : chat(); },
    });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests[0]!.url).toBe("https://gitlab.test/api/v4/ai/third_party_agents/direct_access");
    expect(await requests[0]!.json()).not.toHaveProperty("service_tier");
    expect(requests[1]!.url).toBe("https://model-proxy.test/v1/chat/completions");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer direct-token");
    expect(await requests[1]!.json()).toMatchObject({ model: "gpt-6-sol", service_tier: "priority" });
  });

  it.each([undefined, "2025-04-01"])("retains Azure key auth and API version %s on compatible model routes", async (apiVersion) => {
    const requests: Request[] = [];
    const model = await createModel({ providerId: "azure", sdk: "@ai-sdk/azure", baseURL: "", model: "kimi-k2.6", providerSettings: { resourceName: "saved-resource", apiKey: "azure-key", ...(apiVersion ? { apiVersion } : {}) }, modelProvider: { npm: "@ai-sdk/openai-compatible", api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/models", shape: "completions" } }, undefined, undefined, {
      fetch: async (input, init) => { requests.push(new Request(input, init)); return chat(); },
    });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("done");
    expect(requests[0]!.url).toBe(`https://saved-resource.services.ai.azure.com/models/chat/completions?api-version=${apiVersion ?? "2024-05-01-preview"}`);
    expect(requests[0]!.headers.get("api-key")).toBe("azure-key");
    expect(requests[0]!.headers.get("authorization")).toBeNull();
  });
});
