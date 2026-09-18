import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { JEV_MAX_BATCH_MESSAGES, JevSelector } from "./jev";

const config = { baseURL: "https://api.typesafe.ai", apiKey: "secret", model: "jev-latest", threshold: 0.5 };
const context: ModelMessage[] = [{ role: "user", content: "The whole conversation, including all constraints" }];
const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({
  index, message: { role: "assistant", content: `message ${index}` } as ModelMessage,
}));

describe("Jev selector", () => {
  it("scores up to 255 messages together and repeats the same full context in every batch", async () => {
    const requests: any[] = [];
    const systemOne = vi.fn(async (request: any) => {
      requests.push(request);
      return { model: "jev-1", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { noul: 0.75 }])),
        usage: { input_tokens: 10, output_tokens: 0 } };
    });
    const result = await new JevSelector(config, { client: { systemOne } as any })
      .score(context, candidates(JEV_MAX_BATCH_MESSAGES + 1), new AbortController().signal);
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(Object.keys(requests[0].questions)).toHaveLength(JEV_MAX_BATCH_MESSAGES);
    expect(requests[0].state).toEqual(requests[1].state);
    expect(requests[0].state.conversation).toContain("all constraints");
    expect(result.probabilities.size).toBe(JEV_MAX_BATCH_MESSAGES + 1);
    expect(result.usage.input_tokens).toBe(20);
  });

  it("rejects missing or invalid probabilities instead of dropping messages", async () => {
    const invalid = [undefined, Number.NaN, -0.1, 1.1];
    for (const value of invalid) {
      const systemOne = vi.fn(async () => ({ model: "jev-1", answers: value === undefined ? {} : { m0: { noul: value } },
        usage: { input_tokens: 1, output_tokens: 0 } }));
      await expect(new JevSelector(config, { client: { systemOne } as any })
        .score(context, candidates(1), new AbortController().signal)).rejects.toThrow("invalid score");
    }
  });

  it("uses the SDK request and honors abort", async () => {
    const fetch = vi.fn(async (input: Request | string, init?: RequestInit) => {
      expect(typeof input === "string" ? input : input.url).toBe("https://api.typesafe.ai/v1/systemone");
      const body = JSON.parse(String(init?.body ?? (typeof input === "string" ? "" : await input.clone().text())));
      expect(body.questions.m0.type).toBe("noul");
      return new Response(JSON.stringify({ model: "jev-latest", answers: { m0: { type: "noul", noul: 0.75 } },
        usage: { input_tokens: 2, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const selector = new JevSelector(config, { fetch: fetch as typeof globalThis.fetch });
    expect((await selector.score(context, candidates(1), new AbortController().signal)).probabilities.get(0)).toBe(0.75);
    const aborted = new AbortController();
    aborted.abort();
    await expect(selector.score(context, candidates(1), aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
