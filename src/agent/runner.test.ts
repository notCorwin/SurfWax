import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ChromeExecutor } from "../chrome/executor";
import { PROGRAM_TOOL_CONTEXT } from "../chrome/tool";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { ContextCompactor, estimatePromptInput } from "./compaction";
import { createPromptSnapshot, PROMPT_TOOLS } from "./prompt";
import { createAgent, DEFAULT_INSTRUCTIONS, stagnationReason } from "./runner";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

describe("createAgent", () => {
  it("records a large partial program failure as one failed SDK terminal with its full result", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: { async append(event) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; }, async all() { return events; }, async clear() { events.splice(0); } } });
    logger.beginRun("conversation", "run");
    const steps = [{ type: "goto", url: "https://test/" }, { type: "expect", target: { by: "css", value: "#missing" }, state: "visible" }, { type: "click", target: { by: "css", value: "#submit" } }];
    const failed = { ok: false, completed: [{ index: 0, type: "goto", result: { text: "completed".repeat(2000) } }], failed: { index: 1, step: steps[1], error: { code: "expectation-failed", message: "Missing target" } }, notRun: [steps[2]] };
    const executor = { runProgram: vi.fn(async () => failed), browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })) } as unknown as ChromeExecutor;
    let step = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: ++step === 1 ? [
      { type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "large-act", toolName: "run", dynamic: true, input: JSON.stringify({ code: "await page.goto('https://test/'); await page.locator('#missing').waitFor();" }) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() },
    ] : [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
    ] as any[] }) }) });
    const result = await createAgent({ model: { baseURL: "https://test/v1", model: "test", contextWindowOverride: 1_000_000 }, languageModel: model, executor, logger, conversationId: "conversation" }).stream({ prompt: "act" });
    for await (const _ of result.stream) { /* Consume tool execution. */ }
    await logger.flush();
    const terminal = events.filter((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "large-act");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("tool.failed");
    expect(fromLogValue(terminal[0].output)).toEqual({ ...failed, error: { ...failed.failed.error, retryable: false } });
    expect(events.some((event) => event.type === "tool.result.data")).toBe(false);
  });

  it("uses catalog output limits for Anthropic-compatible non-Claude providers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ minimax: { api: "https://api.minimax.io/anthropic/v1", models: {
      "MiniMax-M3": { limit: { context: 1_048_576, output: 524_288 } },
    } } }))));
    const executor = { browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })) } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      expect(options.maxOutputTokens).toBe(524_288);
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
      ] as any[] }) };
    } });
    try {
      const agent = createAgent({ model: { providerId: "minimax", sdk: "@ai-sdk/anthropic", baseURL: "https://api.minimax.io/anthropic/v1", model: "MiniMax-M3" }, languageModel: model, executor });
      const result = await agent.stream({ prompt: "hello" });
      await expect(result.text).resolves.toBe("done");
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the tool catalog out of the default instructions", () => {
    expect(DEFAULT_INSTRUCTIONS).not.toContain(PROGRAM_TOOL_CONTEXT);
    expect(DEFAULT_INSTRUCTIONS).not.toContain("search-tools");
  });

  it("counts frozen tool schemas and instructions before the first provider usage", async () => {
    const events: LogEvent[] = [];
    const logger = {
      record(record: Partial<LogEvent>) { events.push({ id: events.length + 1, timestamp: "2026-09-30", content: null, ...record } as LogEvent); },
      async append(record: Partial<LogEvent>) { const event = { id: events.length + 1, timestamp: "2026-09-30", content: null, ...record } as LogEvent; events.push(event); return event; },
      async conversation() { return [...events]; }, async result() { return undefined; },
    } as unknown as EventLogger;
    const config = { baseURL: "https://example.com/v1", model: "test", contextWindowOverride: Math.ceil(estimatePromptInput({ instructions: createPromptSnapshot().instructions, tools: PROMPT_TOOLS, messages: [{ role: "user", content: "inspect" }] }) / 0.85) };
    const generated = vi.fn(async () => ({ content: [{ type: "text" as const, text: "The user asks to inspect the page." }],
      finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(), warnings: [] }));
    const model = new MockLanguageModelV4({ doGenerate: generated, doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
    ] as any[] }) }) });
    const executor = { browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })) } as unknown as ChromeExecutor;
    const compactor = new ContextCompactor({ model: config, logger, conversationId: "one", branchIds: ["u"], signal: new AbortController().signal });
    const result = await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "one", compactor }).stream({ prompt: "inspect" });
    await expect(result.text).resolves.toBe("done");
    expect(generated).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "context.compacted" && (event.content as any).stepNumber === 0)).toBe(true);
  });

  it("detects repeated failures and read-only loops without stopping repeatable input", () => {
    const step = (toolName: string, output: unknown) => ({ toolResults: [{ toolName, input: {}, output }] });
    expect(stagnationReason([step("run", { ok: false, error: { code: "x" } }), step("run", { ok: false, error: { code: "x" } })])).toBe("repeated-failure");
    expect(stagnationReason([step("inspect", { text: "same" }), step("inspect", { text: "same" }), step("inspect", { text: "same" })])).toBe("repeated-read");
    expect(stagnationReason([step("run", { ok: true }), step("run", { ok: true }), step("run", { ok: true })])).toBeUndefined();
  });

  it("executes a composable navigation program without adding a model turn", async () => {
    let step = 0;
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    const record = vi.fn();
    const executor = {
      runProgram: vi.fn(async () => ({ ok: true })),
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
          { type: "tool-call" as const, toolCallId: "call-1", toolName: "run", dynamic: true, input: JSON.stringify({ code: "await page.goto('https://example.com');" }) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage() },
        ] : [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "done" }, { type: "text-end" as const, id: "text" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
        ] as any[] }) };
      },
    });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", apiKey: "key", model: "test" }, languageModel: model, executor, instructions: "Custom guidance.", logger: { record, append: async (event: unknown) => { record(event); return event; } } as any }).stream({ prompt: [{ role: "user", content: "go" }] });
    for await (const _ of result.stream) {
      // Consume the stream so the agent can execute the repaired tool call.
    }
    expect(step).toBe(2);
    expect(prompts[0]).toContain("<browser-context>");
    expect(prompts[0]).toContain("Current page");
    expect(prompts[0]).toContain("Other page");
    expect(prompts[0]).toContain('current\\\":true');
    expect(systemPrompts[0]).toBe(`Custom guidance.\n\n${PROGRAM_TOOL_CONTEXT}`);
    expect(systemPrompts[0]).toContain(PROGRAM_TOOL_CONTEXT);
    expect(prompts.every((prompt) => prompt.split("Available tools:").length === 2)).toBe(true);
    expect(systemPrompts[0]).toContain("- run: Execute one operation or a composable async JavaScript program");
    expect(prompts[0]).not.toContain('"type":"file"');
    expect(executor.runProgram).toHaveBeenCalledWith({ code: "await page.goto('https://example.com');" }, undefined, expect.any(Object));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "model.started", content: expect.objectContaining({ activeTools: ["inspect", "run", "jobs"], toolCount: 3 }),
    }));
    expect(await result.text).toBe("done");
  }, 10_000);

  it("executes a recovered DSML scroll, records its result, and continues", async () => {
    let step = 0;
    const record = vi.fn();
    const executor = {
      runProgram: vi.fn(async () => ({ ok: true })),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [{ index: 0, current: true, title: "Course", url: "https://example.com" }] })),
    } as unknown as ChromeExecutor;
    const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="run"><｜DSML｜ parameter name="code" string="true">await page.mouse.wheel(0, 600);</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    const model = new MockLanguageModelV4({ doStream: async () => {
      step++;
      const answer = step === 1 ? dsml : "done";
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: answer.slice(0, 6) },
        { type: "text-delta", id: "text", delta: answer.slice(6) },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
      ] as any[] }) };
    } });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", model: "test" }, languageModel: model, executor, logger: { record, append: async (event: unknown) => { record(event); return event; } } as any }).stream({ prompt: "scroll" });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    expect(step).toBe(2);
    expect(executor.runProgram).toHaveBeenCalledOnce();
    expect(executor.runProgram).toHaveBeenCalledWith({ code: "await page.mouse.wheel(0, 600);" }, undefined, expect.any(Object));
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(1);
    expect(await result.text).toBe("done");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "model.dsml.recovery", content: { recovered: true, toolNames: ["run"] } }));
  }, 10_000);

  it("compacts during a run and executes a split DSML program with page evaluation", async () => {
    const events: LogEvent[] = [];
    const logger = {
      record(record: Partial<LogEvent>) { events.push({ id: events.length + 1, timestamp: "2026-09-23", content: null, ...record } as LogEvent); },
      async append(record: Partial<LogEvent>) {
        const event = { id: events.length + 1, timestamp: "2026-09-23", content: null, ...record } as LogEvent;
        events.push(event);
        return event;
      },
      async conversation() { return [...events]; },
      async result() { return undefined; },
      toolIdentity(_conversationId: string, toolCallId: string) { return { toolCallId, toolCallIdCanonical: true }; },
    } as unknown as EventLogger;
    const config = { baseURL: "https://example.com/v1", model: "test", contextWindowOverride: 60_000 };
    const signal = new AbortController().signal;
    const compactor = new ContextCompactor({ model: config, logger, conversationId: "one", branchIds: ["user"], signal });
    const executor = {
      inspect: vi.fn(async () => ({ ok: true, text: "page ".repeat(1_200) })),
      runProgram: vi.fn(async () => ({ ok: true, value: "知识点掌握度" })),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })),
    } as unknown as ChromeExecutor;
    const func = "() => { const txt = document.body.innerText.replace(/\\s+/g,' '); const idx = txt.indexOf('知识点掌握度'); return JSON.stringify({around: txt.slice(idx, idx+500)}); }";
    const dsml = `\n\n<｜DSML｜ calls><｜DSML｜ invoke name="run"><｜DSML｜ parameter name="code" string="true">return await page.evaluate(${func});</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`;
    let step = 0;
    const largeUsage = { ...usage(), inputTokens: { total: 44_000, noCache: 44_000, cacheRead: 0, cacheWrite: 0 } };
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "The user wants to inspect the current page." }],
        finishReason: { unified: "stop", raw: "stop" }, usage: usage(), warnings: [] }) as any,
      doStream: async (options) => {
        expect((options.tools as any[]).map((tool) => tool.name)).toContain("run");
        step += 1;
        if (step === 1) return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "snapshot", toolName: "inspect", dynamic: true, input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: largeUsage },
        ] as any[] }) };
        const answer = step === 2 ? dsml : "done";
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start", warnings: [] }, { type: "text-start", id: "text" },
          ...[answer.slice(0, 3), answer.slice(3, 37), answer.slice(37)].map((delta) => ({ type: "text-delta", id: "text", delta })),
          { type: "text-end", id: "text" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
        ] as any[] }) };
      },
    });
    const result = await createAgent({ model: config, languageModel: model, executor, logger, conversationId: "one", compactor })
      .stream({ prompt: [{ role: "user", content: `${"history ".repeat(7_200)}inspect the page` }] });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    expect(step).toBe(3);
    expect(executor.runProgram).toHaveBeenCalledWith({ code: `return await page.evaluate(${func});` }, undefined, expect.any(Object));
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(2);
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.text).join("")).not.toContain("DSML");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compacted", content: expect.objectContaining({ strategy: "summary", stepNumber: 1 }) }),
      expect.objectContaining({ type: "model.dsml.recovery", content: { recovered: true, toolNames: ["run"] } }),
      expect.objectContaining({ type: "tool.finished" }),
    ]));
    expect(events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
    expect(await result.text).toBe("done");
  }, 10_000);

  it("logs repeated reads while keeping tools available", async () => {
    const record = vi.fn();
    const executor = {
      inspect: vi.fn(async () => ({ ok: true, snapshot: "unchanged" })),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })),
    } as unknown as ChromeExecutor;
    let step = 0;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      expect((options.tools as any[]).map((tool) => tool.name)).toContain("run");
      const chunks = ++step <= 3
        ? [{ type: "tool-call", toolCallId: `read-${step}`, toolName: "inspect", dynamic: true, input: "{}" }]
        : [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" }];
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] }, ...chunks,
        { type: "finish", finishReason: { unified: step <= 3 ? "tool-calls" : "stop", raw: step <= 3 ? "tool_calls" : "stop" }, usage: usage() },
      ] as any[] }) };
    } });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", model: "test" }, languageModel: model,
      executor, logger: { record, append: async (event: unknown) => { record(event); return event; } } as any }).stream({ prompt: "inspect" });
    for await (const _ of result.stream) { /* consume tool results */ }
    expect(step).toBe(4);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "agent.loop-guard.triggered",
      content: { stepNumber: 3, reason: "repeated-read" } }));
    expect(await result.text).toBe("done");
  }, 10_000);

  it("exposes an advanced tool on the first step", async () => {
    let step = 0;
    const executor = {
      runProgram: vi.fn(async () => [{ name: "session" }]),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [{ index: 0, current: true, title: "test", url: "https://example.com" }] })),
    } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      const names = (options.tools as any[]).map((tool) => tool.name);
      step += 1;
      expect(names).toEqual(["inspect", "run", "jobs"]);
      expect(PROGRAM_TOOL_CONTEXT).toContain("net.console");
      expect(names).not.toContain("search-tools");
      const chunks = step === 1
        ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "console", toolName: "run", dynamic: true, input: JSON.stringify({ code: "return await net.console();" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() }]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() }];
      return { stream: simulateReadableStream({ chunks: chunks as any[] }) };
    } });
    const result = await createAgent({ model: { baseURL: "https://example.com/v1", model: "test" }, languageModel: model, executor }).stream({ prompt: "console" });
    for await (const _ of result.stream) { /* consume */ }
    expect(step).toBe(2);
    expect(executor.runProgram).toHaveBeenCalledWith({ code: "return await net.console();" }, undefined, expect.any(Object));
  }, 10_000);

  it("continues beyond twenty tool calls until natural completion", async () => {
    let step = 0;
    let toolResult = 0;
    const executor = {
      inspect: vi.fn(async () => [{ id: ++toolResult, title: "test" }]),
      browserContext: vi.fn(async () => ({ windowId: 7, tabs: [{ index: 0, current: true, title: "test", url: "https://example.com" }] })),
    } as unknown as ChromeExecutor;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        expect(options.reasoning).toBeUndefined();
        expect((options.tools as any[])).toHaveLength(3);
        expect((options.tools as any[]).map((tool) => tool.name)).toEqual(["inspect", "run", "jobs"]);
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
            { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: "inspect", dynamic: true, input: "{}" },
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
    expect(executor.inspect).toHaveBeenCalledTimes(25);
    expect(await result.finishReason).toBe("stop");
  }, 90_000);
});
