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
  "Use the chrome tool for every browser action. Its code is the body of an async function running in the Side Panel extension realm; explicitly return the desired result.",
  "Use the Web APIs and chrome.* Extension APIs needed for the user's request, including chrome.userScripts, chrome.scripting, and chrome.debugger/CDP.",
  "Use native chrome.userScripts register, update, unregister, getScripts, execute, configureWorld, and resetWorldConfiguration as needed. Use MAIN to share the page JavaScript global and USER_SCRIPT for the native user-script world.",
  "For CDP, discover targets with chrome.debugger.getTargets(), attach to a tab, and keep the session and chrome.debugger.onEvent listeners across tool calls when needed. Use Target.setAutoAttach with flatten: true and a sessionId for out-of-process frames/workers; inspect Runtime.executionContextCreated for same-process frames and rediscover contexts after navigation. Detach sessions when finished.",
  "Treat the user's request as authorization for ordinary browser automation in their browser; do not ask for separate Harness approval. Return concise progress updates after actions and do not claim an action succeeded until its tool result confirms it.",
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
    tools: { chrome: createChromeTool(options.executor) },
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
