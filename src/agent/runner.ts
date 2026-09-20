import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createBrowserTool, prepareBrowserMessages, repairBrowserToolCall } from "../chrome/tool";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { createModel } from "./model";
import { modelSupportsImages } from "./model-limits";
import type { ContextCompactor } from "./compaction";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent helping the user automate the browser they control.",
  "Use the single browser tool. Prefer mode=observe followed by mode=act with semantic refs or role/label/text locators.",
  "Put related actions in one act.steps JSON array, never a string, and include expect as the explicit completion condition, for example {\"mode\":\"act\",\"steps\":[{\"type\":\"click\",\"target\":{\"by\":\"role\",\"value\":\"button\",\"name\":\"Continue\"}}]}. A successful click only means browser input was sent.",
  "Use mode=run only when the DSL cannot express the task. run executes in the extension realm and must explicitly return a value. For page DOM prefer (await browser.page(tabId)).evaluate(...); browser.runIn requires an explicit target unless passed a page returned by browser.page. Read large $ref values with their exact access example, select and reduce them inside the same run, and return only the needed subset.",
  "Use observe.since after an observation when only page changes are needed. Stop immediately once the requested outcome is satisfied. If multiple targets remain ambiguous, ask the user as soon as the ambiguity is confirmed instead of exhaustively exploring.",
  "Visual point actions must use the observationId from the screenshot observation. Stale document, viewport, or scale coordinates are rejected.",
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

type BrowserAgentTools = { browser: ReturnType<typeof createBrowserTool> };

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, BrowserAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, BrowserAgentTools>({
    model: options.languageModel ?? createModel(options.model, logger, options.conversationId),
    reasoning: "minimal",
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: {
      browser: createBrowserTool(options.executor, { logger, conversationId: options.conversationId, visualEnabled: () => modelSupportsImages(options.model) }),
    },
    prepareStep: async ({ messages, stepNumber }) => ({
      messages: prepareBrowserMessages(await options.compactor?.prepare(messages, stepNumber) ?? messages, stepNumber),
    }),
    repairToolCall: async ({ toolCall }) => {
      const repaired = repairBrowserToolCall(toolCall);
      if (repaired) logger?.record({
        type: "tool.input.repaired", conversationId: options.conversationId, toolCallId: toolCall.toolCallId,
        content: { toolName: toolCall.toolName, repair: "stringified-act-steps" },
        input: JSON.parse(toolCall.input), output: JSON.parse(repaired.input),
      });
      return repaired;
    },
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
