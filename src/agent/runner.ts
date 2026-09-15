import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createChromeTool } from "../chrome/tool";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { createModel } from "./model";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent.",
  "Use the chrome tool for every browser action. Its code is the body of an async function running in the Side Panel extension realm; explicitly return the desired result.",
  "The code can use Web APIs and every available chrome.* API directly, including chrome.userScripts, chrome.scripting, and chrome.debugger raw CDP. Do not ask for application-level approval.",
  "Use native chrome.userScripts register, update, unregister, getScripts, execute, configureWorld, and resetWorldConfiguration as needed. Use MAIN to share the page JavaScript global and USER_SCRIPT for the native user-script world.",
  "Return concise progress updates after actions and do not claim an action succeeded until its tool result confirms it.",
].join(" ");

export type CreateAgentOptions = {
  model: ModelConfig;
  executor: ChromeExecutor;
  languageModel?: LanguageModel;
  instructions?: string;
  logger?: EventLogger;
  conversationId?: string;
};

type ChromeAgentTools = { chrome: ReturnType<typeof createChromeTool> };

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, ChromeAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, ChromeAgentTools>({
    model: options.languageModel ?? createModel(options.model, logger, options.conversationId),
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: { chrome: createChromeTool(options.executor) },
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
      onStepEnd: (event) => logger.record({
        type: "model.step.finished",
        conversationId: options.conversationId,
        content: { callId: event.callId, stepNumber: event.stepNumber, text: event.text, reasoning: event.reasoning, toolCalls: event.toolCalls, toolResults: event.toolResults },
        stopReason: event.finishReason,
        usage: event.usage,
        providerMetadata: event.providerMetadata,
        latencyMs: event.performance?.stepTimeMs,
      }),
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
