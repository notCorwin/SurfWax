import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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

async function generated(content: any[], logger?: EventLogger) {
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({ doGenerate: async () => ({ content, finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as any }),
    middleware: dsmlMiddleware(logger, "conversation"),
  });
  return model.doGenerate({ prompt: [], tools } as any);
}

describe("DSML model middleware", () => {
  it("recovers V4.1 and legacy V4 calls from complete responses", async () => {
    const multiple = v41.replace("</｜DSML｜ calls>", '<｜DSML｜ invoke name="inspect"></｜DSML｜ invoke></｜DSML｜ calls>');
    const result = await generated([{ type: "text", text: multiple }]);
    expect(result.content).toMatchObject([
      { type: "tool-call", toolName: "run", input: '{"code":"await page.mouse.wheel(0,600);"}', dynamic: true },
      { type: "tool-call", toolName: "inspect", input: "{}", dynamic: true },
    ]);
    expect(result.finishReason.unified).toBe("tool-calls");

    const legacy = await generated([{ type: "text", text: v4 }]);
    expect(legacy.content).toMatchObject([{ type: "tool-call", toolName: "inspect", input: "{}" }]);
  });

  it("preserves normal text and gives native tool calls precedence", async () => {
    const normal = await generated([{ type: "text", text: "normal answer" }]);
    expect(normal.content).toEqual([{ type: "text", text: "normal answer" }]);

    const native = await generated([
      { type: "text", text: v41 },
      { type: "tool-call", toolCallId: "native", toolName: "inspect", input: "{}", dynamic: true },
    ]);
    expect(native.content).toMatchObject([{ type: "tool-call", toolCallId: "native" }]);
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
    const result = await generated([{ type: "text", text }], { record } as unknown as EventLogger);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "model.dsml.recovery", content: expect.objectContaining({ recovered: false }) }));
  });

  it("does not recover calls excluded by tool choice or without active function tools", async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: v41 }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as any }),
      middleware: dsmlMiddleware(),
    });
    const none = await model.doGenerate({ prompt: [], tools, toolChoice: { type: "none" } } as any);
    expect(none.content).toEqual([{ type: "text", text: v41 }]);
    const noTools = await model.doGenerate({ prompt: [], tools: [] } as any);
    expect(noTools.content).toEqual([{ type: "text", text: v41 }]);
  });
});
