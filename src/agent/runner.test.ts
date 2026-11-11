import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ChromeExecutor } from "../chrome/executor";
import { EventLogger, type LogEvent } from "../logging";
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
  const logger = new EventLogger({
    store: {
      async append(event) {
        const saved = { ...event, id: events.length + 1 };
        events.push(saved);
        return saved;
      },
      async all() {
        return [...events];
      },
      async clear() {
        events.splice(0);
      },
    },
  });
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
