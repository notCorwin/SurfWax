import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ChromeExecutor } from "../chrome/executor";
import { PROGRAM_TOOL_CONTEXT, PROGRAM_TOOL_REGISTRY } from "../chrome/tool";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { ContextCompactor, estimatePromptInput } from "./compaction";
import { createPromptSnapshot, PROMPT_TOOLS } from "./prompt";
import { createAgent, DEFAULT_INSTRUCTIONS, stagnationReason } from "./runner";
import type { ModelConfig } from "../types";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const text = (text = "done") => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const tool = (id: string, name: string, input: unknown) => ({ content: [{ type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] });
const config = { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 };
function memoryLog() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: { async append(event) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; }, async all() { return [...events]; }, async clear() { events.splice(0); } } });
  logger.beginRun("conversation", "run");
  return { events, logger };
}
function browserExecutor(extra = {}) { return { browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })), ...extra } as unknown as ChromeExecutor; }

describe("createAgent", () => {
  it("executes concurrent SDK tool calls in model order and waits for the prior result to be recorded", async () => {
    const { events, logger } = memoryLog();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const executor = browserExecutor({
      browserContext: async () => ({ windowId: 7, tabs: [{ current: true, tabId: 41 }] }),
      runProgram: vi.fn(async () => { order.push("click-start"); await gate; order.push("click-end"); return { ok: true }; }),
      inspect: vi.fn(async () => {
        expect(events.some((event) => event.type === "tool.finished" && event.toolCallId === "click")).toBe(true);
        order.push("inspect"); return { snapshot: "updated" };
      }),
    });
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [
        { type: "tool-call" as const, toolCallId: "click", toolName: "click", input: JSON.stringify({ target: { ref: "e1" } }) },
        { type: "tool-call" as const, toolCallId: "inspect", toolName: "inspect_page", input: "{}" },
      ], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
    } : text() });
    const pending = createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "act" });
    await vi.waitFor(() => expect(order).toEqual(["click-start"]));
    release();
    await pending;
    expect(order).toEqual(["click-start", "click-end", "inspect"]);
  });

  it("does not dispatch later writes on a failed tab but still returns a result and permits reading", async () => {
    const { events, logger } = memoryLog();
    const runProgram = vi.fn(async () => ({ ok: false, error: { code: "stale-ref", message: "stale" } }));
    const inspect = vi.fn(async () => ({ snapshot: "current" }));
    const executor = browserExecutor({ browserContext: async () => ({ windowId: 7, tabs: [{ current: true, tabId: 41 }] }), runProgram, inspect });
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [
        { type: "tool-call" as const, toolCallId: "first", toolName: "click", input: JSON.stringify({ target: { ref: "e1" } }) },
        { type: "tool-call" as const, toolCallId: "second", toolName: "fill", input: JSON.stringify({ target: { ref: "e2" }, value: "x" }) },
        { type: "tool-call" as const, toolCallId: "read", toolName: "inspect_page", input: "{}" },
      ], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
    } : text() });
    await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "act" });
    expect(runProgram).toHaveBeenCalledOnce();
    // The failed click captures the page before the explicit inspection.
    expect(inspect).toHaveBeenCalledTimes(2);
    const terminal = events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    expect(terminal).toHaveLength(3);
    expect(terminal.find((event) => event.toolCallId === "second")).toMatchObject({ type: "tool.failed", output: { ok: false, error: { code: "prior-action-failed" } } });
  });

  it("does not dispatch later writes when a preceding model call has invalid arguments", async () => {
    const { events, logger } = memoryLog();
    const runProgram = vi.fn(async () => ({ ok: true }));
    const inspect = vi.fn(async () => ({ snapshot: "current" }));
    const executor = browserExecutor({ browserContext: async () => ({ windowId: 7, tabs: [{ current: true, tabId: 41 }] }), runProgram, inspect });
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [
        { type: "tool-call" as const, toolCallId: "invalid", toolName: "click", input: "{}" },
        { type: "tool-call" as const, toolCallId: "write", toolName: "fill", input: JSON.stringify({ target: { ref: "e2" }, value: "x" }) },
        { type: "tool-call" as const, toolCallId: "read", toolName: "inspect_page", input: "{}" },
      ], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
    } : text() });
    await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "act" });
    expect(runProgram).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(events.find((event) => event.toolCallId === "write" && event.type === "tool.failed")?.output).toMatchObject({ error: { code: "prior-action-failed" } });
  });

  it("records one interrupted result when tool execution is aborted", async () => {
    const { events, logger } = memoryLog();
    const controller = new AbortController();
    const executor = browserExecutor({ runProgram: async () => {
      controller.abort();
      return { ok: false, error: { code: "aborted", retryable: false, effectUnknown: true } };
    } });
    const model = new MockLanguageModelV4({ doGenerate: async () => tool("cancelled", "execute_program", { code: "return await page.title();" }) });
    await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation", signal: controller.signal })
      .generate({ prompt: "inspect", abortSignal: controller.signal }).catch((error) => { expect(error.name).toBe("AbortError"); });
    await logger.closePendingTools("run", "conversation", controller.signal.reason);
    const terminal = events.filter((event) => ["tool.failed", "tool.finished"].includes(event.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "tool.failed", content: { status: "interrupted", effectUnknown: true },
      output: { ok: false, error: { code: "aborted", retryable: false, effectUnknown: true } } });
  });

  it("records a large partial program failure with its full result exactly once", async () => {
    const { events, logger } = memoryLog();
    const failed = { ok: false, completed: [{ index: 0, type: "goto", result: { text: "completed".repeat(2000) } }],
      failed: { index: 1, error: { code: "expectation-failed", message: "Missing target" } }, notRun: [] };
    const executor = browserExecutor({ runProgram: vi.fn(async () => failed) });
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? tool("large-act", "execute_program", { code: "await page.goto('https://test/');" }) : text() });
    await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "act" });
    await logger.flush();
    const terminal = events.filter((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "large-act");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe("tool.failed");
    const output = fromLogValue(terminal[0]!.output) as any;
    expect(output).toMatchObject({ ok: false, error: { ...failed.failed.error, retryable: false }, $ref: expect.any(Number),
      access: { artifactId: expect.any(Number), path: ["completed"] } });
    expect(output.access.artifactId).toBe(output.$ref);
    expect(JSON.stringify(output).length).toBeLessThan(8192);
    const stored = events.filter((event) => event.type === "tool.result.data" && event.id === output.$ref);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ conversationId: "conversation", toolCallId: "large-act" });
    await expect(logger.result(output.$ref, {}, "conversation")).resolves.toEqual({ ...failed, error: { ...failed.failed.error, retryable: false } });
    await expect(logger.result(output.$ref, { path: output.access.path }, "conversation")).resolves.toEqual(failed.completed);
  });

  it.each([
    [{ providerId: "minimax", sdk: "@ai-sdk/anthropic", baseURL: "https://api.minimax.io/anthropic/v1", model: "MiniMax-M3" }, 512_000],
    [{ providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", model: "custom", contextWindowOverride: 256_000 }, 128_000],
    [{ providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", model: "custom", contextWindowOverride: 256_000, maxTokensOverride: 77_777 }, 77_777],
    [{ providerId: "gitlab", sdk: "gitlab-ai-provider", baseURL: "", model: "duo-chat-claude-sonnet-4-5", canonicalModelId: "anthropic/claude-sonnet-4-5", modelFamily: "claude", contextWindowOverride: 256_000 }, 128_000],
  ] as [ModelConfig, number][])("applies Anthropic output limits for %j", async (config, expected) => {
    const model = new MockLanguageModelV4({ doGenerate: async (options) => { expect(options.maxOutputTokens).toBe(expected); return text(); } });
    expect((await createAgent({ model: config, languageModel: model, executor: browserExecutor() }).generate({ prompt: "hello" })).text).toBe("done");
  });

  it("keeps the tool catalog out of the editable default instructions", () => {
    expect(DEFAULT_INSTRUCTIONS).not.toContain(PROGRAM_TOOL_CONTEXT);
    expect(DEFAULT_INSTRUCTIONS).not.toContain("search-tools");
  });

  it("counts frozen tool schemas and instructions before the first provider usage", async () => {
    const { events, logger } = memoryLog();
    const config = { baseURL: "https://test/v1", model: "test", contextWindowOverride: Math.ceil(estimatePromptInput({ instructions: createPromptSnapshot().instructions, tools: PROMPT_TOOLS, messages: [{ role: "user", content: "inspect" }] }) / 0.85) };
    const summaryRequests: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async (options) => {
      if (options.reasoning === "minimal") { summaryRequests.push(JSON.stringify(options.prompt)); return text("The user asks to inspect the page."); }
      return text();
    } });
    const compactor = new ContextCompactor({ model: config, logger, conversationId: "conversation", branchIds: ["u"], signal: new AbortController().signal });
    const result = await createAgent({ model: config, languageModel: model, executor: browserExecutor(), logger, conversationId: "conversation", compactor }).generate({ prompt: "inspect" });
    expect(result.text).toBe("done");
    expect(summaryRequests).toHaveLength(1);
    expect(events.some((event) => event.type === "context.compacted" && (event.content as any).stepNumber === 0)).toBe(true);
  });

  it("detects repeated failures and read loops without limiting repeatable input", () => {
    const step = (toolName: string, output: unknown) => ({ toolResults: [{ toolName, input: {}, output }] });
    expect(stagnationReason([step("execute_program", { ok: false }), step("execute_program", { ok: false })])).toBe("repeated-failure");
    expect(stagnationReason([step("inspect_page", { text: "same" }), step("inspect_page", { text: "same" }), step("inspect_page", { text: "same" })])).toBe("repeated-read");
    for (const name of ["find_elements", "list_frames", "list_downloads"]) expect(stagnationReason([step(name, { value: "same" }), step(name, { value: "same" }), step(name, { value: "same" })])).toBe("repeated-read");
    expect(stagnationReason([step("execute_program", { ok: true }), step("execute_program", { ok: true }), step("execute_program", { ok: true })])).toBeUndefined();
    expect(stagnationReason(Array.from({ length: 6 }, (_, index) => step(index % 2 ? "fill" : "click", { ok: true })))).toBeUndefined();
    expect(stagnationReason(Array.from({ length: 6 }, (_, index) => step(index % 2 ? "read_text" : "inspect_page", { text: "same" })))).toBe("two-call-cycle");
  });

  it("executes a composable navigation program with stable instructions and complete-response callbacks", async () => {
    const { events, logger } = memoryLog();
    let step = 0;
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    const received = vi.fn();
    const executor = browserExecutor({ runProgram: vi.fn(async () => { expect(received).toHaveBeenCalledOnce(); return { ok: true }; }),
      browserContext: async () => ({ tabs: [{ current: true, title: "Current page", url: "https://test/current" }, { current: false, title: "Other page", url: "https://test/other" }] }) });
    const model = new MockLanguageModelV4({ doGenerate: async (options) => {
      expect(options.tools?.map((tool) => tool.name)).toEqual(PROGRAM_TOOL_REGISTRY.map(({ name }) => name));
      prompts.push(JSON.stringify(options.prompt));
      systemPrompts.push(String(options.prompt.find((message) => message.role === "system")?.content ?? ""));
      return ++step === 1 ? tool("call-1", "execute_program", { code: "await page.goto('https://test');" }) : text();
    } });
    const result = await createAgent({ model: config, languageModel: model, executor, instructions: "Custom guidance.", logger, conversationId: "conversation", onResponse: received }).generate({ prompt: "go" });
    expect(step).toBe(2);
    expect(received).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain("<browser-context>");
    expect(prompts[0]).toContain("Other page");
    expect(systemPrompts[0]).toBe(`Custom guidance.\n\n${PROGRAM_TOOL_CONTEXT}`);
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
    expect(result.text).toBe("done");
    await logger.flush();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "model.started", content: expect.objectContaining({ toolCount: PROGRAM_TOOL_REGISTRY.length }) })]));
  });

  it.each(["generate", "stream"] as const)("keeps browser updates and screenshot messages as an append-only SDK prompt prefix (%s)", async (mode) => {
    const { logger } = memoryLog();
    let step = 0; let contexts = 0; const prompts: any[][] = [];
    const executor = browserExecutor({
      browserContext: async () => ({ windowId: 7, tabs: [{ current: true, tabId: 41, title: ++contexts === 1 ? "Before" : "After", url: "https://test/" }] }),
      inspect: vi.fn(async () => step === 1 ? { snapshot: "first", screenshot: { mediaType: "image/png", data: "aW1hZ2U=" } } : { snapshot: "second" }),
    });
    const next = (options: any) => {
      prompts.push(structuredClone(options.prompt));
      return ++step < 3 ? tool(`inspect-${step}`, "inspect_page", {}) : text();
    };
    const model = new MockLanguageModelV4({ doGenerate: async (options) => next(options), doStream: async (options) => {
      const result = next(options);
      const parts = result.content[0]!.type === "tool-call" ? [result.content[0], { type: "finish", finishReason: result.finishReason, usage }]
        : [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" }, { type: "finish", finishReason: result.finishReason, usage }];
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) as any };
    } });
    const agent = createAgent({ model: { ...config, imageInput: "enabled" }, languageModel: model, executor, logger, conversationId: "conversation" });
    if (mode === "generate") await agent.generate({ prompt: "inspect" });
    else await (await agent.stream({ prompt: "inspect" })).consumeStream();
    expect(prompts).toHaveLength(3);
    expect(prompts[1]!.slice(0, prompts[0]!.length)).toEqual(prompts[0]);
    expect(prompts[2]!.slice(0, prompts[1]!.length)).toEqual(prompts[1]);
    expect(JSON.stringify(prompts[0])).toContain("Before");
    expect(JSON.stringify(prompts[1])).toContain("After");
    const files = prompts[1]!.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === "file");
    expect(files).toHaveLength(1);
    expect(JSON.stringify(prompts[2])).toContain('"mediaType":"image/png"');
  });

  it("sends stable tool and system cache breakpoints to the first-party Claude API", async () => {
    const requests: any[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const first = requests.length === 1;
      return new Response(JSON.stringify({ id: `message-${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: first ? [{ type: "tool_use", id: "tool-1", name: "read_api_reference", input: {} }] : [{ type: "text", text: "done" }],
        stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 12000, output_tokens: 10, cache_creation_input_tokens: first ? 10000 : 0, cache_read_input_tokens: first ? 0 : 10000 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const languageModel = createAnthropic({ apiKey: "test-key", fetch })("claude-sonnet-4-5");
    const model = { providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", contextWindowOverride: 256_000 } as ModelConfig;
    const result = await createAgent({ model, languageModel, executor: browserExecutor(), instructions: "Custom guidance." }).generate({ prompt: "inspect" });
    expect(result.text).toBe("done"); expect(requests).toHaveLength(2);
    expect(requests[0].tools).toEqual(requests[1].tools);
    expect(requests[0].tools).toHaveLength(PROGRAM_TOOL_REGISTRY.length);
    expect(requests[0].tools.slice(0, -1).every((item: any) => item.cache_control === undefined)).toBe(true);
    expect(requests[0].tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(requests[0].system).toEqual(requests[1].system);
    expect(requests[0].system).toEqual([{ type: "text", text: `Custom guidance.\n\n${PROGRAM_TOOL_CONTEXT}`, cache_control: { type: "ephemeral" } }]);
    expect(result.steps[1]?.usage.inputTokenDetails.cacheReadTokens).toBe(10000);
  });

  it("preserves custom instructions and cache breakpoints after context compaction", async () => {
    const { logger, events } = memoryLog();
    const requests: any[] = []; let agentCalls = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      const summary = JSON.stringify(request.system).includes("Summarize the entire supplied conversation faithfully");
      const first = !summary && ++agentCalls === 1;
      return new Response(JSON.stringify({ id: `message-${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: first ? [{ type: "tool_use", id: "tool-1", name: "read_api_reference", input: {} }] : [{ type: "text", text: summary ? "Summary of earlier work." : "done" }],
        stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 12000, output_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const instructions = createPromptSnapshot("Custom guidance.");
    const estimated = estimatePromptInput({ instructions: instructions.instructions, tools: PROMPT_TOOLS, messages: [{ role: "user", content: "inspect" }] });
    const model = { providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", contextWindowOverride: Math.ceil(estimated / 0.85), maxTokensOverride: 4096 } as ModelConfig;
    const languageModel = createAnthropic({ apiKey: "test-key", fetch })("claude-sonnet-4-5");
    const compactor = new ContextCompactor({ model, logger, conversationId: "conversation", branchIds: ["u"], signal: new AbortController().signal, prompt: instructions });
    const result = await createAgent({ model, languageModel, executor: browserExecutor(), instructions: "Custom guidance.", logger, conversationId: "conversation", compactor }).generate({ prompt: "inspect" });
    expect(result.text).toBe("done");
    expect(events.some((event) => event.type === "context.compacted")).toBe(true);
    const agentRequests = requests.filter((request) => Array.isArray(request.tools));
    expect(agentRequests).toHaveLength(2);
    for (const request of agentRequests) {
      expect(request.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
      expect(request.system).toEqual([{ type: "text", text: `Custom guidance.\n\n${PROGRAM_TOOL_CONTEXT}`, cache_control: { type: "ephemeral" } }]);
      expect(JSON.stringify(request.messages)).toContain("Summary of earlier work.");
    }
    expect(agentRequests[0].tools).toEqual(agentRequests[1].tools);
    expect(agentRequests[0].system).toEqual(agentRequests[1].system);
  });

  it.each([
    { providerId: "minimax", sdk: "@ai-sdk/anthropic", baseURL: "https://api.minimax.io/anthropic/v1", model: "claude-compatible" },
    { providerId: "custom", sdk: "@ai-sdk/anthropic", baseURL: "https://proxy.example/v1", model: "claude-custom" },
    { providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", baseURLOverride: "https://proxy.example/v1", model: "claude-custom" },
    { providerId: "anthropic", sdk: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1", model: "custom" },
  ] as ModelConfig[])("does not impose Claude cache fields on %j", async (model) => {
    const languageModel = new MockLanguageModelV4({ doGenerate: async (options) => {
      expect(options.tools?.every((item) => (item as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl === undefined)).toBe(true);
      const system = options.prompt.find((message) => message.role === "system");
      expect(system?.providerOptions?.anthropic?.cacheControl).toBeUndefined();
      return text();
    } });
    await createAgent({ model: { ...model, contextWindowOverride: 256_000 }, languageModel, executor: browserExecutor() }).generate({ prompt: "hello" });
  });

  it("executes a complete DSML program and continues with its result", async () => {
    const { events, logger } = memoryLog();
    let step = 0;
    const code = "await page.mouse.wheel(0, 600);";
    const dsml = `<｜DSML｜ calls><｜DSML｜ invoke name="execute_program"><｜DSML｜ parameter name="code" string="true">${code}</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`;
    const executor = browserExecutor({ runProgram: vi.fn(async () => ({ ok: true })) });
    const model = new MockLanguageModelV4({ doGenerate: async () => text(++step === 1 ? dsml : "done") });
    const result = await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "scroll" });
    expect(step).toBe(2);
    expect(executor.runProgram).toHaveBeenCalledWith({ code }, undefined, expect.any(Object));
    expect(result.steps.flatMap((step) => step.toolResults)).toHaveLength(1);
    expect(result.text).toBe("done");
    await logger.flush();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "model.dsml.recovery", content: { recovered: true, toolNames: ["execute_program"] } })]));
  });

  it("continues beyond twenty calls and records repeated reads without disabling tools", async () => {
    const { events, logger } = memoryLog();
    let step = 0;
    const executor = browserExecutor({ inspect: vi.fn(async () => ({ text: "same" })) });
    const model = new MockLanguageModelV4({ doGenerate: async (options) => {
      expect(options.reasoning).toBeUndefined();
      expect(options.tools?.map((tool) => tool.name)).toEqual(PROGRAM_TOOL_REGISTRY.map(({ name }) => name));
      return ++step <= 25 ? tool(`read-${step}`, "inspect_page", {}) : text("finished");
    } });
    const result = await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "inspect" });
    expect(step).toBe(26);
    expect(executor.inspect).toHaveBeenCalledTimes(25);
    expect(result.steps.flatMap((step) => step.toolResults)).toHaveLength(25);
    expect(result.finishReason).toBe("stop");
    await logger.flush();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.loop-guard.triggered", content: { stepNumber: 3, reason: "repeated-read" } })]));
  }, 90_000);
});
