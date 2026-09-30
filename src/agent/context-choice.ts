import { convertToModelMessages, type LanguageModel, type ModelMessage, type UIMessage } from "ai";
import { activeConversationMessages } from "../conversations";
import { type ConversationMessage, type EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { contextPressure, effectiveContext, pendingContextChoice, summarizeContext } from "./compaction";
import { createModel } from "./model";
import type { ModelLimit } from "./model-limits";
import { materializeToolCatalog } from "./tool-catalog";

export async function modelMessages(messages: ConversationMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(messages.map(materializeToolCatalog) as UIMessage[], { ignoreIncompleteToolCalls: true });
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
  // Compatibility query for older callers. New pressure must never introduce a manual gate.
  return true;
}

/** Use under the extension's run lease for submit preflight, overflow recovery, and post-turn upkeep. */
export async function ensureAutomaticContextSummary(
  logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal,
  options: { forced?: boolean; languageModel?: LanguageModel; limit?: ModelLimit;
    instructions?: unknown; tools?: readonly Record<string, unknown>[] } = {},
): Promise<boolean> {
  signal.throwIfAborted();
  const source = await activeContext(logger, conversationId);
  const legacyPending = pendingContextChoice(source.events, source.branchIds);
  const pressure = await contextPressure({ raw: source.raw, branchIds: source.branchIds, events: source.events,
    model, signal, limit: options.limit, instructions: options.instructions, tools: options.tools });
  if (!options.forced && !legacyPending && (!pressure || pressure.estimated <= pressure.threshold)) return false;
  if (!source.raw.length) return false;
  const languageModel = options.languageModel ?? await createModel(model, logger, conversationId, { signal });
  signal.throwIfAborted();
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    model, languageModel, logger, conversationId, signal, limit: options.limit ?? pressure?.limit });
  if (legacyPending) await logger.append({ type: "context.choice.resolved", conversationId,
    content: { branchIds: source.branchIds, action: "summary", automatic: true } });
  return true;
}

export async function applySummaryChoice(logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal): Promise<void> {
  const source = await activeContext(logger, conversationId);
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    model, languageModel: await createModel(model, logger, conversationId, { signal }), logger, conversationId, signal });
  await logger.append({ type: "context.choice.resolved", conversationId,
    content: { branchIds: source.branchIds, action: "summary" } });
}
