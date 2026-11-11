import { generateText, ToolLoopAgent, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModel } from "./model";

const contracts = [
  { sdk: "@ai-sdk/openai", endpoint: "openai-responses", path: "/responses" },
  {
    sdk: "@ai-sdk/anthropic",
    endpoint: "anthropic-messages",
    path: "/messages",
  },
  {
    sdk: "@ai-sdk/google",
    endpoint: "google-interactions",
    path: "/interactions",
  },
  {
    sdk: "@ai-sdk/openai-compatible",
    endpoint: "openai-chat-completions",
    path: "/chat/completions",
  },
] as const;
type Protocol = (typeof contracts)[number]["endpoint"];
const chatUsage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const responseUsage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function completion(protocol: Protocol, withTool: boolean): object {
  if (protocol === "openai-chat-completions")
    return {
      id: "response",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: withTool ? null : "done",
            ...(withTool
              ? {
                  tool_calls: [
                    {
                      id: "call",
                      type: "function",
                      function: { name: "echo", arguments: '{"value":"ok"}' },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: withTool ? "tool_calls" : "stop",
        },
      ],
      usage: chatUsage,
    };
  if (protocol === "openai-responses")
    return {
      id: "response",
      object: "response",
      created_at: 1,
      model: "test",
      status: "completed",
      output: withTool
        ? [
            {
              type: "function_call",
              id: "fc",
              call_id: "call",
              name: "echo",
              arguments: '{"value":"ok"}',
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done", annotations: [] }],
            },
          ],
      usage: responseUsage,
    };
  if (protocol === "anthropic-messages")
    return {
      type: "message",
      id: "response",
      model: "test",
      role: "assistant",
      content: withTool
        ? [
            {
              type: "tool_use",
              id: "call",
              name: "echo",
              input: { value: "ok" },
            },
          ]
        : [{ type: "text", text: "done" }],
      stop_reason: withTool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  return {
    id: "interaction",
    status: "completed",
    steps: withTool
      ? [
          {
            type: "function_call",
            id: "call",
            name: "echo",
            arguments: { value: "ok" },
          },
        ]
      : [{ type: "model_output", content: [{ type: "text", text: "done" }] }],
  };
}

function fixture(
  protocol: Protocol,
  options: { recover?: boolean; abort?: boolean; toolLoop?: boolean } = {},
) {
  const requests: Request[] = [];
  const modelRequests: Request[] = [];
  let generatedResponses = 0;
  let recovered = false;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models"))
      return Response.json({ data: [{ id: "test", reasoning: false }] });
    modelRequests.push(request);
    notifyStarted();
    if (options.abort)
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        if (request.signal.aborted)
          reject(new DOMException("Aborted", "AbortError"));
      });
    if (options.recover && !recovered) {
      recovered = true;
      return Response.json(
        { error: { message: "busy" } },
        { status: 429, headers: { "Retry-After": "0" } },
      );
    }
    const withTool = Boolean(options.toolLoop && generatedResponses === 0);
    generatedResponses++;
    return Response.json(completion(protocol, withTool));
  });
  return { fetch, requests, modelRequests, started };
}

describe.each(contracts)(
  "$endpoint request contract",
  ({ sdk, endpoint, path }) => {
    it("round-trips a tool result after HTTP recovery and cancels a pending request", async () => {
      const wire = fixture(endpoint, { recover: true, toolLoop: true });
      const model = await createModel(
        {
          sdk,
          providerId: "custom",
          endpointType: endpoint,
          model: "test",
          baseURL: "https://provider.test/v1",
          providerSettings: { apiKey: "key" },
        },
        undefined,
        undefined,
        { fetch: wire.fetch },
      );
      const execute = vi.fn(async ({ value }: { value: string }) => ({
        value: "executed:" + value,
      }));
      const agent = new ToolLoopAgent({
        model,
        maxRetries: 0,
        tools: {
          echo: tool({
            description: "Echo a value",
            inputSchema: z.object({ value: z.string() }),
            execute,
          }),
        },
      });
      await expect(
        agent.generate({ prompt: "echo ok" }),
      ).resolves.toMatchObject({ text: "done" });
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        { value: "ok" },
        expect.anything(),
      );
      expect(wire.modelRequests).toHaveLength(3);
      const bodies = await Promise.all(
        wire.modelRequests.map((request) => request.clone().json()),
      );
      expect(JSON.stringify(bodies[2])).toContain("executed:ok");
      expect(JSON.stringify(bodies)).not.toMatch(/"stream"\s*:\s*true/);
      if (endpoint === "openai-chat-completions") {
        expect(wire.requests.filter((request) => request.method === "GET")).toHaveLength(1);
      }
      for (const request of wire.requests) {
        if (request.method === "GET") {
          expect(new URL(request.url).pathname).toBe("/v1/models");
          expect(request.headers.get("authorization")).toBe("Bearer key");
          continue;
        }
        expect(new URL(request.url).pathname).toBe("/v1" + path);
        const authenticated =
          request.headers.get("authorization") ||
          request.headers.get("x-api-key") ||
          request.headers.get("api-key") ||
          request.headers.get("x-goog-api-key") ||
          request.headers.get("x-amz-access-key") ||
          new URL(request.url).searchParams.get("key") ||
          new URL(request.url).searchParams.get("api_key");
        expect(authenticated, request.url).toBeTruthy();
      }
      const controller = new AbortController();
      const pending = fixture(endpoint, { abort: true });
      const cancellable = await createModel(
        {
          sdk,
          providerId: "custom",
          endpointType: endpoint,
          model: "test",
          baseURL: "https://provider.test/v1",
          providerSettings: { apiKey: "key" },
        },
        undefined,
        undefined,
        { fetch: pending.fetch, signal: controller.signal },
      );
      const generation = generateText({
        model: cancellable,
        prompt: "hello",
        maxRetries: 0,
        abortSignal: controller.signal,
      });
      const rejected = expect(generation).rejects.toThrow();
      await pending.started;
      controller.abort();
      await rejected;
      if (endpoint === "openai-chat-completions")
        expect(pending.requests.some((request) => request.method === "GET")).toBe(true);
      expect(pending.modelRequests).toHaveLength(1);
      expect(pending.modelRequests[0]!.signal.aborted).toBe(true);
    }, 20_000);
  },
);

it("routes bundled catalog selections through saved configuration and real SDK tool loops", async () => {
  const { loadModelCatalog, modelProviderPresets, applyModelPreset } = await import("./model-limits");
  const { saveModelConfig, loadModelConfig, selectedModelConfig } = await import("../sidepanel/config");
  const offlineFetch = vi.fn(async () => { throw new Error("offline"); });
  const catalog = await loadModelCatalog({ fetch: offlineFetch, bundledFallback: true });
  {
    const presets = modelProviderPresets(catalog);
    for (const [id, protocol, path] of [
      ["openai", "openai-responses", "/v1/responses"],
      ["anthropic", "anthropic-messages", "/v1/messages"],
      ["google", "google-interactions", "/v1beta/interactions"],
    ] as const) {
      const preset = presets.find((item) => item.id === id)!;
      expect(preset?.models.length).toBeGreaterThan(0);
      if (id === "google") expect(preset.modelProviders?.[preset.models[0]!.id]?.shape).toBeUndefined();
      const initial = { providerId: id, sdk: preset.sdk, baseURL: preset.baseURL, model: preset.models[0]!.id, providerSettings: { apiKey: "fake" } };
      const selected = applyModelPreset(initial, preset);
      let saved: Record<string, unknown> = {};
      const storage = { get: async () => saved, set: async (value: Record<string, unknown>) => { saved = structuredClone(value); } } as any;
      await saveModelConfig({ selectedProviderId: id, profiles: { [id]: selected } }, storage);
      const restored = selectedModelConfig(await loadModelConfig(undefined, storage, { loadCatalog: async () => { throw new Error("offline"); } }))!;
      expect(restored.endpointType).toBeUndefined();
      const wire = fixture(protocol, { toolLoop: true });
      const model = await createModel(restored, undefined, undefined, { fetch: wire.fetch });
      const agent = new ToolLoopAgent({ model, maxRetries: 0, tools: { echo: tool({ description: "Echo", inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => ({ value: `executed:${value}` }) }) } });
      await expect(agent.generate({ prompt: "echo ok" })).resolves.toMatchObject({ text: "done" });
      expect(wire.modelRequests).toHaveLength(2);
      expect(new URL(wire.modelRequests[0]!.url).pathname).toBe(path);
      expect(JSON.stringify(await wire.modelRequests[1]!.clone().json())).toContain("executed:ok");
      const savedRoute = { ...restored, modelProvider: { npm: "@ai-sdk/google", api: "https://saved.test/v1", shape: "interactions" as const } };
      await saveModelConfig({ selectedProviderId: id, profiles: { [id]: savedRoute } }, storage);
      const unavailableCatalog = vi.fn(async () => { throw new Error("offline"); });
      const offlineRestored = selectedModelConfig(await loadModelConfig(undefined, storage, { loadCatalog: unavailableCatalog }))!;
      expect(offlineRestored.modelProvider).toEqual(savedRoute.modelProvider);
      expect(unavailableCatalog).not.toHaveBeenCalled();
      const free = applyModelPreset({ ...restored, model: "free-input-model", modelProvider: { npm: "@ai-sdk/anthropic", api: "https://old.test", shape: "completion" } }, preset);
      expect(free.modelProvider).toEqual(preset.defaultProvider);
      expect(free.sdk).toBe(preset.sdk);
      expect(free.baseURL).toBe(preset.baseURL);
      await saveModelConfig({ selectedProviderId: id, profiles: { [id]: free } }, storage);
      const freeRestored = selectedModelConfig(await loadModelConfig(undefined, storage, { loadCatalog: async () => { throw new Error("offline"); } }))!;
      const freeWire = fixture(protocol, { toolLoop: true });
      const freeModel = await createModel(freeRestored, undefined, undefined, { fetch: freeWire.fetch });
      const freeAgent = new ToolLoopAgent({ model: freeModel, maxRetries: 0, tools: { echo: tool({ description: "Echo", inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => ({ value: `executed:${value}` }) }) } });
      await expect(freeAgent.generate({ prompt: "echo ok" })).resolves.toMatchObject({ text: "done" });
      expect(new URL(freeWire.modelRequests[0]!.url).pathname).toBe(path);
      expect(JSON.stringify(await freeWire.modelRequests[1]!.clone().json())).toContain("executed:ok");
    }
  }
}, 20_000);


it("honors explicit Google generateContent over a catalog interactions route", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
  const model = await createModel({ sdk: "@ai-sdk/google", providerId: "google", model: "test", baseURL: "https://provider.test/v1beta", endpointType: "google-generate-content", modelProvider: { shape: "interactions" }, providerSettings: { apiKey: "fake" } }, undefined, undefined, { fetch });
  await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).resolves.toMatchObject({ text: "done" });
  expect(new URL((fetch.mock.calls[0]![0] as Request).url).pathname).toBe("/v1beta/models/test:generateContent");
});
