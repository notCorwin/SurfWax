import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { JevConfig } from "../types";
import { JEV_MAX_BATCH_MESSAGES, JevSelector } from "./jev";

const config: JevConfig = { provider: "typesafe", baseURL: "https://api.typesafe.ai", apiKey: "secret", model: "jev-latest", threshold: 0.5 };
const context: ModelMessage[] = [{ role: "user", content: "The whole conversation, including all constraints" }];
const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({
  index, message: { role: "assistant", content: `message ${index}` } as ModelMessage,
}));
const response = (ids = ["m0"]) => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.75 }])),
  usage: { input_tokens: 2, output_tokens: 1 },
});

async function requestOf(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input.clone() : new Request(input, init);
  return { url: request.url, headers: request.headers, body: await request.json() as any };
}

describe("Jev selector", () => {
  it("scores up to 255 messages together and repeats the same full context in every batch", async () => {
    const requests: Array<{ context: readonly ModelMessage[]; candidates: readonly { index: number }[] }> = [];
    const evaluate = vi.fn(async (batchContext: readonly ModelMessage[], batchCandidates: readonly { index: number }[]) => {
      requests.push({ context: batchContext, candidates: batchCandidates });
      return response(batchCandidates.map(({ index }) => `m${index}`));
    });
    const result = await new JevSelector(config, { evaluate })
      .score(context, candidates(JEV_MAX_BATCH_MESSAGES + 1), new AbortController().signal);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(requests[0]!.candidates).toHaveLength(JEV_MAX_BATCH_MESSAGES);
    expect(requests[0]!.context).toBe(requests[1]!.context);
    expect(JSON.stringify(requests[0]!.context)).toContain("all constraints");
    expect(result.probabilities.size).toBe(JEV_MAX_BATCH_MESSAGES + 1);
    expect(result.usage.input_tokens).toBe(4);
  });

  it("rejects missing or invalid probabilities instead of dropping messages", async () => {
    for (const value of [undefined, Number.NaN, -0.1, 1.1]) {
      const answers: Record<string, { noul: number }> = {};
      if (value !== undefined) answers.m0 = { noul: value };
      const evaluate = vi.fn(async () => ({ model: "jev-1", answers, usage: { input_tokens: 1, output_tokens: 0 } }));
      await expect(new JevSelector(config, { evaluate }).score(context, candidates(1), new AbortController().signal))
        .rejects.toThrow("invalid score");
    }
  });

  it.each([
    ["typesafe", "https://api.typesafe.ai", "jev-latest", "https://api.typesafe.ai/v1/systemone"],
    ["litellm", "https://litellm.test/typesafe", "jev-latest", "https://litellm.test/typesafe/v1/systemone"],
    ["opper", "https://api.opper.ai/v3/compat", "typesafe/jev-1.13.0", "https://api.opper.ai/v3/compat/v1/systemone"],
    ["custom-systemone", "https://custom.test", "jev-custom", "https://custom.test/v1/systemone"],
    ["openrouter", "https://openrouter.ai/api", "typesafe/jev-1.13", "https://openrouter.ai/api/alpha/decisions"],
    ["aimlapi", "https://api.aimlapi.com", "typesafe/jev", "https://api.aimlapi.com/v1/decisions"],
    ["custom-decisions", "https://custom.test", "jev-custom", "https://custom.test/v1/decisions"],
  ] as const)("routes %s through its documented endpoint", async (provider, baseURL, model, endpoint) => {
    const requests: Awaited<ReturnType<typeof requestOf>>[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await requestOf(input, init));
      return new Response(JSON.stringify(response()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const selector = new JevSelector({ provider, baseURL, model, apiKey: "secret", threshold: 0.5 }, { fetch });
    expect((await selector.score(context, candidates(1), new AbortController().signal)).probabilities.get(0)).toBe(0.75);
    expect(requests[0]!.url).toBe(endpoint);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0]!.body.model).toBe(model);
    expect(requests[0]!.body.questions.m0.type).toBe("noul");
  });

  it("uses Cloudflare's input envelope", async () => {
    let request: Awaited<ReturnType<typeof requestOf>> | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = await requestOf(input, init);
      return new Response(JSON.stringify(response()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const selector = new JevSelector({ provider: "cloudflare", baseURL: "https://api.cloudflare.com/client/v4/accounts/account/ai",
      model: "typesafe/jev", apiKey: "secret", threshold: 0.5 }, { fetch });
    await selector.score(context, candidates(1), new AbortController().signal);
    expect(request?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/run");
    expect(request?.body).toMatchObject({ model: "typesafe/jev", input: { questions: { m0: { type: "noul" } } } });
    expect(request?.body.questions).toBeUndefined();
  });

  it("uses Vercel's Evaluation API and normalizes boolean answers", async () => {
    let request: Awaited<ReturnType<typeof requestOf>> | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = await requestOf(input, init);
      return new Response(JSON.stringify({ answers: { m0: { type: "boolean", probability: 0.8 } },
        usage: { inputTokens: 3, outputTokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const selector = new JevSelector({ provider: "vercel", baseURL: "https://ai-gateway.vercel.sh/v4/ai",
      model: "typesafe-ai/jev", apiKey: "secret", threshold: 0.5 }, { fetch });
    const result = await selector.score(context, candidates(1), new AbortController().signal);
    expect(request?.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    expect(request?.headers.get("ai-model-id")).toBe("typesafe-ai/jev");
    expect(request?.body.questions.m0.type).toBe("boolean");
    expect(result.probabilities.get(0)).toBe(0.8);
    expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
  });

  it("rejects malformed provider responses and honors abort", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ model: "jev", answers: {}, usage: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await expect(new JevSelector({ ...config, provider: "openrouter", baseURL: "https://openrouter.ai/api" }, { fetch })
      .score(context, candidates(1), new AbortController().signal)).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(new JevSelector(config, { fetch }).score(context, candidates(1), aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the shared retrying fetch for recoverable responses", async () => {
    let attempts = 0;
    const fetch = vi.fn(async () => new Response(
      ++attempts === 1 ? "busy" : JSON.stringify(response()),
      { status: attempts === 1 ? 503 : 200, headers: { "content-type": "application/json" } },
    ));
    const selector = new JevSelector({ ...config, provider: "openrouter", baseURL: "https://openrouter.ai/api" }, { fetch });
    await expect(selector.score(context, candidates(1), new AbortController().signal))
      .resolves.toMatchObject({ batches: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
