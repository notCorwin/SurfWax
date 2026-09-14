import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createChromeTool } from "../chrome/tool";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { ChromeBridge } from "../chrome/bridge";
import { createModel } from "./model";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent.",
  "Use the chrome tool for all browser actions and inspect the available API when needed.",
  "You may use raw Chrome APIs and CDP. Do not ask for application-level approval.",
  "For user scripts use chrome.userScripts.register, update, unregister, getScripts, and execute through this same chrome tool. A registered script must include an id, matches, and a non-empty js array; choose world MAIN when it must share the page JavaScript global and USER_SCRIPT for the native user-script world.",
  "This is Manifest V3: chrome.tabs.executeScript is not exposed. For packaged extension files or a real function use chrome.scripting.executeScript; for arbitrary source text in a tab use chrome.debugger CDP Runtime.evaluate instead.",
  "Return concise progress updates after actions and do not claim an action succeeded until its tool result confirms it.",
].join(" ");

export type CreateAgentOptions = {
  model: ModelConfig;
  bridge: ChromeBridge;
  languageModel?: LanguageModel;
  instructions?: string;
  logger?: EventLogger;
};

type ChromeAgentTools = { chrome: ReturnType<typeof createChromeTool> };

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, ChromeAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, ChromeAgentTools>({
    model: options.languageModel ?? createModel(options.model, logger),
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: { chrome: createChromeTool(options.bridge) },
    ...(logger ? {
      onStart: (event) => logger.record({
        category: "model",
        type: "model.started",
        content: { callId: event.callId, operationId: event.operationId, provider: event.provider, modelId: event.modelId },
      }),
      onStepStart: (event) => logger.record({
        category: "model",
        type: "model.step.started",
        content: { callId: event.callId, stepNumber: event.stepNumber, provider: event.provider, modelId: event.modelId },
      }),
      onToolExecutionStart: (event) => logger.record({
        category: "tool",
        type: "tool.started",
        content: { callId: event.callId, toolName: event.toolCall.toolName },
        toolCallId: event.toolCall.toolCallId,
        input: event.toolCall.input,
      }),
      onToolExecutionEnd: (event) => logger.record({
        category: "tool",
        type: event.toolOutput.type === "tool-error" ? "tool.failed" : "tool.finished",
        content: { callId: event.callId, toolName: event.toolCall.toolName, toolExecutionMs: event.toolExecutionMs },
        toolCallId: event.toolCall.toolCallId,
        input: event.toolCall.input,
        ...(event.toolOutput.type === "tool-error" ? { error: event.toolOutput.error } : { output: event.toolOutput.output }),
        latencyMs: event.toolExecutionMs,
      }),
      onStepEnd: (event) => logger.record({
        category: "model",
        type: "model.step.finished",
        content: { callId: event.callId, stepNumber: event.stepNumber, text: event.text, reasoning: event.reasoning, toolCalls: event.toolCalls, toolResults: event.toolResults },
        stopReason: event.finishReason,
        usage: event.usage,
        providerMetadata: event.providerMetadata,
        latencyMs: event.performance?.stepTimeMs,
      }),
      onEnd: (event) => logger.record({
        category: "model",
        type: "model.finished",
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
