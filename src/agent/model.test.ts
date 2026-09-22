import { describe, expect, it, vi } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { createModel, createRetryingFetch, gitlabProtocolFetch, sapProtocolFetch, watsonxProtocolFetch } from "./model";
import { ReasoningSettings } from "./reasoning";

function loggerWithEvents() {
  const events: LogEvent[] = [];
  const store = {
    async append(event: Omit<LogEvent, "id">) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  };
  return { events, logger: new EventLogger({ store }) };
}

describe("createRetryingFetch", () => {
  it("creates gateway and OpenAI-compatible models through their native providers", async () => {
    expect(((await createModel({ providerId: "vercel", transport: "gateway", baseURL: "", apiKey: "key", model: "openai/gpt-5" })) as unknown as { provider: string }).provider)
      .toContain("gateway");
    expect(((await createModel({ providerId: "custom", transport: "openai-compatible", baseURL: "https://provider.test/v1", apiKey: "key", model: "test" })) as unknown as { provider: string }).provider)
      .toContain("custom");
  });

  it("configures the Cloudflare Workers AI endpoint and gateway header", async () => {
    let options: Record<string, any> = {};
    const languageModel = { specificationVersion: "v3", provider: "test", modelId: "test" } as any;
    await createModel({ sdk: "ai-gateway-provider", providerId: "cloudflare-ai-gateway", baseURL: "", model: "author/model",
      providerSettings: { apiKey: "token", accountId: "account", gatewayId: "gateway" } }, undefined, undefined, {
      loaders: { "ai-gateway-provider": async () => ({ createOpenAICompatible(value: Record<string, any>) {
        options = value; return { languageModel: () => languageModel };
      } }) },
    });
    expect(options.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/v1");
    expect(options.headers).toEqual({ "cf-aig-gateway-id": "gateway" });
  });

  it("adapts Watsonx IAM and chat streaming requests", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      if (request.url.includes("iam.cloud.ibm.com")) return new Response(JSON.stringify({ access_token: "iam-token", expires_in: 3600 }));
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    const adapter = watsonxProtocolFetch({ sdk: "watsonx-ai-provider", baseURL: "", model: "ibm/granite",
      providerSettings: { apiKey: "key", projectId: "project" } }, fetch);
    await adapter(new Request("https://watsonx.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "ibm/granite", messages: [], stream: true }) }));
    expect(calls[1]?.url).toBe("https://us-south.ml.cloud.ibm.com/ml/v1/text/chat_stream?version=2026-04-20");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer iam-token");
    await expect(calls[1]?.json()).resolves.toMatchObject({ model_id: "ibm/granite", project_id: "project", messages: [] });
  });

  it("adapts SAP OAuth, Orchestration v2, tools, and streaming output", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      if (request.url.includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "sap-token", expires_in: 3600 }));
      return new Response(JSON.stringify({ final_result: { id: "result", model: "gpt-test", choices: [{ index: 0,
        message: { role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "test", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }), { headers: { "Content-Type": "application/json" } });
    });
    const config = { sdk: "@jerome-benoit/sap-ai-provider-v2" as const, baseURL: "", model: "gpt-test", providerSettings: {
      serviceKeyJson: JSON.stringify({ url: "https://auth.test", clientid: "client", clientsecret: "secret" }), deploymentUrl: "https://orchestration.test", resourceGroup: "rg",
    } };
    const response = await sapProtocolFetch(config, fetch)(new Request("https://sap.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({
      model: "gpt-test", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "test", parameters: {} } }], stream: true,
    }) }));
    expect(calls[1]?.url).toBe("https://orchestration.test/v2/completion");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer sap-token");
    expect(calls[1]?.headers.get("ai-resource-group")).toBe("rg");
    await expect(calls[1]?.json()).resolves.toHaveProperty("config.modules.prompt_templating.prompt.tools");
    expect(await response.text()).toContain('"tool_calls"');
  });

  it("uses GitLab direct access token headers for the model proxy", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      if (request.url.includes("direct_access")) return new Response(JSON.stringify({ token: "direct-token", headers: { "x-gitlab-feature-enabled-by-namespace-ids": "1", "x-api-key": "remove" } }));
      return new Response("ok");
    });
    const adapter = gitlabProtocolFetch({ sdk: "gitlab-ai-provider", baseURL: "", model: "duo-chat-gpt-5-1",
      providerSettings: { apiKey: "gitlab-token", instanceUrl: "https://gitlab.example" } }, fetch);
    expect(adapter.mapping).toEqual({ provider: "openai", model: "gpt-5.1-2025-11-13" });
    await adapter.fetch(new Request("https://cloud.gitlab.com/ai/v1/proxy/openai/v1/chat/completions", { method: "POST", headers: { "x-api-key": "placeholder" }, body: "{}" }));
    expect(calls[0]?.url).toBe("https://gitlab.example/api/v4/ai/third_party_agents/direct_access");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer direct-token");
    expect(calls[1]?.headers.get("x-api-key")).toBeNull();
    expect(calls[1]?.headers.get("x-gitlab-feature-enabled-by-namespace-ids")).toBe("1");
  });

  it("retries recoverable responses without a ceiling and records latency", async () => {
    let attempts = 0;
    const sleep = vi.fn(async (_delay: number) => undefined);
    const fetch = vi.fn(async () => {
      attempts += 1;
      return new Response(attempts < 3 ? "busy" : "ok", { status: attempts < 3 ? 503 : 200 });
    });
    const { events, logger } = loggerWithEvents();

    const response = await createRetryingFetch({ fetch, sleep, random: () => 0.5, logger })("https://provider.test/v1/chat/completions");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500]);
    await logger.flush();
    expect(events.map((event) => event.type)).toEqual(["request.retry", "request.retry", "request.completed"]);
    expect(events.every((event) => typeof event.latencyMs === "number")).toBe(true);
  });

  it("aborts during backoff and retries network TypeErrors with the same Request body", async () => {
    const controller = new AbortController();
    const pending = createRetryingFetch({
      fetch: vi.fn(async () => new Response("busy", { status: 429 })),
      sleep: () => new Promise<void>(() => undefined),
    })("https://provider.test/v1/chat/completions", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const bodies: string[] = [];
    const response = await createRetryingFetch({
      sleep: async () => undefined,
      random: () => 0.5,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (!(input instanceof Request)) throw new Error("expected Request");
        bodies.push(await input.text());
        if (bodies.length === 1) throw new TypeError("network down");
        return new Response("ok");
      }),
    })(new Request("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(bodies).toEqual(["{}", "{}"]);
  });

  it("honors capped Retry-After and fails fast for permanent statuses", async () => {
    const sleep = vi.fn(async () => undefined);
    const responses = [new Response("slow", { status: 429, headers: { "Retry-After": "30" } }), new Response("ok")];
    expect((await createRetryingFetch({ fetch: vi.fn(async () => responses.shift()!), sleep })("https://provider.test")).status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(10_000);

    const permanent = vi.fn(async () => new Response("unsupported", { status: 501 }));
    expect((await createRetryingFetch({ fetch: permanent })("https://provider.test")).status).toBe(501);
    expect(permanent).toHaveBeenCalledOnce();
  });

  it("surfaces repeated ambiguous TypeErrors with provider diagnostics", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(createRetryingFetch({ fetch, sleep: async () => undefined })("https://provider.test"))
      .rejects.toThrow(/CORS policy/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses and remembers the lowest reasoning effort accepted by the endpoint", async () => {
    const efforts: unknown[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const body = await (input as Request).json() as { reasoning_effort?: unknown };
      efforts.push(body.reasoning_effort);
      return body.reasoning_effort === "minimal"
        ? new Response('{"error":"Unsupported value: minimal is not supported. Supported reasoning_effort values: low, medium, high"}', { status: 400 })
        : new Response("ok");
    });
    const retryingFetch = createRetryingFetch({ fetch });
    const request = () => new Request("https://provider.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ reasoning_effort: "minimal" }),
    });

    expect((await retryingFetch(request())).status).toBe(200);
    expect((await retryingFetch(request())).status).toBe(200);
    expect(efforts).toEqual(["minimal", "low", "low"]);
  });

  it("removes an unsupported reasoning parameter without hiding unrelated errors", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const body = await (input as Request).json() as Record<string, unknown>;
      bodies.push(body);
      return "reasoning_effort" in body
        ? new Response('{"error":"Unknown parameter reasoning_effort"}', { status: 400 })
        : new Response("ok");
    });
    const retryingFetch = createRetryingFetch({ fetch });
    const request = new Request("https://provider.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ reasoning_effort: "minimal", messages: [] }),
    });

    expect((await retryingFetch(request)).status).toBe(200);
    expect(bodies).toEqual([
      { reasoning_effort: "minimal", messages: [] },
      { messages: [] },
    ]);

    const unrelatedFetch = vi.fn(async () => new Response('{"error":"bad messages"}', { status: 400 }));
    const unrelated = await createRetryingFetch({ fetch: unrelatedFetch })(request);
    expect(unrelated.status).toBe(400);
    expect(unrelatedFetch).toHaveBeenCalledOnce();
    const mixedError = vi.fn(async () => new Response('{"error":"Invalid messages; reasoning_effort was accepted"}', { status: 400 }));
    expect((await createRetryingFetch({ fetch: mixedError })(request)).status).toBe(400);
    expect(mixedError).toHaveBeenCalledOnce();
  });

  it("uses the provider default when reasoning capability is unknown", async () => {
    const attempts: Array<unknown> = [];
    const settings = new ReasoningSettings({ baseURL: "https://provider.test/v1", model: "test-model", apiKey: "key" }, {
      fetch: vi.fn(async () => new Response("missing", { status: 404 })),
      modelLimit: async () => undefined,
    });
    const { events, logger } = loggerWithEvents();
    const fetch = createRetryingFetch({ reasoningSettings: settings, logger, fetch: vi.fn(async (input: RequestInfo | URL) => {
      const body = await (input as Request).json() as { reasoning_effort?: string };
      attempts.push(body.reasoning_effort);
      return body.reasoning_effort === "none"
        ? new Response('{"error":"Unsupported value: none is not supported. Supported reasoning_effort values: low, high"}', { status: 400 })
        : new Response("ok");
    }) });
    const request = () => new Request("https://provider.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ reasoning_effort: "minimal" }) });
    expect((await fetch(request())).status).toBe(200);
    expect((await fetch(request())).status).toBe(200);
    expect(attempts).toEqual([undefined, undefined]);
    expect(settings.snapshot()).toMatchObject({ selected: null, source: "unknown" });
    await logger.flush();
    expect(events.find((event) => event.type === "request.retry")).toBeUndefined();
    expect(events.find((event) => event.type === "request.completed")?.content).toMatchObject({ reasoningEffort: "provider-default" });
  });
});
