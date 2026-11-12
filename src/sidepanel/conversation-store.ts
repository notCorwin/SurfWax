import { isSyntheticTerminalMessage, restoreConversationRepository } from "../conversations";
import { abortConversationWork, claimConversationRun, withIdleConversation, type ConversationRunLease } from "../agent/coordinator";
import { type ConversationTransport, type SidePanelMessage } from "../agent/transport";
import { ConversationListProjection, fromLogValue, type ConversationRepository, type ConversationSummary, type EventLogger, type LogEvent } from "../logging";

export type PartStatus = { type: "running" | "complete" | "incomplete" | "requires-action"; reason?: string; error?: unknown };
export type MessagePart =
  | { type: "text" | "reasoning"; text: string; status: PartStatus; responseTimeMs?: number; responseTimingId?: number; startedAtMs?: number; finishedAtMs?: number }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown; result?: unknown; isError?: boolean; durationMs?: number; startedAtMs?: number; finishedAtMs?: number; timingIncomplete?: boolean; interrupted?: boolean; status: PartStatus };
type ToolTiming = { durationMs?: number; startedAtMs?: number; finishedAtMs?: number; timingIncomplete?: boolean; interrupted?: boolean };
type ResponseTiming = { responseTimeMs: number; responseTimingId: number; startedAtMs: number; finishedAtMs: number };
const reasoningKey = (runId: string, messageId: string, index: number) => JSON.stringify([runId, messageId, index]);
const timingKey = (runId: string, toolCallId: string) => JSON.stringify([runId, toolCallId]);
export type MessageView = {
  id: string; runId?: string; role: SidePanelMessage["role"]; parts: readonly MessagePart[]; content: readonly MessagePart[];
  metadata: { custom?: Record<string, unknown> }; status: PartStatus;
  branchNumber: number; branchCount: number; source: SidePanelMessage;
  userBranch?: { id: string; number: number; count: number };
};
export type ThreadState = { messages: readonly MessageView[]; isRunning: boolean; isStopping: boolean; stoppingAt?: number; isLoading: boolean; isDisabled: boolean; error?: unknown };
export type ThreadItem = ConversationSummary & { remoteId: string; custom: { runStatus: string } };
export type PanelState = {
  thread: ThreadState;
  composer: { text: string };
  threadListItem: { id: string; remoteId?: string };
  threads: { mainThreadId: string; threadItems: readonly ThreadItem[]; threadIds: readonly string[] };
};

/** All durable state comes from the event log. These are disposable branch/display projections. */
export function branchMessages(repository: ConversationRepository, headId = repository.headId): SidePanelMessage[] {
  const byId = new Map(repository.messages.map((item) => [item.message.id, item]));
  const messages: SidePanelMessage[] = [];
  const seen = new Set<string>();
  while (headId && !seen.has(headId)) {
    seen.add(headId);
    const item = byId.get(headId);
    if (!item) break;
    messages.push(item.message as SidePanelMessage);
    headId = item.parentId;
  }
  return messages.reverse();
}

export function createMessageProjection() {
  let cache = new WeakMap<SidePanelMessage, { signature: string; view: MessageView }>();
  return {
    reset() { cache = new WeakMap(); },
    message(source: SidePanelMessage, running: boolean, siblings: readonly string[], runId?: string, timings: ReadonlyMap<string, ToolTiming> = new Map(), reasoningTimings: ReadonlyMap<string, ResponseTiming> = new Map()): MessageView {
      const signature = JSON.stringify([running, siblings, runId, source.parts.map((part, index) => !runId ? undefined : part.type === "reasoning" ? reasoningTimings.get(reasoningKey(runId, source.id, index)) : "toolCallId" in part ? timings.get(timingKey(runId, part.toolCallId)) : undefined)]);
      const previous = cache.get(source);
      if (previous?.signature === signature) return previous.view;
      const interrupted = source.metadata?.interrupted === true || source.metadata?.custom?.interrupted === true;
      const failure = source.metadata?.custom?.failure;
      const status: PartStatus = running ? { type: "running" }
        : failure !== undefined ? { type: "incomplete", reason: "error", error: failure }
        : interrupted ? { type: "incomplete", reason: "cancelled" } : { type: "complete" };
      const parts: MessagePart[] = source.parts.flatMap((part, index): MessagePart[] => {
        if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text, status: { type: "complete" }, ...(part.type === "reasoning" && runId ? reasoningTimings.get(reasoningKey(runId, source.id, index)) : {}) }];
        if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return [];
        const tool = part as Extract<SidePanelMessage["parts"][number], { toolCallId: string }>;
        const complete = tool.state === "output-available";
        const outputFailure = tool.output && typeof tool.output === "object"
          && ((tool.output as { ok?: unknown }).ok === false || (tool.output as { isError?: unknown }).isError === true);
        const isError = tool.state === "output-error" || tool.state === "output-denied" || Boolean(outputFailure);
        const timing = runId ? timings.get(timingKey(runId, tool.toolCallId)) : undefined;
        return [{ type: "tool-call", toolCallId: tool.toolCallId,
          toolName: "toolName" in tool ? String(tool.toolName) : tool.type.slice(5),
          args: tool.input, result: complete ? tool.output : "errorText" in tool ? tool.errorText : tool.state === "output-denied" ? "工具操作被拒绝" : undefined,
          isError, ...(timing ?? {}),
          status: { type: isError ? "incomplete" : complete ? "complete" : running ? "running" : "requires-action" } }];
      });
      const view: MessageView = { id: source.id, ...(runId ? { runId } : {}), role: source.role, parts, content: parts, source, status,
        metadata: { custom: { ...source.metadata?.custom, ...(interrupted ? { interrupted: true } : {}) } },
        branchNumber: Math.max(1, siblings.indexOf(source.id) + 1), branchCount: Math.max(1, siblings.length) };
      cache.set(source, { signature, view });
      return view;
    },
  };
}

export class ConversationStore {
  private state: PanelState;
  private listeners = new Set<() => void>();
  private repository: ConversationRepository = { headId: null, messages: [] };
  private preferredChildren = new Map<string | null, string>();
  private projection = createMessageProjection();
  private messageRuns = new Map<string, string>();
  private toolTimings = new Map<string, ToolTiming>();
  private requestStarts = new Map<string, { callId: string; startedAt: number }>();
  private responseTimings = new Map<string, ResponseTiming>();
  private reasoningTimings = new Map<string, ResponseTiming>();
  private timedMessageLengths = new Map<string, number>();
  private controller?: AbortController;
  private loadVersion = 0;
  private listCursor = -1;
  private listEpoch?: string;
  private listReload?: Promise<void>;
  private listDirty = false;
  private externalRestore?: Promise<void>;
  private externalDirty = false;
  private closed = false;
  private unsubscribe?: () => void;
  private unsubscribeCommits?: () => void;
  private conversationList = new ConversationListProjection();

  constructor(private logger: EventLogger, private transport: (id: string) => ConversationTransport, initialId: string = crypto.randomUUID()) {
    this.state = {
      thread: { messages: [], isRunning: false, isStopping: false, isLoading: false, isDisabled: false }, composer: { text: "" },
      threadListItem: { id: initialId }, threads: { mainThreadId: initialId, threadItems: [], threadIds: [] },
    };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<PanelState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private updateThread(update: Partial<ThreadState>) { this.publish({ thread: { ...this.state.thread, ...update } }); }
  private display(messages: SidePanelMessage[], liveId?: string) {
    messages = messages.filter((message) => message.metadata?.custom?.pageRefresh !== true);
    const siblings = new Map<string | null, string[]>();
    const parents = new Map<string, string | null>();
    const entries = new Map(this.repository.messages.map((entry) => [entry.message.id, entry]));
    for (const { parentId, message } of this.repository.messages) {
      parents.set(message.id, parentId);
      const group = siblings.get(parentId) ?? [];
      group.push(message.id); siblings.set(parentId, group);
    }
    this.updateThread({ messages: messages.map((message, index) => {
      const parent = parents.get(message.id) ?? messages[index - 1]?.id ?? null;
      const group = siblings.get(parent) ?? [];
      const view = this.projection.message(message, message.id === liveId, group.includes(message.id) ? group : [...group, message.id], this.messageRuns.get(message.id), this.toolTimings, this.reasoningTimings);
      const parentMessage = parent ? entries.get(parent) : undefined;
      if (message.role !== "assistant" || parentMessage?.message.role !== "user") return view;
      const userSiblings = siblings.get(parentMessage.parentId) ?? [];
      if (userSiblings.length < 2) return view;
      return { ...view, userBranch: { id: parentMessage.message.id, number: userSiblings.indexOf(parentMessage.message.id) + 1, count: userSiblings.length } };
    }) });
  }
  private remember(headId: string | null) {
    const parents = new Map(this.repository.messages.map((entry) => [entry.message.id, entry.parentId]));
    for (const message of branchMessages(this.repository, headId)) this.preferredChildren.set(parents.get(message.id) ?? null, message.id);
  }
  private restoreBranches(repository: ConversationRepository, events: readonly LogEvent[]) {
    this.repository = repository;
    this.messageRuns.clear();
    this.toolTimings.clear();
    this.requestStarts.clear();
    this.responseTimings.clear();
    this.reasoningTimings.clear();
    this.timedMessageLengths.clear();
    for (const event of events) this.ingestTiming(event);
    this.preferredChildren.clear();
    for (const event of events) if (event.type === "conversation.branch.selected") {
      const head = (fromLogValue(event.content, event.valueEncoding) as { headId?: string })?.headId;
      if (head) this.remember(head);
    }
    this.remember(this.repository.headId);
    this.projection.reset();
  }
  private ingestTiming(event: LogEvent): boolean {
    if (!event.runId) return false;
    if (event.type === "model.request.started") {
      this.responseTimings.delete(event.runId);
      const start = Date.parse(event.timestamp);
      const content = fromLogValue(event.content, event.valueEncoding) as { callId?: unknown } | null;
      if (Number.isFinite(start) && typeof content?.callId === "string") this.requestStarts.set(event.runId, { callId: content.callId, startedAt: start });
      else this.requestStarts.delete(event.runId);
      return false;
    }
    if (event.type === "model.response.received") {
      const start = this.requestStarts.get(event.runId);
      const end = Date.parse(event.timestamp);
      this.requestStarts.delete(event.runId);
      this.responseTimings.delete(event.runId);
      const content = fromLogValue(event.content, event.valueEncoding) as { callId?: unknown } | null;
      if (start && content?.callId === start.callId && Number.isFinite(end) && end >= start.startedAt) {
        this.responseTimings.set(event.runId, { responseTimeMs: end - start.startedAt, responseTimingId: event.id, startedAtMs: start.startedAt, finishedAtMs: end });
      }
      return false;
    }
    if (event.type === "conversation.message") {
      // A response belongs only to its first canonical publication. Later
      // snapshots without lifecycle events must not inherit an older duration.
      const timing = this.responseTimings.get(event.runId);
      this.responseTimings.delete(event.runId);
      this.requestStarts.delete(event.runId);
      const message = fromLogValue(event.content, event.valueEncoding) as SidePanelMessage | undefined;
      if (message && typeof message.id === "string") {
        this.messageRuns.set(message.id, event.runId);
        const key = timingKey(event.runId, message.id);
        const parts = message.parts;
        if (Array.isArray(parts)) {
          for (let index = this.timedMessageLengths.get(key) ?? 0; index < parts.length; index++) {
            if (parts[index]?.type === "reasoning" && timing) this.reasoningTimings.set(reasoningKey(event.runId, message.id, index), timing);
          }
          this.timedMessageLengths.set(key, parts.length);
        }
      }
      return false;
    }
    if (!event.toolCallId || !["tool.started", "tool.finished", "tool.failed"].includes(event.type)) return false;
    const timestamp = Date.parse(event.timestamp);
    const key = timingKey(event.runId, event.toolCallId);
    const previous = this.toolTimings.get(key) ?? {};
    if (event.type === "tool.started") {
      if (!Number.isFinite(timestamp)) return false;
      this.toolTimings.set(key, { ...previous, startedAtMs: timestamp });
      return true;
    }
    const content = fromLogValue(event.content, event.valueEncoding) as { timingIncomplete?: unknown; status?: unknown } | null;
    this.toolTimings.set(key, { ...previous, ...(Number.isFinite(timestamp) ? { finishedAtMs: timestamp } : {}),
      ...(typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 ? { durationMs: event.latencyMs } : {}),
      timingIncomplete: content?.timingIncomplete === true, interrupted: content?.status === "interrupted" });
    return true;
  }
  private async restore(id: string): Promise<LogEvent[]> {
    const events = await this.logger.restorationEvents(id, { modelTiming: true });
    this.restoreBranches(await restoreConversationRepository(events), events);
    this.display(branchMessages(this.repository));
    return events;
  }
  connect() {
    this.closed = false;
    this.unsubscribe = this.logger.subscribe((event) => {
      if (event.type === "log.cleared") { void this.threads.reload().catch((error) => this.updateThread({ error })); return; }
      if (event.conversationId === this.state.threadListItem.id && this.ingestTiming(event)) {
        const messages = this.state.thread.messages;
        this.display(messages.map((message) => message.source), messages.find((message) => message.status.type === "running")?.id);
      }
    });
    this.unsubscribeCommits = this.logger.subscribeCommits((commit) => {
      if (commit.cleared) { this.listCursor = -1; this.listEpoch = undefined; }
      const summaryChanged = commit.types.some(type => /^conversation\.(created|title\.updated|deleted|restored|submitted|finished|aborted|failed)$/.test(type));
      if (commit.cleared || summaryChanged) void this.threads.reload().catch((error) => this.updateThread({ error }));
      const messagesChanged = commit.types.some(type => /^conversation\.(message|branch\.selected|deleted|restored|finished|aborted|failed)$/.test(type));
      if (commit.external && (commit.cleared || messagesChanged && commit.conversationIds.includes(this.state.threadListItem.id)))
        void this.refreshExternal().catch((error) => this.updateThread({ error }));
    });
    void this.threads.reload().catch((error) => this.updateThread({ error }));
    return () => { this.closed = true; this.unsubscribe?.(); this.unsubscribeCommits?.(); this.thread.cancelRun(); };
  }
  composer = {
    setText: (text: string) => this.publish({ composer: { text } }),
    send: () => { const text = this.state.composer.text; if (!text.trim() || this.state.thread.isRunning) return;
      return this.thread.append(text, () => {
        if (this.state.composer.text === text) this.composer.setText("");
      }); },
  };
  thread = {
    getState: () => this.state.thread,
    subscribe: this.subscribe,
    cancelRun: () => { if (this.controller && !this.controller.signal.aborted) { this.updateThread({ isStopping: true, stoppingAt: Date.now() }); this.controller.abort(); } },
    append: (input: string | { content: readonly { type: "text"; text: string }[]; metadata?: unknown; role?: string; createdAt?: Date }, onAccepted?: () => void) => {
      const message: SidePanelMessage = { id: crypto.randomUUID(), role: "user",
        parts: typeof input === "string" ? [{ type: "text", text: input }] : [...input.content],
        ...(typeof input === "string" ? {} : { metadata: input.metadata }) };
      return this.run([...branchMessages(this.repository), message], "submit-message", undefined, onAccepted);
    },
    startRun: ({ parentId }: { parentId: string }) => this.run([], "regenerate-message", parentId),
    edit: (id: string, text: string) => {
      const item = this.repository.messages.find((entry) => entry.message.id === id);
      if (!item || !text.trim()) return;
      return this.run([{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }], "submit-message", item.parentId);
    },
    getMessageById: (id: string) => ({
      getCopyText: () => this.state.thread.messages.find((message) => message.id === id)?.parts
        .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "",
      reload: () => { const item = this.repository.messages.find((entry) => entry.message.id === id);
        if (item?.parentId) return this.thread.startRun({ parentId: item.parentId }); },
      switchToBranch: async ({ position }: { position: "previous" | "next" }) => {
        const epoch = await this.logger.canonicalEpoch();
        return withIdleConversation(async () => {
        if (this.state.thread.isRunning || this.state.thread.isLoading) return;
        const item = this.repository.messages.find((entry) => entry.message.id === id);
        if (!item) return;
        const siblings = this.repository.messages.filter((entry) => entry.parentId === item.parentId);
        let head = siblings[siblings.indexOf(item) + (position === "previous" ? -1 : 1)]?.message.id;
        if (!head) return;
        const seen = new Set<string>();
        while (!seen.has(head)) {
          seen.add(head);
          const children = this.repository.messages.filter((entry) => entry.parentId === head);
          const preferred = this.preferredChildren.get(head);
          const next = children.find((entry) => entry.message.id === preferred) ?? children.at(-1);
          if (!next) break;
          head = next.message.id;
        }
        const saved = await this.logger.appendIfEpoch({ type: "conversation.branch.selected", conversationId: this.state.threadListItem.id, content: { headId: head } }, epoch);
        if (!saved) throw new Error("日志正在维护，请稍后重试。");
        this.remember(this.repository.headId);
        this.repository = { ...this.repository, headId: head };
        this.display(branchMessages(this.repository));
        });
      },
    }),
  };
  threads = {
    reload: () => {
      this.listDirty = true;
      return this.listReload ??= (async () => {
        while (this.listDirty) {
          this.listDirty = false;
          let batch = await this.logger.summaryEventsSince(this.listCursor);
          if (this.listEpoch !== undefined && this.listEpoch !== batch.epoch) {
            this.listCursor = -1;
            batch = await this.logger.summaryEventsSince(-1);
          }
          if (this.listCursor < 0) this.conversationList.reset([]);
          this.listEpoch = batch.epoch;
          for (const event of batch.value) {
            this.conversationList.apply(event);
            this.listCursor = Math.max(this.listCursor, event.id);
          }
          this.publishThreadItems(this.conversationList.snapshot());
        }
      })().finally(() => {
        this.listReload = undefined;
        if (this.listDirty && !this.closed) void this.threads.reload().catch(error => this.updateThread({ error }));
      });
    },
    switchToNewThread: () => withIdleConversation(() => this.switchConversation(crypto.randomUUID(), false)),
    switchToThread: (id: string) => withIdleConversation(() => this.switchConversation(id, true)),
    item: ({ id }: { id: string }) => ({
      rename: async (title: string) => {
        const epoch = await this.logger.canonicalEpoch();
        return withIdleConversation(async () => {
          const saved = await this.logger.appendIfEpoch({ type: "conversation.title.updated", conversationId: id, content: { title: title.trim() || "新对话", source: "manual" } }, epoch);
          if (!saved) throw new Error("日志正在维护，请稍后重试。");
        });
      },
      delete: async () => {
        const epoch = await this.logger.canonicalEpoch();
        return withIdleConversation(async () => { await abortConversationWork(id); await this.logger.deleteConversation(id, epoch);
          if (this.state.threadListItem.id === id) await this.switchConversation(crypto.randomUUID(), false); });
      },
    }),
    restore: async (id: string) => {
      const epoch = await this.logger.canonicalEpoch();
      return withIdleConversation(() => this.logger.restoreConversation(id, epoch));
    },
  };
  private refreshExternal(): Promise<void> {
    this.externalDirty = true;
    return this.externalRestore ??= (async () => {
      while (this.externalDirty && !this.closed) {
        this.externalDirty = false;
        if (this.state.thread.isRunning) return; // run entrance replays under the lease.
        const id = this.state.threadListItem.id;
        const revision = this.loadVersion;
        const events = await this.logger.restorationEvents(id, { modelTiming: true });
        const repository = await restoreConversationRepository(events);
        if (this.closed || revision !== this.loadVersion || this.state.thread.isRunning) continue;
        const summaries = await this.logger.summaryEvents(id);
        if (this.closed || revision !== this.loadVersion || this.state.thread.isRunning) continue;
        const exists = new ConversationListProjection().reset(summaries).some((item) => item.id === id);
        if (!exists && summaries.some((event) => event.type === "conversation.deleted")) {
          await this.switchConversation(crypto.randomUUID(), false);
          continue;
        }
        this.restoreBranches(repository, events);
        this.publish({ threadListItem: { id, ...(exists ? { remoteId: id } : {}) } });
        this.display(branchMessages(repository));
      }
    })().finally(() => {
      this.externalRestore = undefined;
      if (this.externalDirty && !this.closed) void this.refreshExternal().catch(error => this.updateThread({ error }));
    });
  }
  private publishThreadItems(summaries: readonly ConversationSummary[]) {
    const items = summaries.map((item): ThreadItem => ({ ...item, remoteId: item.id, custom: { runStatus: item.runStatus } }));
    this.publish({ threads: { ...this.state.threads, threadItems: items, threadIds: items.map((item) => item.id) } });
  }
  private async switchConversation(id: string, exists: boolean) {
    if (this.state.thread.isRunning) throw new Error("当前会话尚未结束，请等待完成或先停止运行。");
    const revision = ++this.loadVersion;
    this.updateThread({ isLoading: true, error: undefined });
    try {
      if (exists) {
        const summary = await this.logger.summaryEvents(id);
        if (summary.some(event => event.type === "conversation.deleted") && !new ConversationListProjection().reset(summary).some(item => item.id === id))
          throw new Error("此会话已被删除，请选择其他会话。");
      }
      const events = exists ? await this.logger.restorationEvents(id, { modelTiming: true }) : [];
      const repository = exists ? await restoreConversationRepository(events) : { headId: null, messages: [] };
      if (revision !== this.loadVersion) return;
      this.restoreBranches(repository, events);
      this.publish({ threadListItem: { id, ...(exists ? { remoteId: id } : {}) }, composer: { text: "" }, threads: { ...this.state.threads, mainThreadId: id } });
      this.display(branchMessages(repository));
      if (exists) this.logger.telemetry({ type: "conversation.selected", conversationId: id, content: null });
    } catch (error) { if (revision === this.loadVersion) this.updateThread({ error }); throw error; }
    finally { if (revision === this.loadVersion) this.updateThread({ isLoading: false }); }
  }
  private async run(messages: SidePanelMessage[], trigger: "submit-message" | "regenerate-message", branchHead?: string | null, onAccepted?: () => void) {
    if (this.state.thread.isRunning || this.state.thread.isLoading || this.closed) return false;
    const id = this.state.threadListItem.id;
    const controller = this.controller = new AbortController();
    this.updateThread({ isRunning: true, isStopping: false, stoppingAt: undefined, error: undefined });
    let failure: unknown;
    let lease: ConversationRunLease | undefined;
    let priorFailureEventId = 0;
    let accepted = false;
    try {
      const epoch = await this.logger.canonicalEpoch();
      lease = await claimConversationRun(id, controller.signal);
      const summary = await this.logger.summaryEvents(id);
      if (summary.some(event => event.type === "conversation.deleted") && !new ConversationListProjection().reset(summary).some(item => item.id === id))
        throw new Error("此会话已被删除，请新建会话后重试；消息草稿已保留。");
      const events = await this.restore(id);
      controller.signal.throwIfAborted();
      if (branchHead != null && !this.repository.messages.some((entry) => entry.message.id === branchHead))
        throw new Error("目标消息已不可用；请重新打开会话后重试。");
      const history = branchMessages(this.repository, branchHead === undefined ? this.repository.headId : branchHead);
      messages = trigger === "submit-message" ? [...history, messages.at(-1)!] : history;
      this.display(messages);
      if (!events.some((event) => event.type === "conversation.message") && !this.state.threadListItem.remoteId) {
        if (!await this.logger.appendIfEpoch({ type: "conversation.created", conversationId: id, content: { title: "新对话" } }, epoch))
          throw new Error("日志正在维护，请稍后重试。");
        this.publish({ threadListItem: { id, remoteId: id } });
      }
      priorFailureEventId = Math.max(0, ...events
        .filter((event) => event.type === "conversation.failed").map((event) => event.id));
      controller.signal.throwIfAborted();
      const modelMessages = messages.filter((message) => !isSyntheticTerminalMessage(message));
      await this.transport(id).sendMessages({ trigger, chatId: id, messages: modelMessages, abortSignal: controller.signal, runLease: lease, expectedEpoch: epoch,
        onAccepted: () => { accepted = true; onAccepted?.(); },
        onMessage: (message, prior = []) => { if (!controller.signal.aborted) this.display([...messages, ...prior, message], message.id); } });
    } catch (error) { if (!controller.signal.aborted) failure = error; }
    finally {
      let restoredEvents: LogEvent[] = [];
      try { restoredEvents = await this.restore(id); } catch (error) { failure ??= error; }
      if (failure !== undefined) {
        const terminal = [...restoredEvents].reverse().find((event) => event.type === "conversation.failed" && event.id > priorFailureEventId);
        const submitted = terminal && [...restoredEvents].reverse().find((event) => event.type === "conversation.submitted" && event.runId === terminal.runId);
        const parentId = submitted && (fromLogValue(submitted.content, submitted.valueEncoding) as { messageId?: string } | null)?.messageId;
        const visible = this.state.thread.messages.some((message) => message.status.reason === "error" && (
          message.runId === terminal?.runId || isSyntheticTerminalMessage(message.source)
            && this.repository.messages.some((entry) => entry.message.id === message.id && entry.parentId === parentId)
        ));
        // A failed regeneration with no partial reply leaves the previous reply
        // selected. In that case the terminal event has no visible message.
        if (!visible) this.updateThread({ error: failure });
      }
      lease?.finish();
      this.controller = undefined;
      this.updateThread({ isRunning: false, isStopping: false, stoppingAt: undefined });
    }
    return accepted;
  }
}
