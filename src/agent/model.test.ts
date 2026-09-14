import { describe, expect, it, vi } from "vitest";
import { EventLogger, MemoryLogStore } from "../logging";
import { createRetryingFetch } from "./model";

describe("createRetryingFetch", () => {
  it("retries recoverable responses without a retry ceiling", async () => {
    let attempts = 0;
    const sleep = vi.fn(async (_delay: number) => undefined);
    const fetch = vi.fn(async () => new Response(attempts++ < 2 ? "busy" : "ok", { status: attempts <= 2 ? 503 : 200 }));
    const store = new MemoryLogStore();
    const logger = new EventLogger({ store });

    const response = await createRetryingFetch({ fetch, sleep, random: () => 0.5, logger })("https://provider.test/v1/chat/completions");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500]);
    await logger.flush();
    expect((await store.all()).map((event) => event.type)).toEqual(["request.retry", "request.retry", "request.completed"]);
  });

  it("stops retrying immediately when the request is aborted", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response("busy", { status: 503 }));
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const store = new MemoryLogStore();
    const logger = new EventLogger({ store });
    const pending = createRetryingFetch({ fetch, sleep, logger })("https://provider.test/v1/chat/completions", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await logger.flush();
    expect((await store.all()).map((event) => event.type)).toEqual(["request.retry", "request.aborted"]);
  });

  it("retries network TypeErrors and replays a Request body", async () => {
    const sleep = vi.fn(async (_delay: number) => undefined);
    const bodies: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!(input instanceof Request)) throw new Error("expected Request");
      bodies.push(await input.text());
      if (bodies.length === 1) throw new TypeError("network down");
      return new Response("ok", { status: 200 });
    });

    const response = await createRetryingFetch({ fetch, sleep, random: () => 0.5 })(
      new Request("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual(["{}", "{}"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
