import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createChromeTool } from "../chrome/tool";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { createModel } from "./model";
import type { ContextCompactor } from "./compaction";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent helping the user automate the browser they control.",
  "Use the single chrome tool for browser actions. Return values explicitly and select only needed page data.",
  "Extension example: chrome({code:'return await chrome.tabs.query({active:true})'}). Page example: chrome({tabId:1,code:'return document.title'}). User-script world: chrome({tabId:1,world:'USER_SCRIPT',code:'return document.title'}).",
  "Large result example: chrome({code:'return (await globalThis.__surfWaxResult(42)).slice(0,10)'}) using the returned event ID. Other references may only last until the page or panel closes.",
  "For advanced browser tasks, call native chrome.* APIs and CDP from the extension realm. Confirm results before claiming success.",
].join(" ");

export type CreateAgentOptions = {
  model: ModelConfig;
  executor: ChromeExecutor;
  languageModel?: LanguageModel;
  instructions?: string;
  logger?: EventLogger;
  conversationId?: string;
  compactor?: ContextCompactor;
};

type ChromeAgentTools = { chrome: ReturnType<typeof createChromeTool> };

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, ChromeAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, ChromeAgentTools>({
    model: options.languageModel ?? createModel(options.model, logger, options.conversationId),
    reasoning: "minimal",
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: { chrome: createChromeTool(options.executor, { logger, conversationId: options.conversationId }) },
    ...(options.compactor ? { prepareStep: async ({ messages, stepNumber }) => ({
      messages: await options.compactor!.prepare(messages, stepNumber) ?? messages,
    }) } : {}),
    ...(logger ? {
      onStart: (event) => logger.record({
        type: "model.started",
        conversationId: options.conversationId,
        content: { callId: event.callId, operationId: event.operationId, provider: event.provider, modelId: event.modelId },
      }),
      onStepStart: (event) => logger.record({
        type: "model.step.started",
        conversationId: options.conversationId,
        content: { callId: event.callId, stepNumber: event.stepNumber, provider: event.provider, modelId: event.modelId },
      }),
      onToolExecutionStart: (event) => logger.record({
        type: "tool.started",
        conversationId: options.conversationId,
        content: { callId: event.callId, toolName: event.toolCall.toolName },
        toolCallId: event.toolCall.toolCallId,
        input: event.toolCall.input,
      }),
      onToolExecutionEnd: (event) => logger.record({
        type: event.toolOutput.type === "tool-error" ? "tool.failed" : "tool.finished",
        conversationId: options.conversationId,
        content: { callId: event.callId, toolName: event.toolCall.toolName, toolExecutionMs: event.toolExecutionMs },
        toolCallId: event.toolCall.toolCallId,
        input: event.toolCall.input,
        ...(event.toolOutput.type === "tool-error" ? { error: event.toolOutput.error } : { output: event.toolOutput.output }),
        latencyMs: event.toolExecutionMs,
      }),
      onStepEnd: (event) => {
        options.compactor?.recordUsage(event.usage.inputTokens);
        logger.record({
          type: "model.step.finished",
          conversationId: options.conversationId,
          content: { callId: event.callId, stepNumber: event.stepNumber, text: event.text, reasoning: event.reasoning, toolCalls: event.toolCalls, toolResults: event.toolResults },
          stopReason: event.finishReason,
          usage: event.usage,
          providerMetadata: event.providerMetadata,
          latencyMs: event.performance?.stepTimeMs,
        });
      },
      onEnd: (event) => logger.record({
        type: "model.finished",
        conversationId: options.conversationId,
        content: { callId: event.callId, stepNumber: event.stepNumber, text: event.text, reasoning: event.reasoning, content: event.content, toolCalls: event.toolCalls, toolResults: event.toolResults },
        stopReason: event.finishReason,
        usage: event.usage,
        providerMetadata: event.providerMetadata,
      }),
    } : {}),
    // isLoopFinished() is explicitly a natural-termination condition and does not count steps.
    stopWhen: isLoopFinished(),
    // The provider fetch owns the unbounded retry policy; disable the SDK's finite retry loop.
    maxRetries: 0,
  });
}
