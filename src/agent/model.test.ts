import { describe, expect, it, vi } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { createRetryingFetch } from "./model";

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
});
