import { hasSummarizableHistory } from "./context-budget";
import { type LanguageModel, type ModelMessage } from "ai";
import { isSyntheticTerminalMessage, restoreConversationRepository } from "../conversations";
import { conversationMessageHeader, type ConversationMessage, type EventLogger, type LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { contextPressure, effectiveContext, summarizeContext } from "./compaction";
import { createModel } from "./model";
import { resolveModelLimit, type ModelLimit } from "./model-limits";
import { modelDiagnosticContext } from "./diagnostics";
import { projectModelMessages } from "./context-projection";

export async function modelMessages(messages: ConversationMessage[], events: readonly LogEvent[] = []): Promise<ModelMessage[]> {
  return projectModelMessages(messages, events);
}

export async function activeContext(logger: EventLogger, conversationId: string) {
  return new IncrementalActiveContext(logger, conversationId).read();
}

export type ActiveContextSnapshot = {
  ui: ConversationMessage[]; raw: ModelMessage[]; events: LogEvent[]; branchIds: string[];
  checkpoint: Awaited<ReturnType<typeof effectiveContext>>["checkpoint"]; messages: ModelMessage[];
};

/** Per-run cache of the canonical events needed for the model-visible branch.
 * Message updates replace their previous projection; the first raw and first valid
 * events preserve selected-head and message ordering semantics of full replay.
 */
export class IncrementalActiveContext {
  private epoch?: string;
  private afterId = -1;
  private others: LogEvent[] = [];
  private snapshot?: ActiveContextSnapshot;
  private messages = new Map<string, { firstRaw: LogEvent; firstValid?: LogEvent; latestValid?: LogEvent }>();

  constructor(private logger: EventLogger, private conversationId: string) {}

  async read(): Promise<ActiveContextSnapshot> {
    let batch = await this.logger.contextProjectionEvents(this.conversationId, this.afterId);
    if (this.epoch !== undefined && this.epoch !== batch.epoch) {
      this.afterId = -1; this.others = []; this.messages.clear(); this.snapshot = undefined;
      batch = await this.logger.contextProjectionEvents(this.conversationId);
    }
    this.epoch = batch.epoch;
    if (!batch.value.length && this.snapshot) return this.snapshot;
    for (const event of batch.value) {
      this.afterId = Math.max(this.afterId, event.id);
      if (event.type !== "conversation.message") { this.others.push(event); continue; }
      const header = conversationMessageHeader(event);
      if (!header) { this.others.push(event); continue; }
      const { id, valid } = header;
      const previous = this.messages.get(id);
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
    const raw = await modelMessages(ui, projected);
    const branchIds = ui.map((message) => message.id);
    const { checkpoint, messages } = await effectiveContext(projected, branchIds, raw);
    return this.snapshot = { ui, raw, events: projected, branchIds, checkpoint, messages };
  }
}

/** Use under the extension's run lease for submit preflight, overflow recovery, and post-turn upkeep. */
export async function ensureAutomaticContextSummary(
  logger: EventLogger, conversationId: string, model: ModelConfig, signal: AbortSignal,
  options: { forced?: boolean; languageModel?: LanguageModel; limit?: ModelLimit;
    instructions?: unknown; tools?: readonly Record<string, unknown>[]; goalMode?: boolean } = {},
): Promise<boolean> {
  signal.throwIfAborted();
  const source = await activeContext(logger, conversationId);
  const limit = options.limit ?? await resolveModelLimit(model, { signal, diagnosticContext: modelDiagnosticContext(logger, conversationId) });
  const pressure = await contextPressure({ raw: source.raw, branchIds: source.branchIds, events: source.events,
    model, limit, instructions: options.instructions, tools: options.tools, goalMode: options.goalMode });
  if (!options.forced && pressure.estimated <= pressure.threshold) return false;
  if (!options.forced && !hasSummarizableHistory(pressure.messages, pressure.limit)) return false;
  if (!source.raw.length) return false;
  // Fixed instructions/schema overhead cannot be reduced by re-summarizing an unchanged prefix.
  if (!options.forced && source.checkpoint?.sourceCount === source.raw.length) return false;
  const languageModel = options.languageModel ?? await createModel(model, logger, conversationId, { signal });
  signal.throwIfAborted();
  await summarizeContext({ raw: source.raw, branchIds: source.branchIds, uiCount: source.ui.length,
    languageModel, logger, conversationId, signal, limit, force: options.forced });
  return true;
}
