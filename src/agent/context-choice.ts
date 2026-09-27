import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { activeConversationMessages } from "../conversations";
import { type ConversationMessage, type EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { contextPressure, effectiveContext, pendingContextChoice, summarizeContext } from "./compaction";
import { createModel } from "./model";

export async function modelMessages(messages: ConversationMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(messages as UIMessage[], { ignoreIncompleteToolCalls: true });
}

export async function activeContext(logger: EventLogger, conversationId: string) {
  const ui = await activeConversationMessages(logger, conversationId);
  const branchIds = ui.map((message) => message.id);
  const raw = await modelMessages(ui);
  const events = await logger.conversation(conversationId);
  const { checkpoint, messages } = await effectiveContext(events, branchIds, raw);
  return { ui, branchIds, raw, events, checkpoint, messages };
}

export async function ensureContextChoice(logger: EventLogger, conversationId: string, model: ModelConfig, forced = false): Promise<boolean> {
  const context = await activeContext(logger, conversationId);
  if (pendingContextChoice(context.events, context.branchIds)) return true;
  const pressure = await contextPressure({ raw: context.raw, branchIds: context.branchIds, events: context.events, model });
  if (!forced && (!pressure || pressure.estimated <= pressure.threshold)) return false;
  await logger.append({ type: "context.choice.required", conversationId,
    content: { branchIds: context.branchIds, estimatedInputTokens: pressure?.estimated, threshold: pressure?.threshold,
      contextWindow: pressure?.limit.context, reason: forced ? "provider-overflow" : "threshold" } });
  return true;
}

export async function applySummaryChoice(logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal): Promise<void> {
  const source = await activeContext(logger, conversationId);
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    model, languageModel: await createModel(model, logger, conversationId, { signal }), logger, conversationId, signal });
  await logger.append({ type: "context.choice.resolved", conversationId,
    content: { branchIds: source.branchIds, action: "summary" } });
}
