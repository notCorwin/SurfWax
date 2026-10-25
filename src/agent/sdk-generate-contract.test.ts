import { ToolLoopAgent, generateText, tool } from "ai";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MODEL_SDKS, type ModelConfig, type ModelSdk } from "../types";
import { createModel } from "./model";

type Protocol = "chat" | "responses" | "anthropic" | "google" | "cohere" | "bedrock" | "gateway" | "sap";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const chatUsage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const responseUsage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function configFor(sdk: ModelSdk): ModelConfig {
  const settings: Record<string, string> = { apiKey: "key" };
  let model = "test";
  if (sdk === "@ai-sdk/amazon-bedrock" || sdk === "@ai-sdk/amazon-bedrock/mantle") settings.region = "us-east-1";
  if (sdk === "@ai-sdk/azure") settings.resourceName = "test";
  if (sdk.startsWith("@ai-sdk/google-vertex")) Object.assign(settings, { project: "test", location: "us-east5", serviceAccountJson: JSON.stringify({ client_email: "test@test.iam.gserviceaccount.com", private_key: key }) });
  if (sdk === "ai-gateway-provider") Object.assign(settings, { accountId: "account", gatewayId: "gateway" });
  if (sdk === "@qvac/ai-sdk-provider") settings.endpoint = "https://provider.test/v1";
  if (sdk === "gitlab-ai-provider") { model = "duo-chat-gpt-5-1"; Object.assign(settings, { instanceUrl: "https://gitlab.test", aiGatewayUrl: "https://gateway.test" }); }
  if (sdk === "watsonx-ai-provider") settings.projectId = "project";
  if (sdk === "@jerome-benoit/sap-ai-provider-v2") Object.assign(settings, { serviceKeyJson: JSON.stringify({ url: "https://auth.test", clientid: "client", clientsecret: "secret" }), deploymentUrl: "https://sap.test", resourceGroup: "group" });
  return { sdk, providerId: sdk, model, baseURL: "https://provider.test/v1", providerSettings: settings, ...(sdk === "@ai-sdk/amazon-bedrock/mantle" ? { modelProvider: { shape: "responses" } } : {}) };
}

function protocolFor(sdk: ModelSdk): Protocol {
  if (["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/xai", "gitlab-ai-provider", "@ai-sdk/amazon-bedrock/mantle"].includes(sdk)) return "responses";
  if (sdk.includes("anthropic")) return "anthropic";
  if (sdk === "@ai-sdk/google" || sdk === "@ai-sdk/google-vertex") return "google";
  if (sdk === "@ai-sdk/cohere") return "cohere";
  if (sdk === "@ai-sdk/amazon-bedrock") return "bedrock";
  if (sdk === "@ai-sdk/gateway") return "gateway";
  if (sdk === "@jerome-benoit/sap-ai-provider-v2") return "sap";
  return "chat";
}

function completion(protocol: Protocol, withTool: boolean): object {
  if (protocol === "chat" || protocol === "sap") return {
    id: "response", object: "chat.completion", created: 1, model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: withTool ? null : "done", ...(withTool ? { tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] } : {}) }, finish_reason: withTool ? "tool_calls" : "stop" }],
    usage: chatUsage,
  };
  if (protocol === "responses") return {
    id: "response", object: "response", created_at: 1, model: "test", status: "completed",
    output: withTool ? [{ type: "function_call", id: "fc", call_id: "call", name: "echo", arguments: '{"value":"ok"}', status: "completed" }]
      : [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
    usage: responseUsage,
  };
  if (protocol === "anthropic") return {
    type: "message", id: "response", model: "test", role: "assistant",
    content: withTool ? [{ type: "tool_use", id: "call", name: "echo", input: { value: "ok" } }]
      : [{ type: "text", text: "done" }],
    stop_reason: withTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (protocol === "google") return {
    candidates: [{ content: { role: "model", parts: withTool ? [{ functionCall: { id: "call", name: "echo", args: { value: "ok" } } }] : [{ text: "done" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
  if (protocol === "cohere") return {
    generation_id: "response", message: { role: "assistant", content: withTool ? null : [{ type: "text", text: "done" }],
      ...(withTool ? { tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] } : {}) },
    finish_reason: withTool ? "TOOL_CALL" : "COMPLETE", usage: { tokens: { input_tokens: 1, output_tokens: 1 } },
  };
  if (protocol === "bedrock") return {
    output: { message: { role: "assistant", content: withTool ? [{ toolUse: { toolUseId: "call", name: "echo", input: { value: "ok" } } }] : [{ text: "done" }] } },
    stopReason: withTool ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  if (protocol === "gateway") return {
    content: withTool ? [{ type: "tool-call", toolCallId: "call", toolName: "echo", input: '{"value":"ok"}', dynamic: true }]
      : [{ type: "text", text: "done" }],
    finishReason: { unified: withTool ? "tool-calls" : "stop", raw: withTool ? "tool_calls" : "stop" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  };
  throw new Error("Missing JSON completion fixture for protocol " + protocol);
}

function isCredentialRequest(request: Request): boolean {
  return /oauth|identity\/token|direct_access/.test(request.url);
}

function fixture(sdk: ModelSdk, options: { recover?: boolean; abort?: boolean; toolLoop?: boolean } = {}) {
  const requests: Request[] = [];
  const modelRequests: Request[] = [];
  let generatedResponses = 0;
  let recovered = false;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (isCredentialRequest(request)) return Response.json({ access_token: "token", token: "token", expires_in: 3600, headers: {} });
    modelRequests.push(request);
    notifyStarted();
    if (options.abort) return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      if (request.signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    });
    if (options.recover && !recovered) {
      recovered = true;
      return Response.json({ error: { message: "busy" } }, { status: 429, headers: { "Retry-After": "0" } });
    }
    const withTool = Boolean(options.toolLoop && generatedResponses === 0);
    generatedResponses++;
    return Response.json(completion(protocolFor(sdk), withTool));
  });
  return { fetch, requests, modelRequests, started };
}

describe.each(MODEL_SDKS)("%s JSON generation contract", (sdk) => {
  it("returns a complete JSON response", async () => {
    const wire = fixture(sdk);
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch });
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).resolves.toMatchObject({ text: "done" });
    expect(wire.modelRequests).toHaveLength(1);
    const body = await wire.modelRequests[0]?.clone().json();
    expect(body?.stream).not.toBe(true);
  }, 20_000);

  it("retries transient HTTP errors and round-trips a tool result", async () => {
    const wire = fixture(sdk, { recover: true, toolLoop: true });
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch });
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value: "executed:" + value }));
    const agent = new ToolLoopAgent({ model, maxRetries: 0, tools: { echo: tool({ description: "Echo a value", inputSchema: z.object({ value: z.string() }), execute }) } });
    await expect(agent.generate({ prompt: "echo ok" })).resolves.toMatchObject({ text: "done" });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ value: "ok" }, expect.anything());
    expect(wire.modelRequests).toHaveLength(3);
    const bodies = await Promise.all(wire.modelRequests.map((request) => request.clone().json()));
    expect(JSON.stringify(bodies[2])).toContain("executed:ok");
    expect(JSON.stringify(bodies)).not.toMatch(/"stream"\s*:\s*true/);
    for (const request of wire.requests.filter((candidate) => !isCredentialRequest(candidate))) {
      const authenticated = request.headers.get("authorization") || request.headers.get("x-api-key") || request.headers.get("api-key")
        || request.headers.get("x-goog-api-key") || request.headers.get("x-amz-access-key")
        || new URL(request.url).searchParams.get("key") || new URL(request.url).searchParams.get("api_key");
      expect(authenticated, request.url).toBeTruthy();
    }
  }, 20_000);

  it("fails a permanent provider error without retrying", async () => {
    const wire = fixture(sdk);
    wire.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      wire.requests.push(request);
      if (isCredentialRequest(request)) return Response.json({ access_token: "token", token: "token", expires_in: 3600, headers: {} });
      wire.modelRequests.push(request);
      return Response.json({ message: "Invalid credentials", error: { type: "authentication_error", message: "Invalid credentials", code: "invalid_api_key" } }, { status: 401 });
    });
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch });
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    expect(wire.modelRequests).toHaveLength(1);
  });

  it("propagates abort to the provider request", async () => {
    const controller = new AbortController();
    const wire = fixture(sdk, { abort: true });
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch, signal: controller.signal });
    const generation = generateText({ model, prompt: "hello", maxRetries: 0, abortSignal: controller.signal });
    await wire.started;
    controller.abort();
    await expect(generation).rejects.toThrow();
    expect(wire.modelRequests).toHaveLength(1);
    expect(wire.modelRequests[0]?.signal.aborted).toBe(true);
  }, 20_000);
});
