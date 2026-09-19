import { isLoopFinished, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { createChromeTool, createPageTool } from "../chrome/tool";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { createModel } from "./model";
import type { ContextCompactor } from "./compaction";

export const DEFAULT_INSTRUCTIONS = [
  "You are a Chrome side-panel agent helping the user automate the browser they control.",
  "Use page for normal web-page observation and interaction; use chrome for extension APIs, arbitrary browser JavaScript, User Scripts, and raw CDP. Return values explicitly and select only needed page data.",
  "Page example: page({code:'const s=await page.snapshot(); await page.getByRole(\"button\",{name:\"Sign in\"}).click(); return s'}). Page locators auto-wait and are strict; prefer semantic locators and snapshot refs over CSS.",
  "Extension example: chrome({code:'return await chrome.tabs.query({active:true})',target:{kind:'extension'}}). Page example: chrome({code:'return document.title',target:{kind:'page',tabId:1,world:'MAIN'}}).",
  "Use MAIN, ISOLATED, or USER_SCRIPT for page worlds.",
  "Inspect live availability with chrome({target:{kind:'extension'},code:'return await chrome.capabilities()'}); unavailable hosts return an actionable reason.",
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

type BrowserAgentTools = { chrome: ReturnType<typeof createChromeTool>; page: ReturnType<typeof createPageTool> };

export function createAgent(options: CreateAgentOptions): ToolLoopAgent<never, BrowserAgentTools> {
  const logger = options.logger;
  return new ToolLoopAgent<never, BrowserAgentTools>({
    model: options.languageModel ?? createModel(options.model, logger, options.conversationId),
    reasoning: "minimal",
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools: {
      chrome: createChromeTool(options.executor, { logger, conversationId: options.conversationId }),
      page: createPageTool(options.executor, { logger, conversationId: options.conversationId }),
    },
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
