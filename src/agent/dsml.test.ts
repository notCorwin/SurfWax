import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { EventLogger } from "../logging";
import { dsmlMiddleware } from "./dsml";

const tools = [
  { type: "function", name: "navigate", inputSchema: { type: "object" } },
  { type: "function", name: "inspect_page", inputSchema: { type: "object" } },
  { type: "function", name: "click", inputSchema: { type: "object" } },
] as any;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const v41 = '<｜DSML｜ calls><｜DSML｜ invoke name="navigate"><｜DSML｜ parameter name="url" string="true">https://example.com/</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
const v4 = '<｜DSML｜tool_calls><｜DSML｜invoke name="inspect_page"></｜DSML｜invoke></｜DSML｜tool_calls>';

async function generated(content: any[], logger?: EventLogger) {
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({ doGenerate: async () => ({ content, finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as any }),
    middleware: dsmlMiddleware(logger, "conversation"),
  });
  return model.doGenerate({ prompt: [], tools } as any);
}

describe("DSML model middleware", () => {
  it("rejects duplicate and missing tool call IDs before execution", async () => {
    const call = { type: "tool-call", toolCallId: "same", toolName: "inspect_page", input: "{}", dynamic: true };
    await expect(generated([call, call])).rejects.toMatchObject({ code: "invalid-tool-call-id" });
    await expect(generated([{ ...call, toolCallId: "" }])).rejects.toMatchObject({ code: "invalid-tool-call-id" });
  });
  it("recovers V4.1 and legacy V4 calls from complete responses", async () => {
    const multiple = v41.replace("</｜DSML｜ calls>", '<｜DSML｜ invoke name="inspect_page"></｜DSML｜ invoke></｜DSML｜ calls>');
    const result = await generated([{ type: "text", text: multiple }]);
    expect(result.content).toMatchObject([
      { type: "tool-call", toolName: "navigate", input: '{"url":"https://example.com/"}', dynamic: true },
      { type: "tool-call", toolName: "inspect_page", input: "{}", dynamic: true },
    ]);
    expect(result.finishReason.unified).toBe("tool-calls");

    const legacy = await generated([{ type: "text", text: v4 }]);
    expect(legacy.content).toMatchObject([{ type: "tool-call", toolName: "inspect_page", input: "{}" }]);
  });

  it("preserves normal text and gives native tool calls precedence", async () => {
    const normal = await generated([{ type: "text", text: "normal answer" }]);
    expect(normal.content).toEqual([{ type: "text", text: "normal answer" }]);

    const native = await generated([
      { type: "text", text: v41 },
      { type: "tool-call", toolCallId: "native", toolName: "inspect_page", input: "{}", dynamic: true },
    ]);
    expect(native.content).toMatchObject([{ type: "tool-call", toolCallId: "native" }]);
  });

  it("validates and recovers atomic tool calls with structured targets", async () => {
    const text = '<｜DSML｜ calls><｜DSML｜ invoke name="click"><｜DSML｜ parameter name="target" string="false">{"by":"role","value":"button","name":"Save"}</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    const result = await generated([{ type: "text", text }]);
    expect(result.content).toMatchObject([{ type: "tool-call", toolName: "click", input: '{"target":{"by":"role","value":"button","name":"Save"}}' }]);
  });

  it.each([
    ["unknown tool", v41.replace('name="navigate"', 'name="invented"')],
    ["invalid arguments", v41.replace('name="url"', 'name="wrong"')],
    ["incomplete markup", v41.slice(0, -16)],
    ["invalid opener", v41.replace('<｜DSML｜ calls>', '<｜DSML｜ unknown>')],
    ["duplicate parameter", v41.replace('</｜DSML｜ invoke>', '<｜DSML｜ parameter name="url" string="true">return 2;</｜DSML｜ parameter></｜DSML｜ invoke>')],
    ["removed legacy tool", v41.replace('name="navigate"', 'name="run-code"')],
  ])("rejects %s before execution and makes the response repairable", async (_label, text) => {
    const telemetry = vi.fn();
    await expect(generated([{ type: "text", text }], { telemetry } as unknown as EventLogger)).rejects.toMatchObject({
      code: "dsml-tool-protocol", toolProtocolRepair: { responseText: text },
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ type: "model.dsml.recovery", content: expect.objectContaining({ recovered: false }) }));
  });

  it("recovers registered completion tools and rejects truncated DSML before dispatch", async () => {
    const content = '<｜DSML｜ calls><｜DSML｜ invoke name="complete_goal"><｜DSML｜ parameter name="summary" string="true">Done</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    const schema = { parse: (input: unknown) => input };
    for (const reason of ["stop", "length"] as const) {
      const model = wrapLanguageModel({
        model: new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: content }], finishReason: { unified: reason, raw: reason }, usage, warnings: [] }) }),
        middleware: dsmlMiddleware(undefined, undefined, { complete_goal: schema }),
      });
      const request = model.doGenerate({ prompt: [], tools: [{ type: "function", name: "complete_goal", inputSchema: { type: "object" } }] });
      if (reason === "stop") expect((await request).content).toMatchObject([{ type: "tool-call", toolName: "complete_goal", input: '{"summary":"Done"}' }]);
      else await expect(request).rejects.toMatchObject({ code: "dsml-tool-protocol" });
    }
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
