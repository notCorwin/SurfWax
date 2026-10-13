import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { EventLogger } from "../logging";
import { dsmlMiddleware } from "./dsml";

const tools = [
  { type: "function", name: "run", inputSchema: { type: "object" } },
  { type: "function", name: "inspect", inputSchema: { type: "object" } },
] as any;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const v41 = '<｜DSML｜ calls><｜DSML｜ invoke name="run"><｜DSML｜ parameter name="code" string="true">await page.mouse.wheel(0,600);</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
const v4 = '<｜DSML｜tool_calls><｜DSML｜invoke name="inspect"></｜DSML｜invoke></｜DSML｜tool_calls>';

async function streamed(chunks: any[], logger?: EventLogger) {
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) }),
    middleware: dsmlMiddleware(logger, "conversation"),
  });
  const result = await model.doStream({ prompt: [], tools } as any);
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

describe("DSML model middleware", () => {
  it("recovers split V4.1 calls and multiple V4 calls without emitting markup", async () => {
    const text = v41.replace('</｜DSML｜ calls>', `${'<｜DSML｜ invoke name="inspect"></｜DSML｜ invoke>'}</｜DSML｜ calls>`);
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text" },
      ...[text.slice(0, 4), text.slice(4, 33), text.slice(33)].map((delta) => ({ type: "text-delta", id: "text", delta })),
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
    const parts = await streamed(chunks);
    expect(parts.filter((part) => part.type === "tool-call")).toMatchObject([
      { toolName: "run", input: '{"code":"await page.mouse.wheel(0,600);"}' },
      { toolName: "inspect", input: "{}" },
    ]);
    expect(parts.some((part) => part.type === "text-delta")).toBe(false);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });

    const legacy = await streamed([
      { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: v4 }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);
    expect(legacy.filter((part) => part.type === "tool-call")).toMatchObject([{ toolName: "inspect", input: "{}" }]);
  });

  it("keeps ordinary text streaming and gives native tool calls precedence", async () => {
    const normal = await streamed([
      { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "normal answer" }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);
    expect(normal.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    const native = await streamed([
      { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: v41 }, { type: "text-end", id: "text" },
      { type: "tool-call", toolCallId: "native", toolName: "inspect", input: "{}", dynamic: true },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);
    expect(native.filter((part) => part.type === "tool-call")).toMatchObject([{ toolCallId: "native" }]);
    expect(native.some((part) => part.type === "text-delta")).toBe(false);
    const nativeFirst = await streamed([
      { type: "tool-call", toolCallId: "native", toolName: "inspect", input: "{}", dynamic: true },
      { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: v41 }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);
    expect(nativeFirst.filter((part) => part.type === "tool-call")).toMatchObject([{ toolCallId: "native" }]);
    expect(nativeFirst.some((part) => part.type === "text-delta")).toBe(false);
  });

  it.each([
    ["unknown tool", v41.replace('name="run"', 'name="invented"')],
    ["invalid arguments", v41.replace('name="code"', 'name="wrong"')],
    ["incomplete markup", v41.slice(0, -16)],
    ["invalid opener", v41.replace('<｜DSML｜ calls>', '<｜DSML｜ unknown>')],
    ["duplicate parameter", v41.replace('</｜DSML｜ invoke>', '<｜DSML｜ parameter name="code" string="true">return 2;</｜DSML｜ parameter></｜DSML｜ invoke>')],
    ["removed legacy tool", v41.replace('name="run"', 'name="run-code"')],
  ])("preserves %s without executing it", async (_label, text) => {
    const record = vi.fn();
    const parts = await streamed([
      { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: text }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ], { record } as unknown as EventLogger);
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")).toBe(text);
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "model.dsml.recovery", content: expect.objectContaining({ recovered: false }) }));
  });

  it("recovers generate responses and propagates stream cancellation", async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: v41 }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as any }),
      middleware: dsmlMiddleware(),
    });
    const generated = await model.doGenerate({ prompt: [], tools } as any);
    expect(generated.content).toMatchObject([{ type: "tool-call", toolName: "run", input: '{"code":"await page.mouse.wheel(0,600);"}' }]);
    expect(generated.finishReason.unified).toBe("tool-calls");
    const native = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: async () => ({ content: [
        { type: "text", text: v41 }, { type: "tool-call", toolCallId: "native", toolName: "inspect", input: "{}", dynamic: true },
      ], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] }) as any }),
      middleware: dsmlMiddleware(),
    });
    expect((await native.doGenerate({ prompt: [], tools } as any)).content).toMatchObject([{ type: "tool-call", toolCallId: "native" }]);

    const cancel = vi.fn();
    const streaming = wrapLanguageModel({
      model: new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
        start(controller) { controller.enqueue({ type: "stream-start", warnings: [] }); },
        cancel,
      }) }) }),
      middleware: dsmlMiddleware(),
    });
    const reader = (await streaming.doStream({ prompt: [], tools } as any)).stream.getReader();
    await reader.read();
    await reader.cancel("stop");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
