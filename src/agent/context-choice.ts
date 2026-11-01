import { convertToModelMessages, type LanguageModel, type ModelMessage, type UIMessage } from "ai";
import { activeConversationMessages, isSyntheticTerminalMessage, restoreConversationRepository } from "../conversations";
import { fromLogValue, isConversationMessage, type ConversationMessage, type EventLogger, type LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { contextPressure, effectiveContext, summarizeContext } from "./compaction";
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

/** Per-run cache of the canonical events needed for the model-visible branch.
 * Message updates replace their previous projection; the first raw and first valid
 * events preserve selected-head and message ordering semantics of full replay.
 */
export class IncrementalActiveContext {
  private epoch?: string;
  private afterId = -1;
  private others: LogEvent[] = [];
  private messages = new Map<string, { firstRaw: LogEvent; firstValid?: LogEvent; latestValid?: LogEvent }>();

  constructor(private logger: EventLogger, private conversationId: string) {}

  async read(): Promise<{ messages: ModelMessage[] }> {
    let batch = await this.logger.contextProjectionEvents(this.conversationId, this.afterId);
    if (this.epoch !== undefined && this.epoch !== batch.epoch) {
      this.afterId = -1; this.others = []; this.messages.clear();
      batch = await this.logger.contextProjectionEvents(this.conversationId);
    }
    this.epoch = batch.epoch;
    for (const event of batch.value) {
      this.afterId = Math.max(this.afterId, event.id);
      if (event.type !== "conversation.message") { this.others.push(event); continue; }
      const value = fromLogValue(event.content, event.valueEncoding);
      const id = value && typeof value === "object" && !Array.isArray(value) ? (value as { id?: unknown }).id : undefined;
      if (typeof id !== "string") { this.others.push(event); continue; }
      const previous = this.messages.get(id);
      const valid = isConversationMessage(value);
      this.messages.set(id, { firstRaw: previous?.firstRaw ?? event,
        firstValid: previous?.firstValid ?? (valid ? event : undefined), latestValid: valid ? event : previous?.latestValid });
    }
    const projected = [...this.others];
    for (const { firstRaw, firstValid, latestValid } of this.messages.values()) {
      projected.push(firstRaw);
      if (firstValid && firstValid !== firstRaw) projected.push(firstValid);
      if (latestValid && latestValid !== firstRaw && latestValid !== firstValid) projected.push(latestValid);
    }
    projected.sort((left, right) => left.id - right.id);
    const repository = await restoreConversationRepository(projected);
    const byId = new Map(repository.messages.map((item) => [item.message.id, item]));
    const ui: ConversationMessage[] = [];
    let id = repository.headId;
    while (id) {
      const item = byId.get(id);
      if (!item) break;
      if (!isSyntheticTerminalMessage(item.message)) ui.unshift(item.message);
      id = item.parentId;
    }
    const raw = await modelMessages(ui);
    const { messages } = await effectiveContext(projected, ui.map((message) => message.id), raw);
    return { messages };
  }
}

/** Use under the extension's run lease for submit preflight, overflow recovery, and post-turn upkeep. */
export async function ensureAutomaticContextSummary(
  logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal,
  options: { forced?: boolean; languageModel?: LanguageModel; limit?: ModelLimit;
    instructions?: unknown; tools?: readonly Record<string, unknown>[] } = {},
): Promise<boolean> {
  signal.throwIfAborted();
  const source = await activeContext(logger, conversationId);
  const pressure = await contextPressure({ raw: source.raw, branchIds: source.branchIds, events: source.events,
    model, signal, limit: options.limit, instructions: options.instructions, tools: options.tools });
  if (!options.forced && (!pressure || pressure.estimated <= pressure.threshold)) return false;
  if (!source.raw.length) return false;
  // Fixed instructions/schema overhead cannot be reduced by re-summarizing an unchanged prefix.
  if (!options.forced && source.checkpoint?.sourceCount === source.raw.length) return false;
  const languageModel = options.languageModel ?? await createModel(model, logger, conversationId, { signal });
  signal.throwIfAborted();
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    model, languageModel, logger, conversationId, signal, limit: options.limit ?? pressure?.limit, force: options.forced });
  return true;
}
