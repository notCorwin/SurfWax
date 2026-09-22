import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createCommandTools, prepareToolMessages } from "../chrome/tool";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { modelSupportsImages } from "./model-limits";
import type { ContextCompactor } from "./compaction";
import type { ReasoningEffort } from "./reasoning";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent helping the user automate the browser they control.",
  "Use the dedicated browser command tools. Start with snapshot or find, then use refs or semantic targets; never guess a locator when page content is unavailable.",
  "A successful action only confirms browser input was sent. Inspect the returned page state or call snapshot to verify the requested outcome before claiming success.",
  "Use run-code only when the dedicated commands cannot express the task. It accepts one async function expression whose page argument exposes the documented Playwright-style subset.",
  "Commands use the default session unless session is provided. Tab indices are zero-based. Stop immediately once the requested outcome is satisfied, and ask the user when multiple targets remain genuinely ambiguous.",
].join(" ");

export type CreateAgentOptions = {
  model: ModelConfig;
  executor: ChromeExecutor;
  languageModel: LanguageModel;
  reasoning?: ReasoningEffort;
  instructions?: string;
  logger?: EventLogger;
  conversationId?: string;
  compactor?: ContextCompactor;
};

type BrowserAgentTools = ReturnType<typeof createCommandTools>;

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, BrowserAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, BrowserAgentTools>({
    model: options.languageModel,
    reasoning: options.reasoning === "max" ? "xhigh" : options.reasoning ?? "minimal",
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: createCommandTools(options.executor, { logger, conversationId: options.conversationId, visualEnabled: () => modelSupportsImages(options.model) }),
    prepareStep: async ({ messages, stepNumber }) => ({
      messages: prepareToolMessages(await options.compactor?.prepare(messages, stepNumber) ?? messages, stepNumber),
    }),
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
      onLanguageModelCallStart: (event) => options.compactor?.recordPrompt(event),
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
        options.compactor?.recordUsage(event.usage.inputTokens, event.stepNumber);
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
