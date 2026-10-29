import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import { createModel } from "./model";

const config: ModelConfig = { providerId: "custom", sdk: "@ai-sdk/openai", endpointType: "openai-completions",
  model: "test", baseURL: "https://provider.test/v1", apiKey: "test-key" };
const intended = "log starts\nuser: account=42\nlog ends";

function reply(text: string) {
  return Response.json({ id: "completion", object: "text_completion", created: 1, model: "test",
    choices: [{ index: 0, text, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

function provider() {
  const requests: Request[] = [];
  const bodies: any[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const body = await request.clone().json();
    bodies.push(body);
    let end = intended.length;
    for (const stop of body.stop ?? []) {
      const index = intended.indexOf(stop);
      if (index >= 0 && index < end) end = index;
    }
    return reply(intended.slice(0, end));
  });
  return { fetch, requests, bodies };
}

describe("OpenAI text completions stop sequences", () => {
  it.each([false, true])("does not silently truncate a normal reply at the SDK role marker (catalog shape=%s)", async (shape) => {
    const wire = provider();
    const options = shape ? { ...config, endpointType: undefined, modelProvider: { shape: "completion" as const } } : config;
    const model = await createModel(options, undefined, undefined, { fetch: wire.fetch });
    expect((await generateText({ model, prompt: "Return the complete log", maxRetries: 0 })).text).toBe(intended);
    expect(wire.bodies[0]).not.toHaveProperty("stop");
    expect(wire.requests[0]!.url).toBe("https://provider.test/v1/completions");
    expect(wire.requests[0]!.headers.get("authorization")).toBe("Bearer test-key");
  });

  it("preserves explicitly requested stops, even when one equals the SDK marker", async () => {
    const wire = provider();
    const model = await createModel(config, undefined, undefined, { fetch: wire.fetch });
    const result = await generateText({ model, prompt: "Return the log", stopSequences: ["\nuser:", "other-stop"], maxRetries: 0 });
    expect(wire.bodies[0].stop).toEqual(["\nuser:", "other-stop"]);
    expect(result.text).toBe("log starts");
  });

  it("retains provider-configured stop defaults while explicit call stops take precedence", async () => {
    const wire = provider();
    const model = await createModel({ ...config, modelProvider: { body: { stop: ["log ends"] } } }, undefined, undefined, { fetch: wire.fetch });
    expect((await generateText({ model, prompt: "hello", maxRetries: 0 })).text).toBe("log starts\nuser: account=42\n");
    expect(wire.bodies[0].stop).toEqual(["log ends"]);
    await generateText({ model, prompt: "hello", stopSequences: ["\nuser:"], maxRetries: 0 });
    expect(wire.bodies[1].stop).toEqual(["\nuser:"]);
  });

  it("retries the same sanitized request without dropping headers or explicit stops", async () => {
    const seen: Array<{ body: any; authorization: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({ body: await request.clone().json(), authorization: request.headers.get("authorization") });
      return seen.length === 1 ? Response.json({ error: { message: "retry" } }, { status: 429, headers: { "retry-after": "0" } }) : reply("done");
    });
    const model = await createModel(config, undefined, undefined, { fetch });
    expect((await generateText({ model, prompt: "hello", stopSequences: ["END"], maxRetries: 0 })).text).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toMatchObject({ authorization: "Bearer test-key", body: { stop: ["END"] } });
  });

  it("propagates cancellation to a pending sanitized request", async () => {
    const controller = new AbortController();
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    let actualSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      actualSignal = request.signal;
      notify();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    });
    const model = await createModel(config, undefined, undefined, { fetch });
    const pending = generateText({ model, prompt: "hello", abortSignal: controller.signal, maxRetries: 0 });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(actualSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not remove an explicit stop from a chat completion request", async () => {
    const requests: any[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(await request.clone().json());
      return Response.json({ id: "chat", object: "chat.completion", created: 1, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    const model = await createModel({ ...config, endpointType: "openai-chat-completions" }, undefined, undefined, { fetch });
    await generateText({ model, prompt: "hello", stopSequences: ["\nuser:"], maxRetries: 0 });
    expect(requests[0].stop).toEqual(["\nuser:"]);
  });
});
