import { describe, expect, it, vi } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { createRetryingFetch } from "./model";
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

  it("starts at none, learns only from explicit rejection, and logs the effective effort", async () => {
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
    expect(attempts).toEqual(["none", "low", "low"]);
    expect(settings.snapshot()).toMatchObject({ selected: "low", choices: ["low", "high"] });
    await logger.flush();
    expect(events.find((event) => event.type === "request.retry")?.content).toMatchObject({ rejectedReasoningEffort: "none", reasoningEffort: "low" });
    expect(events.find((event) => event.type === "request.completed")?.content).toMatchObject({ reasoningEffort: "low" });
  });
});
