import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { JEV_MAX_BATCH_MESSAGES, JEV_MESSAGE_PREVIEW_CHARS, JevSelector } from "./jev";

const config = { baseURL: "https://api.typesafe.ai", apiKey: "secret", model: "jev-latest" };

function candidates(count: number, text = "message") {
  return Array.from({ length: count }, (_, index) => ({
    index,
    message: { role: "user", content: `${text} ${index}` } as ModelMessage,
  }));
}

describe("Jev selector", () => {
  it("sends typed Noul questions in bounded batches and returns probabilities", async () => {
    const calls: Array<{ request: any; options: any }> = [];
    const systemOne = vi.fn(async (request: any, options: any) => {
      calls.push({ request, options });
      return {
        model: "jev-1.13.0",
        answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: key === "m0" ? 0.9 : 0.1 }])),
        usage: { input_tokens: 10, output_tokens: 0 },
      };
    });
    const selector = new JevSelector(config, { client: { systemOne } as any });
    const input = candidates(JEV_MAX_BATCH_MESSAGES + 1);

    const result = await selector.score("Continue the browser task", input, new AbortController().signal);

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(calls[0]?.request.state.messages).toHaveLength(JEV_MAX_BATCH_MESSAGES);
    expect(calls[0]?.request.questions.m0).toMatchObject({ type: "noul" });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 0 });
    expect(result.probabilities.get(0)).toBe(0.9);
    expect(result.probabilities.get(JEV_MAX_BATCH_MESSAGES)).toBe(0.1);
  });

  it("keeps both ends of a long message preview", async () => {
    const systemOne = vi.fn(async (request: any) => ({
      model: "jev-latest",
      answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.5 }])),
      usage: { input_tokens: 1, output_tokens: 0 },
    }));
    const selector = new JevSelector(config, { client: { systemOne } as any });
    const long = "START-" + "a".repeat(2_500) + "b".repeat(2_500) + "-END";

    await selector.score("task", [{ index: 0, message: { role: "user", content: long } }], new AbortController().signal);

    const content = systemOne.mock.calls[0]?.[0].state.messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(JEV_MESSAGE_PREVIEW_CHARS + "\n[…truncated…]\n".length);
    expect(content.startsWith("START-")).toBe(true);
    expect(content.endsWith("-END")).toBe(true);
    expect(content).toContain("[…truncated…]");
  });

  it("posts the System One request through the SDK", async () => {
    const fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
      expect(typeof input === "string" ? input : input.url).toBe("https://api.typesafe.ai/v1/systemone");
      const requestBody = init?.body ?? (typeof input === "string" ? undefined : await input.clone().text());
      const body = JSON.parse(String(requestBody)) as { model: string; state: { task: string }; questions: Record<string, { type: string }> };
      expect(body.model).toBe("jev-latest");
      expect(body.state.task).toBe("task");
      expect(body.questions.m0).toMatchObject({ type: "noul" });
      return new Response(JSON.stringify({ model: "jev-latest", answers: { m0: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 2, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const selector = new JevSelector(config, { fetch: fetch as typeof globalThis.fetch });

    await expect(selector.score("task", candidates(1), new AbortController().signal)).resolves.toMatchObject({
      probabilities: new Map([[0, 0.75]]),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors abort before making a request", async () => {
    const systemOne = vi.fn();
    const selector = new JevSelector(config, { client: { systemOne } as any });
    const controller = new AbortController();
    controller.abort();

    await expect(selector.score("task", candidates(1), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(systemOne).not.toHaveBeenCalled();
  });
});
