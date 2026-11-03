import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { EventLogger, type LogEvent } from "../logging";
import { testEventStore } from "../test-event-store";
import type { ChromeExecutor } from "../chrome/executor";
import { createAgent } from "./runner";
import { createChatTransport, type SidePanelMessage } from "./transport";
import { activeContext } from "./context-choice";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const config = { baseURL: "https://test/v1", model: "test", imageInput: "enabled" as const, contextWindowOverride: 1_000_000 };

it.each(["inline", "artifact"])("retains exact model input prefixes and %s images across user turns and restoration", async (kind) => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: testEventStore(events) });
  const image = await logger.append({ type: "tool.result.data", conversationId: "one", output: { nested: { screenshot: { data: "aGVsbG8=", mediaType: "image/png" } } } });
  const screenshot = kind === "inline" ? { data: "aGVsbG8=", mediaType: "image/png" }
    : { artifactId: image!.id, artifactPath: ["nested", "screenshot"], mediaType: "image/png" };
  const requests: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async (options) => {
    requests.push(structuredClone(options));
    step++;
    return { content: step === 1 ? [{ type: "tool-call" as const, toolCallId: "image", toolName: "take_screenshot", input: "{}" }]
      : [{ type: "text" as const, text: step === 2 ? "The observed page is ready." : "Continued using the prior observations." }],
    finishReason: { unified: step === 1 ? "tool-calls" as const : "stop" as const, raw: step === 1 ? "tool_calls" : "stop" }, usage, warnings: [] };
  } });
  const executor = {
    browserContext: async () => ({ tabs: [{ tabId: 1, current: true, title: "Visible page", url: "https://test/" }] }),
    runProgram: vi.fn(async () => ({ ok: true, result: { screenshot } })),
    inspect: async () => ({ snapshot: "Visible page" }),
  } as unknown as ChromeExecutor;
  const transport = createChatTransport(async (signal, _branchIds, _resumed, onResponse, _yield, contextAnchor) =>
    createAgent({ model: config, languageModel: model, executor, logger, conversationId: "one", signal, onResponse, contextAnchor }), logger, "one");
  const first: SidePanelMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Read the displayed image." }] };
  const reply = await transport.sendMessages({ trigger: "submit-message", chatId: "one", messages: [first] });
  const persisted = await activeContext(logger, "one");
  expect(events.filter((event) => event.type === "model.context.appended")).toHaveLength(2);
  expect(JSON.stringify(persisted.raw)).toContain("aGVsbG8=");
  const restored = createChatTransport(async (signal, _branchIds, _resumed, onResponse, _yield, contextAnchor) =>
    createAgent({ model: config, languageModel: model, executor, logger, conversationId: "one", signal, onResponse, contextAnchor }), logger, "one");
  const next: SidePanelMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "Continue from the observed image." }] };
  await restored.sendMessages({ trigger: "submit-message", chatId: "one", messages: [first, reply, next] });
  expect(requests).toHaveLength(3);
  const previous = requests[1]!.prompt;
  expect(requests[2]!.prompt.slice(0, previous.length)).toEqual(previous);
  expect(JSON.stringify(requests[2]!.prompt)).toContain("aGVsbG8=");
});
