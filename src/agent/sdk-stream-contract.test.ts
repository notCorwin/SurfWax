import { ToolLoopAgent, tool } from "ai";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MODEL_SDKS, type ModelConfig, type ModelSdk } from "../types";
import { createModel } from "./model";

// Wire fixtures follow the installed providers' response schemas. A withheld
// suffix proves actual incremental consumption rather than JSON-to-SSE buffering.
type Protocol = "chat" | "responses" | "anthropic" | "google" | "cohere" | "bedrock" | "gateway" | "sap";
const encoder = new TextEncoder();
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const sdkUsage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
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
function frames(protocol: Protocol, first: boolean): Uint8Array[] {
  const text = first ? "prefix" : "done";
  let events: any[];
  if (protocol === "chat" || protocol === "sap") {
    const chunk = (delta: any, finish_reason: string | null = null) => ({ id: "response", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }], usage });
    events = [chunk({ role: "assistant", content: text }), ...(first ? [
      chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "echo", arguments: '{"value":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }),
    ] : []), chunk({}, first ? "tool_calls" : "stop")];
    if (protocol === "sap") events = events.map((final_result) => ({ final_result }));
  } else if (protocol === "responses") {
    events = [
      { type: "response.created", response: { id: "response", created_at: 1, model: "test", object: "response", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "message", role: "assistant", content: [], status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "message", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
      ...(first ? [
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call", name: "echo", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 1, delta: '{"value":' },
        { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 1, delta: '"ok"}' },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call", name: "echo", arguments: '{"value":"ok"}', status: "completed" } },
      ] : []),
      { type: "response.completed", response: { id: "response", object: "response", output: [], status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
  } else if (protocol === "anthropic") {
    events = [
      { type: "message_start", message: { id: "response", type: "message", role: "assistant", model: "test", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      ...(first ? [
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "echo", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ok"}' } },
        { type: "content_block_stop", index: 1 },
      ] : []),
      { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  } else if (protocol === "google") {
    events = [{ candidates: [{ content: { role: "model", parts: [{ text }] } }] },
      ...(first ? [{ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call", name: "echo", args: { value: "ok" } } }] } }] }] : []),
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }];
  } else if (protocol === "cohere") {
    events = [{ type: "message-start", id: "response" },
      { type: "content-start", index: 0, delta: { message: { content: { type: "text", text: "" } } } },
      { type: "content-delta", index: 0, delta: { message: { content: { text } } } }, { type: "content-end", index: 0 },
      ...(first ? [
        { type: "tool-call-start", delta: { message: { tool_calls: { id: "call", type: "function", function: { name: "echo", arguments: '{"value":' } } } } },
        { type: "tool-call-delta", delta: { message: { tool_calls: { function: { arguments: '"ok"}' } } } } }, { type: "tool-call-end" },
      ] : []), { type: "message-end", delta: { finish_reason: first ? "TOOL_CALL" : "COMPLETE", usage: { tokens: { input_tokens: 1, output_tokens: 1 } } } }];
  } else if (protocol === "gateway") {
    events = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: text }, { type: "text-end", id: "text" },
      ...(first ? [{ type: "tool-call", toolCallId: "call", toolName: "echo", input: '{"value":"ok"}' }] : []),
      { type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" }, usage: sdkUsage }];
  } else {
    const event = (name: string, body: any) => codec.encode({ headers: { ":message-type": { type: "string", value: "event" }, ":event-type": { type: "string", value: name } }, body: encoder.encode(JSON.stringify(body)) });
    return [event("messageStart", { role: "assistant" }), event("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }), event("contentBlockStop", { contentBlockIndex: 0 }),
      ...(first ? [event("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call", name: "echo" } } }),
        event("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":' } } }), event("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '"ok"}' } } }), event("contentBlockStop", { contentBlockIndex: 1 })] : []),
      event("messageStop", { stopReason: first ? "tool_use" : "end_turn" }), event("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } })];
  }
  return events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}
function fixture(sdk: ModelSdk, signal?: AbortSignal, recover = false) {
  const bodies: any[] = [];
  const requests: Request[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (/oauth|identity\/token|direct_access/.test(request.url)) {
      return Response.json({ access_token: "token", token: "token", expires_in: 3600, headers: {} });
    }
    if (recover && attempts++ === 0) return Response.json({ error: { message: "busy" } }, { status: 429, headers: { "Retry-After": "0" } });
    bodies.push(await request.clone().json());
    const protocol = protocolFor(sdk);
    const chunks = frames(protocol, bodies.length === 1);
    const prefixCount = protocol === "chat" || protocol === "sap" || protocol === "google" ? 1 : protocol === "bedrock" ? 2 : 3;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
        request.signal.addEventListener("abort", abort, { once: true });
        for (const chunk of chunks.slice(0, prefixCount)) controller.enqueue(chunk);
        void (bodies.length === 1 ? gate : Promise.resolve()).then(() => {
          if (request.signal.aborted) return;
          for (const chunk of chunks.slice(prefixCount)) controller.enqueue(chunk);
          controller.close(); request.signal.removeEventListener("abort", abort);
        });
      },
    });
    return new Response(body, { headers: { "Content-Type": protocol === "bedrock" ? "application/vnd.amazon.eventstream" : "text/event-stream" } });
  });
  return { fetch, bodies, requests, release };
}

describe.each(MODEL_SDKS)("%s streaming contract", (sdk) => {
  it("streams before EOF, recovers a request, authenticates and round-trips a tool", async () => {
    const wire = fixture(sdk, undefined, true);
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch });
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value }));
    const result = await new ToolLoopAgent({ model, maxRetries: 0, tools: { echo: tool({ description: "Echo", inputSchema: z.object({ value: z.string() }), execute }) } }).stream({ prompt: "echo ok" });
    const reader = result.textStream.getReader();
    expect((await reader.read()).value).toBe("prefix");
    expect(wire.bodies).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    wire.release();
    let received = "prefix";
    while (true) { const next = await reader.read(); if (next.done) break; received += next.value; }
    expect(received).toBe("prefixdone");
    await expect(result.text).resolves.toBe("done");
    expect(execute).toHaveBeenCalledExactlyOnceWith({ value: "ok" }, expect.anything());
    expect(wire.bodies).toHaveLength(2);
    expect(JSON.stringify(wire.bodies[1])).toMatch(/call|functionResponse/);
    expect(JSON.stringify(wire.bodies[1])).toContain("ok");
    for (const request of wire.requests.filter(request => !/oauth2.googleapis.com|identity\/token/.test(request.url))) expect(request.headers.get("authorization") || request.headers.get("x-api-key") || request.headers.get("api-key") || request.headers.get("x-goog-api-key") || new URL(request.url).searchParams.get("key"), request.url).toBeTruthy();
  }, 10_000);

  it("terminates a permanent provider error without retrying", async () => {
    let modelRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (/oauth|identity\/token|direct_access/.test(request.url)) return Response.json({ access_token: "token", token: "token", expires_in: 3600, headers: {} });
      modelRequests++;
      return Response.json({ message: "Invalid credentials", error: { type: "authentication_error", message: "Invalid credentials", code: "invalid_api_key" } }, { status: 401 });
    });
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch });
    await expect((model as any).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [{ type: "function", name: "echo", inputSchema: { type: "object", properties: {} } }] })).rejects.toThrow();
    expect(modelRequests).toBe(1);
  });

  it("propagates abort through a still-open response and credentials requests", async () => {
    const controller = new AbortController();
    const wire = fixture(sdk, controller.signal);
    const model = await createModel(configFor(sdk), undefined, undefined, { fetch: wire.fetch, signal: controller.signal });
    const result = await new ToolLoopAgent({ model, maxRetries: 0, tools: { echo: tool({ inputSchema: z.object({ value: z.string() }) }) } }).stream({ prompt: "echo ok", abortSignal: controller.signal });
    const reader = result.textStream.getReader();
    expect((await reader.read()).value).toBe("prefix");
    controller.abort();
    await reader.read().catch(() => undefined);
    expect(wire.requests.every((request) => request.signal.aborted)).toBe(true);
    expect(wire.bodies).toHaveLength(1);
    wire.release();
  }, 10_000);
});
