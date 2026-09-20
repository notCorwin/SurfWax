import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ChromeExecutor } from "../chrome/executor";
import { createAgent } from "./runner";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

describe("createAgent", () => {
  it("repairs stringified act steps without adding a model turn", async () => {
    let step = 0;
    const executor = { executeBrowser: vi.fn(async () => ({ ok: true })) } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1;
        return { stream: simulateReadableStream({ chunks: step === 1 ? [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "call-1", toolName: "browser", dynamic: true, input: JSON.stringify({ mode: "act", steps: JSON.stringify([{ type: "goto", url: "https://example.com" }]) }) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage() },
        ] : [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "done" }, { type: "text-end" as const, id: "text" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
        ] as any[] }) };
      },
    });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", apiKey: "key", model: "test" }, languageModel: model, executor }).stream({ prompt: [{ role: "user", content: "go" }] });
    for await (const _ of result.stream) {
      // Consume the stream so the agent can execute the repaired tool call.
    }
    expect(step).toBe(2);
    expect(executor.executeBrowser).toHaveBeenCalledWith({ mode: "act", steps: [{ type: "goto", url: "https://example.com" }] }, undefined, expect.any(Object));
    expect(await result.text).toBe("done");
  });

  it("continues beyond twenty tool calls until natural completion", async () => {
    let step = 0;
    const executor = { executeBrowser: vi.fn(async () => [{ id: 1, title: "test" }]) } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        expect(options.reasoning).toBe("minimal");
        expect((options.tools as any[]).map((tool) => tool.name)).toEqual(["browser"]);
        step += 1;
        const chunks = step > 25
          ? [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "text" },
            { type: "text-delta" as const, id: "text", delta: "finished" },
            { type: "text-end" as const, id: "text" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
          ]
          : [
            { type: "stream-start" as const, warnings: [] },
            { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: "browser", dynamic: true, input: JSON.stringify({ mode: "run", code: "return await chrome.tabs.query({});" }) },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage() },
          ];
        return { stream: simulateReadableStream({ chunks: chunks as any[] }) };
      },
    });
    const agent = createAgent({
      model: { baseURL: "https://example.com/v1", apiKey: "key", model: "test" },
      languageModel: model,
      executor,
    });
    const result = await agent.stream({ prompt: [{ role: "user", content: "inspect" }] });
    let toolResults = 0;
    for await (const part of result.stream) if (part.type === "tool-result") toolResults += 1;

    expect(step).toBe(26);
    expect(toolResults).toBe(25);
    expect(executor.executeBrowser).toHaveBeenCalledTimes(25);
    expect(await result.finishReason).toBe("stop");
  });
});
