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

describe("user-facing errors", () => {
  it("shows actionable known failures without exposing arbitrary error content", async () => {
    const { errorDetails } = await import("../components/ui/error-notice");
    const secret = "secret-token server response";
    for (const error of [new Error(secret), secret, { message: secret }, { stack: secret }]) {
      expect(errorDetails(error)).not.toContain(secret);
    }
    expect(errorDetails(Object.assign(new Error(secret), { statusCode: 401 }))).toBe("认证失败，请检查 API 密钥和访问权限。");
    expect(errorDetails(new Error("脚本 ID 已存在。"))).toBe("脚本 ID 已存在。");
    expect(errorDetails("压缩后请求仍超出模型输入窗口；原始历史已保留，请增大上下文窗口或减少固定提示与工具开销。"))
      .toContain("增大上下文窗口");
  });
});
