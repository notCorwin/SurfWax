import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { activeConversationMessages } from "../conversations";
import { fromLogValue, type ConversationMessage, type EventLogger } from "../logging";
import type { JevConfig, ModelConfig } from "../types";
import { contextPressure, effectiveContext, estimateInput, pendingContextChoice, saveInheritedSummary, summarizeContext, summaryMessage } from "./compaction";
import { JevSelector, type JevSelectionScores } from "./jev";
import { createModel } from "./model";
import { DEFAULT_INSTRUCTIONS } from "./runner";

export async function modelMessages(messages: ConversationMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(messages as UIMessage[], { ignoreIncompleteToolCalls: true });
}

export async function activeContext(logger: EventLogger, conversationId: string) {
  const ui = await activeConversationMessages(logger, conversationId);
  const branchIds = ui.map((message) => message.id);
  const raw = await modelMessages(ui);
  const events = await logger.conversation(conversationId);
  const { checkpoint, messages } = await effectiveContext(events, branchIds, raw);
  let sourceUiCount = checkpoint?.sourceUiCount ?? 0;
  if (checkpoint && sourceUiCount < 0) {
    sourceUiCount = 0;
    while (sourceUiCount < ui.length && (await modelMessages(ui.slice(0, sourceUiCount))).length < checkpoint.sourceCount) sourceUiCount += 1;
  }
  return { ui, branchIds, raw, events, checkpoint, messages,
    effectiveUi: checkpoint ? ui.slice(sourceUiCount) : ui };
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

function toolIds(message: ConversationMessage): string[] {
  return message.parts.flatMap((part) => {
    const id = part && typeof part === "object" ? (part as { toolCallId?: unknown }).toolCallId : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

export function selectMessages(messages: readonly ConversationMessage[], probabilities: Map<number, number>, threshold: number): ConversationMessage[] {
  const selected = new Set(messages.flatMap((message, index) => message.role === "user" ? [index] : []));
  messages.forEach((message, index) => {
    if (message.role !== "user" && (probabilities.get(index) ?? -1) >= threshold) selected.add(index);
  });
  const indexesByTool = new Map<string, number[]>();
  messages.forEach((message, index) => toolIds(message).forEach((id) => {
    const indexes = indexesByTool.get(id) ?? [];
    indexes.push(index);
    indexesByTool.set(id, indexes);
  }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...selected]) for (const id of toolIds(messages[index]!)) {
      for (const paired of indexesByTool.get(id) ?? []) if (!selected.has(paired)) {
        selected.add(paired);
        changed = true;
      }
    }
  }
  return messages.filter((_, index) => selected.has(index));
}

export type SelectionProposal = {
  source: Awaited<ReturnType<typeof activeContext>>;
  scores: JevSelectionScores;
  selected: ConversationMessage[];
  estimated: number;
  threshold: number;
  minimumRaisedThreshold?: number;
  limit: number;
  inputThreshold: number;
};

export async function proposeJevSelection(options: {
  logger: EventLogger; conversationId: string; model: ModelConfig; jev: JevConfig; signal: AbortSignal;
  selector?: Pick<JevSelector, "score">;
}): Promise<SelectionProposal> {
  const { logger, conversationId, model, jev, signal } = options;
  const source = await activeContext(logger, conversationId);
  const pressure = await contextPressure({ raw: source.raw, branchIds: source.branchIds, events: source.events, model, signal });
  if (!pressure) throw new Error("无法取得模型上下文窗口；请手动设置窗口大小。");
  const fullState: ModelMessage[] = [{ role: "system", content: DEFAULT_INSTRUCTIONS }, ...source.messages];
  const candidates = source.effectiveUi.flatMap((message, index) => message.role === "user" ? []
    : [{ index, message: { role: "assistant", content: JSON.stringify(message) } as ModelMessage }]);
  await logger.append({ type: "context.selection.started", conversationId,
    content: { candidateCount: candidates.length, threshold: jev.threshold, branchIds: source.branchIds } });
  try {
    const scores = candidates.length ? await (options.selector ?? new JevSelector(jev, { logger, conversationId }))
      .score(fullState, candidates, signal) : { probabilities: new Map<number, number>(), batches: 0,
        usage: { input_tokens: 0, output_tokens: 0 }, model: jev.model };
    const scale = pressure.estimated / estimateInput(pressure.messages);
    const measure = async (items: ConversationMessage[]) => Math.ceil(estimateInput([
      ...(source.checkpoint ? [summaryMessage(source.checkpoint.summary)] : []), ...await modelMessages(items),
    ]) * scale);
    const selected = selectMessages(source.effectiveUi, scores.probabilities, jev.threshold);
    const estimated = await measure(selected);
    let minimumRaisedThreshold: number | undefined;
    if (estimated > pressure.threshold) {
      for (let cent = Math.floor(jev.threshold * 100) + 1; cent <= 99; cent += 1) {
        if (await measure(selectMessages(source.effectiveUi, scores.probabilities, cent / 100)) <= pressure.limit.context * 0.3) {
          minimumRaisedThreshold = cent / 100;
          break;
        }
      }
    }
    await logger.append({ type: "model.compaction.selection.finished", conversationId,
      content: { model: scores.model, batches: scores.batches, probabilities: Object.fromEntries(scores.probabilities),
        threshold: jev.threshold, estimatedInputTokens: estimated, minimumRaisedThreshold },
      stopReason: "decision", usage: scores.usage, providerMetadata: { provider: jev.provider, model: scores.model } });
    return { source, scores, selected, estimated, threshold: jev.threshold, minimumRaisedThreshold,
      limit: pressure.limit.context, inputThreshold: pressure.threshold };
  } catch (error) {
    await logger.append({ type: signal.aborted ? "context.selection.aborted" : "context.selection.failed", conversationId,
      content: null, ...(signal.aborted ? { abort: { reason: signal.reason } } : { error }) });
    throw error;
  }
}

export async function forkSelection(logger: EventLogger, conversationId: string, proposal: SelectionProposal, threshold = proposal.threshold): Promise<string> {
  const selected = threshold === proposal.threshold ? proposal.selected
    : selectMessages(proposal.source.effectiveUi, proposal.scores.probabilities, threshold);
  const childId = crypto.randomUUID();
  const parentTitle = (fromLogValue((await logger.summaryEvents(conversationId)).find((event) => event.type === "conversation.created")?.content) as { title?: string } | undefined)?.title ?? "新对话";
  try {
    await logger.append({ type: "conversation.created", conversationId: childId,
      content: { title: `${parentTitle} · Jev`, parentConversationId: conversationId } });
    if (proposal.source.checkpoint) await saveInheritedSummary(logger, childId, proposal.source.checkpoint.summary);
    let parentId: string | null = null;
    for (const message of selected) {
      await logger.appendMessage(childId, message, { parentId });
      parentId = message.id;
    }
    await logger.append({ type: "context.selection.applied", conversationId: childId,
      content: { parentConversationId: conversationId, threshold, sourceMessageIds: proposal.source.effectiveUi.map((message) => message.id),
        retainedMessageIds: selected.map((message) => message.id), model: proposal.scores.model } });
    await logger.append({ type: "context.choice.resolved", conversationId,
      content: { branchIds: proposal.source.branchIds, action: "jev-selection", childConversationId: childId } });
    return childId;
  } catch (error) {
    await logger.deleteConversation(childId).catch(() => undefined);
    throw error;
  }
}

export async function applySummaryChoice(logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal): Promise<void> {
  const source = await activeContext(logger, conversationId);
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    model, languageModel: createModel(model, logger, conversationId), logger, conversationId, signal });
  await logger.append({ type: "context.choice.resolved", conversationId,
    content: { branchIds: source.branchIds, action: "summary" } });
}
