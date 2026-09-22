import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ChromeExecutor } from "../chrome/executor";
import { COMMAND_NAMES, TOOL_SUMMARY } from "../chrome/tool";
import { createAgent, DEFAULT_INSTRUCTIONS, stagnationReason } from "./runner";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

describe("createAgent", () => {
  it("includes every tool description in the default instructions", () => {
    expect(DEFAULT_INSTRUCTIONS).toContain(TOOL_SUMMARY);
    expect(DEFAULT_INSTRUCTIONS).not.toContain("search-tools");
  });

  it("detects repeated failures and read-only loops without stopping repeatable input", () => {
    const step = (toolName: string, output: unknown) => ({ toolResults: [{ toolName, input: {}, output }] });
    expect(stagnationReason([step("click", { ok: false, error: { code: "x" } }), step("click", { ok: false, error: { code: "x" } })])).toBe("repeated-failure");
    expect(stagnationReason([step("snapshot", { text: "same" }), step("snapshot", { text: "same" }), step("snapshot", { text: "same" })])).toBe("repeated-read");
    expect(stagnationReason([step("press", { ok: true }), step("press", { ok: true }), step("press", { ok: true })])).toBeUndefined();
  });

  it("executes a dedicated command tool without adding a model turn", async () => {
    let step = 0;
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    const record = vi.fn();
    const executor = {
      executeCommand: vi.fn(async () => ({ ok: true })),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [
        { index: 0, current: true, title: "Current page", url: "https://example.com/current" },
        { index: 1, current: false, title: "Other page", url: "https://example.com/other" },
      ] })),
    } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        systemPrompts.push((options.prompt.find((message) => message.role === "system") as any)?.content ?? "");
        step += 1;
        return { stream: simulateReadableStream({ chunks: step === 1 ? [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "call-1", toolName: "goto", dynamic: true, input: JSON.stringify({ url: "https://example.com" }) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage() },
        ] : [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "done" }, { type: "text-end" as const, id: "text" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
        ] as any[] }) };
      },
    });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", apiKey: "key", model: "test" }, languageModel: model, executor, instructions: "Custom guidance.", logger: { record } as any }).stream({ prompt: [{ role: "user", content: "go" }] });
    for await (const _ of result.stream) {
      // Consume the stream so the agent can execute the repaired tool call.
    }
    expect(step).toBe(2);
    expect(prompts[0]).toContain("<browser-context>");
    expect(prompts[0]).toContain("Current page");
    expect(prompts[0]).toContain("Other page");
    expect(prompts[0]).toContain('current\\\":true');
    expect(systemPrompts[0]).toContain("Custom guidance.");
    expect(systemPrompts[0]).toContain(TOOL_SUMMARY);
    expect(prompts[0]).not.toContain('"type":"file"');
    expect(executor.executeCommand).toHaveBeenCalledWith("goto", { url: "https://example.com" }, undefined, expect.any(Object));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "model.started", content: expect.objectContaining({ activeTools: [...COMMAND_NAMES, "act", "result"], toolCount: 78 }),
    }));
    expect(await result.text).toBe("done");
  }, 10_000);

  it("exposes an advanced tool on the first step", async () => {
    let step = 0;
    const executor = {
      executeCommand: vi.fn(async () => [{ name: "session" }]),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [{ index: 0, current: true, title: "test", url: "https://example.com" }] })),
    } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      const names = (options.tools as any[]).map((tool) => tool.name);
      step += 1;
      expect(names).toHaveLength(78);
      expect(names).toContain("cookie-list");
      expect(names).not.toContain("search-tools");
      const chunks = step === 1
        ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "cookies", toolName: "cookie-list", dynamic: true, input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() }]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() }];
      return { stream: simulateReadableStream({ chunks: chunks as any[] }) };
    } });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", model: "test" }, languageModel: model, executor }).stream({ prompt: "cookies" });
    for await (const _ of result.stream) { /* consume */ }
    expect(step).toBe(2);
    expect(executor.executeCommand).toHaveBeenCalledWith("cookie-list", {}, undefined, expect.any(Object));
  }, 10_000);

  it("continues beyond twenty tool calls until natural completion", async () => {
    let step = 0;
    let toolResult = 0;
    const executor = {
      executeCommand: vi.fn(async () => [{ id: ++toolResult, title: "test" }]),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [{ index: 0, current: true, title: "test", url: "https://example.com" }] })),
    } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        expect(options.reasoning).toBeUndefined();
        expect((options.tools as any[])).toHaveLength(78);
        expect((options.tools as any[]).map((tool) => tool.name)).toEqual(expect.arrayContaining(["cookie-list", "act", "result"]));
        expect((options.tools as any[]).map((tool) => tool.name)).not.toContain("search-tools");
        expect((options.tools as any[]).map((tool) => tool.name)).not.toContain("browser");
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
            { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: "tab-list", dynamic: true, input: "{}" },
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
    expect(executor.executeCommand).toHaveBeenCalledTimes(25);
    expect(await result.finishReason).toBe("stop");
  }, 90_000);
});
