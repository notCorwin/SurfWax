import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChromeExecutor } from "../chrome/executor";
import type { ModelConfig } from "../types";
import { completionToolChoiceMiddleware, completionToolsMiddleware } from "./completion-tools";
import { dsmlMiddleware } from "./dsml";
import { createAgent } from "./runner";

const config: ModelConfig = { providerId: "custom", sdk: "@ai-sdk/openai", endpointType: "openai-completions",
  model: "test", baseURL: "https://provider.test/v1", contextWindowOverride: 256_000, imageInput: "disabled" };
const call = (name: string, args: Record<string, unknown>) => `SURFWAX_TOOL_CALLS:${JSON.stringify([{ name, arguments: args }])}`;
const dsmlCall = (name: string, args: string = "") => `<｜DSML｜ calls><｜DSML｜ invoke name="${name}">${args}</｜DSML｜ invoke></｜DSML｜ calls>`;

function choiceHarness(reply: string) {
  const fetch = vi.fn(async () => Response.json({ id: "completion", object: "text_completion", created: 1, model: "test",
    choices: [{ index: 0, text: reply, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  const model = wrapLanguageModel({ model: createOpenAI({ apiKey: "test", baseURL: config.baseURL, fetch }).completion("test"),
    middleware: [completionToolChoiceMiddleware(), dsmlMiddleware(), completionToolsMiddleware()] });
  const execute = vi.fn(async () => "done");
  const tools = { execute_program: tool({ inputSchema: z.object({ code: z.string().min(1) }), execute }),
    read_api_reference: tool({ inputSchema: z.object({}), execute }) };
  return { model, tools, execute, fetch };
}

function harness(responses: string[], settings: { shape?: boolean; finishReason?: string } = {}) {
  const requests: Array<{ url: string; body: any }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ url: request.url, body: await request.clone().json() });
    const text = responses.shift();
    if (text === undefined) throw new Error("Unexpected completion request");
    return Response.json({ id: "completion", object: "text_completion", created: 1, model: "test",
      choices: [{ index: 0, text, finish_reason: settings.finishReason ?? "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const model = createOpenAI({ apiKey: "test", baseURL: config.baseURL, fetch }).completion("test");
  const runProgram = vi.fn(async () => ({ ok: true, result: "effect completed" }));
  const browserContext = vi.fn(async () => ({ windowId: 7, tabs: [{ current: true, tabId: 41 }] }));
  const executor = { browserContext, runProgram, pendingBackgroundJobs: () => [] } as unknown as ChromeExecutor;
  const modelConfig = settings.shape ? { ...config, endpointType: undefined, modelProvider: { shape: "completion" as const } } : config;
  return { requests, fetch, runProgram, agent: createAgent({ model: modelConfig, languageModel: model, executor }) };
}

describe("text completion browser tool protocol", () => {
  it.each([false, true])("round-trips an actual SDK completion tool call and preserves the prompt prefix (catalog shape=%s)", async (shape) => {
    const h = harness([call("execute_program", { code: "return 2;" }), "finished"], { shape });
    const result = await h.agent.generate({ prompt: "Perform the action" });
    expect(result.text).toBe("finished");
    expect(h.runProgram).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.url).toBe("https://provider.test/v1/completions");
    expect(h.requests[0]!.body.tools).toBeUndefined();
    expect(h.requests[0]!.body.prompt).toContain('"name":"execute_program"');
    expect(h.requests[0]!.body.prompt).toContain('"name":"click"');
    expect(h.requests[0]!.body.prompt).toContain("Text-mode browser tools use JSON Schema draft-07");
    expect(h.requests[1]!.body.prompt).toContain("SURFWAX_TOOL_RESULTS:");
    expect(h.requests[1]!.body.prompt).toContain("effect completed");
    expect(h.requests[1]!.body.prompt.startsWith(h.requests[0]!.body.prompt)).toBe(true);
    const secondPrompt: string = h.requests[1]!.body.prompt;
    const callRecord = JSON.parse(secondPrompt.split("SURFWAX_TOOL_CALLS:").at(-1)!.split("\n")[0]!);
    const results = JSON.parse(secondPrompt.split("SURFWAX_TOOL_RESULTS:").at(-1)!.split("\n")[0]!);
    expect(callRecord).toEqual([{ id: expect.any(String), name: "execute_program", arguments: { code: "return 2;" } }]);
    expect(results).toEqual([{ id: callRecord[0].id, name: "execute_program", output: expect.anything() }]);
  });

  it("rejects malformed or unknown calls before dispatching any effect", async () => {
    for (const output of ["SURFWAX_TOOL_CALLS:[", call("invented", {}),
      'SURFWAX_TOOL_CALLS:[{"name":"execute_program","arguments":{"code":"return 1"}},{"name":"invented","arguments":{}}]']) {
      const h = harness([output]);
      await expect(h.agent.generate({ prompt: "act" })).rejects.toMatchObject({ code: "completion-tool-protocol" });
      expect(h.runProgram).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(1);
    }
  });

  it("passes invalid schema arguments through the SDK as an error result without executing", async () => {
    const h = harness([call("execute_program", {}), "failed safely"]);
    const result = await h.agent.generate({ prompt: "act" });
    expect(result.text).toBe("failed safely");
    expect(h.runProgram).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.body.prompt).toContain("SURFWAX_TOOL_RESULTS:");
    expect(h.requests[1]!.body.prompt).toContain("error");
  });

  it("keeps every prior prompt stable across several tool rounds", async () => {
    const h = harness([call("execute_program", { code: "return 1;" }), call("execute_program", { code: "return 2;" }), "done"]);
    expect((await h.agent.generate({ prompt: "complete both" })).text).toBe("done");
    expect(h.runProgram).toHaveBeenCalledTimes(2);
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1]!.body.prompt.startsWith(h.requests[0]!.body.prompt)).toBe(true);
    expect(h.requests[2]!.body.prompt.startsWith(h.requests[1]!.body.prompt)).toBe(true);
    expect((h.requests[2]!.body.prompt.match(/SURFWAX_TOOL_RESULTS:/g) ?? [])).toHaveLength(2);
  });

  it("does not interpret ordinary JSON as a tool call", async () => {
    const h = harness(['{"name":"execute_program","arguments":{"code":"return 1;"}}']);
    expect((await h.agent.generate({ prompt: "return JSON" })).text).toContain('"name":"execute_program"');
    expect(h.runProgram).not.toHaveBeenCalled();
  });

  it("preserves a fenced literal tool-call example as text without dispatch", async () => {
    const example = `\`\`\`text\n${call("execute_program", { code: "return 1;" })}\n\`\`\``;
    const h = harness([example]);
    expect((await h.agent.generate({ prompt: "Show a literal tool-call example; do not execute it" })).text).toBe(example);
    expect(h.runProgram).not.toHaveBeenCalled();
    expect(h.requests[0]!.body.prompt).toContain("enclose it in a Markdown code fence");
  });

  it("rejects non-text input before any provider request or tool effect", async () => {
    const h = harness([]);
    await expect(h.agent.generate({ messages: [{ role: "user", content: [
      { type: "text", text: "Look at this" }, { type: "image", image: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" },
    ] }] })).rejects.toMatchObject({ code: "completion-tool-protocol" });
    expect(h.requests).toHaveLength(0);
    expect(h.runProgram).not.toHaveBeenCalled();
  });

  it("preserves the existing DSML recovery while making its result readable on the next completion", async () => {
    const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="execute_program"><｜DSML｜ parameter name="code" string="true">return 2;</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    const h = harness([dsml, "done"]);
    expect((await h.agent.generate({ prompt: "act" })).text).toBe("done");
    expect(h.runProgram).toHaveBeenCalledOnce();
    expect(h.requests[1]!.body.prompt).toContain("effect completed");
  });

  it.each(["length", "content_filter", "unrecognized"])('refuses tool-prefixed responses with finish_reason %s before effects', async (finishReason) => {
    const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="execute_program"><｜DSML｜ parameter name="code" string="true">return 2;</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    for (const response of [call("execute_program", { code: "return 2;" }), dsml]) {
      const h = harness([response], { finishReason });
      await expect(h.agent.generate({ prompt: "act" })).rejects.toMatchObject({ code: "completion-tool-protocol" });
      expect(h.requests).toHaveLength(1);
      expect(h.runProgram).not.toHaveBeenCalled();
    }
  });

  it("provides a safe buffered stream by using completion generation before emitting calls", async () => {
    const h = harness([call("execute_program", { code: "return 2;" }), "done"]);
    const result = await h.agent.stream({ prompt: "act" });
    await result.consumeStream();
    expect(await result.text).toBe("done");
    expect(h.runProgram).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every(({ body }) => body.stream !== true)).toBe(true);
  });

  it.each(["required", "tool"] as const)("rejects plain text when tool choice is %s", async (mode) => {
    const h = choiceHarness("I will do that.");
    await expect(generateText({ model: h.model, prompt: "act", tools: h.tools,
      toolChoice: mode === "tool" ? { type: "tool", toolName: "execute_program" } : "required" }))
      .rejects.toMatchObject({ code: "completion-tool-protocol" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("checks a specific tool choice after DSML recovery before any tool executes", async () => {
    const wrong = choiceHarness(dsmlCall("read_api_reference"));
    await expect(generateText({ model: wrong.model, prompt: "act", tools: wrong.tools,
      toolChoice: { type: "tool", toolName: "execute_program" } })).rejects.toMatchObject({ code: "completion-tool-protocol" });
    expect(wrong.execute).not.toHaveBeenCalled();
    const right = choiceHarness(dsmlCall("execute_program", '<｜DSML｜ parameter name="code" string="true">return 2;</｜DSML｜ parameter>'));
    await generateText({ model: right.model, prompt: "act", tools: right.tools,
      toolChoice: { type: "tool", toolName: "execute_program" } });
    expect(right.execute).toHaveBeenCalledOnce();
  });
});
