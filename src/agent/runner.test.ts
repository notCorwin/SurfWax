import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import type { ChromeExecutor } from "../chrome/executor";
import { EventLogger, type LogEvent } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { createAgent } from "./runner";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const text = (text = "done") => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
});
const tool = (id: string, name: string, input: unknown) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage,
  warnings: [],
});
const config = {
  baseURL: "https://test/v1",
  model: "test",
  contextWindowOverride: 1_000_000,
};
function memoryLog() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: createMemoryEventStore(events) });
  logger.beginRun("conversation", "run");
  return { events, logger };
}
function browserExecutor(extra = {}) {
  return {
    browserContext: vi.fn(async () => ({ windowId: 7, tabs: [] })),
    ...extra,
  } as unknown as ChromeExecutor;
}

describe("createAgent", () => {
  it.each([
    [undefined, ["text", "image"], true],
    [undefined, ["text"], false],
    ["enabled", ["text"], true],
    ["disabled", ["text", "image"], false],
  ] as const)("uses resolved image modalities %s / %j with explicit settings taking precedence", async (imageInput, modalities, enabled) => {
    const runProgram = vi.fn(async (_input: unknown, _signal?: AbortSignal, _context?: Parameters<ChromeExecutor["runProgram"]>[2]) => ({ ok: true }));
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => ++step === 1 ? tool("navigate", "navigate", { url: "https://test/" }) : text(),
    });
    await createAgent({
      model: { ...config, imageInput } satisfies ModelConfig,
      modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual", inputModalities: [...modalities] },
      languageModel: model,
      executor: browserExecutor({ runProgram }),
    }).generate({ prompt: "navigate" });
    expect(runProgram).toHaveBeenCalledOnce();
    expect(runProgram.mock.calls[0]?.[2]?.visualEnabled).toBe(enabled);
  });

  it("announces newly committed console events once per run between model steps", async () => {
    const { logger } = memoryLog();
    const requests: string[] = [];
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async (options) => {
      requests.push(JSON.stringify(options.prompt));
      return ++step < 3 ? tool(`click-${step}`, "click", { target: { id: "e1" } }) : text();
    } });
    const executor = browserExecutor({ runProgram: async (_input: unknown, _signal: unknown, context: any) => {
      if (step === 1) {
        await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "run", content: { tabId: 41, method: "Runtime.consoleAPICalled" }, output: { args: [{ value: "secret page content" }] }, toolCallId: context.toolCallId });
        await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "other", content: { tabId: 99, method: "Runtime.consoleAPICalled" } });
      }
      return { ok: true };
    } });
    await createAgent({ model: config, modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" }, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "click" });
    expect(requests[1]).toContain('Committed console events captured');
    expect(requests[1]).toContain('tabId');
    expect(requests[1]).not.toContain('secret page content');
    expect(requests[1]).not.toContain('99');
    expect(requests[2]!.match(/Committed console events captured/g)).toHaveLength(1);
  });

  it("discloses bounded scans before later console records", async () => {
    const { logger } = memoryLog();
    const requests: string[] = [];
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      requests.push(JSON.stringify(options.prompt));
      return ++step < 3 ? tool(`click-${step}`, "click", { target: { id: "e1" } }) : text();
    } });
    const executor = browserExecutor({ runProgram: async () => {
      if (step === 1) {
        for (let i = 0; i < 256; i++) await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "run", content: { tabId: 41, method: "Network.requestWillBeSent" } });
        await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "run", content: { tabId: 41, method: "Runtime.consoleAPICalled" } });
      }
      return { ok: true };
    } });
    await createAgent({ model: config, modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" }, languageModel: model, executor, logger, conversationId: "conversation" }).generate({ prompt: "click" });
    expect(requests[1]).toContain("further captured records remain to scan");
    expect(requests[2]).toContain('tabId');
    expect(requests[2]!.match(/Committed console events captured/g)).toHaveLength(2);
  });

  it("replays undelivered diagnostic notice after model failure without an anchor", async () => {
    const { logger } = memoryLog();
    await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "run", content: { tabId: 41, method: "Runtime.consoleAPICalled" } });
    const requests: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      requests.push(JSON.stringify(options.prompt));
      if (++calls === 1) throw new Error("model unavailable");
      return text();
    } });
    const agent = createAgent({ model: config, modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" }, languageModel: model, executor: browserExecutor(), logger, conversationId: "conversation" });
    await expect(agent.generate({ prompt: "test" })).rejects.toThrow("model unavailable");
    await agent.generate({ prompt: "test" });
    expect(requests[0]).toContain("Committed console events captured");
    expect(requests[1]).toContain("Committed console events captured");
  });

  it("does not carry an undelivered cursor into a replacement run", async () => {
    const { logger } = memoryLog();
    await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "run", content: { tabId: 41, method: "Runtime.consoleAPICalled" } });
    const requests: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      requests.push(JSON.stringify(options.prompt));
      if (++calls === 1) throw new Error("model unavailable");
      return text();
    } });
    const agent = createAgent({ model: config, modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" }, languageModel: model, executor: browserExecutor(), logger, conversationId: "conversation" });
    await expect(agent.generate({ prompt: "test" })).rejects.toThrow();
    logger.endRun("conversation", "run");
    logger.beginRun("conversation", "replacement");
    await logger.append({ type: "browser.diagnostic", conversationId: "conversation", runId: "replacement", content: { tabId: 73, method: "Runtime.consoleAPICalled" } });
    await agent.generate({ prompt: "test" });
    expect(requests[1]).toContain('73');
    expect(requests[1]).not.toContain('41');
  });

  it("executes concurrent SDK tool calls in model order and waits for the prior result to be recorded", async () => {
    const { events, logger } = memoryLog();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const executor = browserExecutor({
      browserContext: async () => ({
        windowId: 7,
        tabs: [{ current: true, tabId: 41 }],
      }),
      runProgram: vi.fn(async () => {
        order.push("click-start");
        await gate;
        order.push("click-end");
        return { ok: true };
      }),
      inspect: vi.fn(async () => {
        expect(
          events.some(
            (event) =>
              event.type === "tool.finished" && event.toolCallId === "click",
          ),
        ).toBe(true);
        order.push("inspect");
        return { snapshot: "updated" };
      }),
    });
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ++step === 1
          ? {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "click",
                  toolName: "click",
                  input: JSON.stringify({ target: { id: "e1" } }),
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "inspect",
                  toolName: "inspect_page",
                  input: "{}",
                },
              ],
              finishReason: {
                unified: "tool-calls" as const,
                raw: "tool_calls",
              },
              usage,
              warnings: [],
            }
          : text(),
    });
    const pending = createAgent({
      model: config,
      modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" },
      languageModel: model,
      executor,
      logger,
      conversationId: "conversation",
    }).generate({ prompt: "act" });
    await vi.waitFor(() => expect(order).toEqual(["click-start"]));
    release();
    await pending;
    expect(order).toEqual(["click-start", "click-end", "inspect"]);
  });

  it("records one interrupted result when tool execution is aborted", async () => {
    const { events, logger } = memoryLog();
    const controller = new AbortController();
    const executor = browserExecutor({
      runProgram: async () => {
        controller.abort();
        return {
          ok: false,
          error: { code: "aborted", retryable: false, effectUnknown: true },
        };
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        tool("cancelled", "navigate", { url: "https://test/" }),
    });
    await createAgent({
      model: config,
      modelLimit: { provider: "manual", model: config.model, context: config.contextWindowOverride, source: "manual" },
      languageModel: model,
      executor,
      logger,
      conversationId: "conversation",
      signal: controller.signal,
    })
      .generate({ prompt: "inspect", abortSignal: controller.signal })
      .catch((error) => {
        expect(error.name).toBe("AbortError");
      });
    await logger.closePendingTools(
      "run",
      "conversation",
      controller.signal.reason,
    );
    const terminal = events.filter((event) =>
      ["tool.failed", "tool.finished"].includes(event.type),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      type: "tool.failed",
      content: { status: "interrupted", effectUnknown: true },
      output: {
        ok: false,
        error: { code: "aborted", retryable: false, effectUnknown: true },
      },
    });
  });
});
