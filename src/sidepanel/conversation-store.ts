import type { ChatTransport } from "ai";
import { readMessageSnapshots } from "../agent/message-snapshots";
import { restoreConversationRepository } from "../conversations";
import { abortConversationWork, withIdleConversation } from "../agent/coordinator";
import type { SidePanelMessage } from "../agent/transport";
import { ConversationListProjection, fromLogValue, type ConversationRepository, type ConversationSummary, type EventLogger, type LogEvent } from "../logging";

export type PartStatus = { type: "running" | "complete" | "incomplete" | "requires-action"; reason?: string; error?: unknown };
export type MessagePart =
  | { type: "text" | "reasoning"; text: string; status: PartStatus }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown; argsText?: string; result?: unknown; isError?: boolean; inputStreaming: boolean; status: PartStatus };
export type MessageView = {
  id: string; role: SidePanelMessage["role"]; parts: readonly MessagePart[]; content: readonly MessagePart[];
  metadata: { custom?: Record<string, unknown> }; status: PartStatus;
  branchNumber: number; branchCount: number; source: SidePanelMessage;
};
export type ThreadState = { messages: readonly MessageView[]; isRunning: boolean; isLoading: boolean; isDisabled: boolean; error?: unknown };
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
    message(source: SidePanelMessage, running: boolean, siblings: readonly string[]): MessageView {
      const signature = `${running}:${siblings.join(":")}`;
      const previous = cache.get(source);
      if (previous?.signature === signature) return previous.view;
      const interrupted = source.metadata?.interrupted === true || source.metadata?.custom?.interrupted === true;
      const failure = source.metadata?.custom?.failure;
      const status: PartStatus = running ? { type: "running" }
        : failure !== undefined ? { type: "incomplete", reason: "error", error: failure }
        : interrupted ? { type: "incomplete", reason: "cancelled" } : { type: "complete" };
      const parts: MessagePart[] = source.parts.flatMap((part): MessagePart[] => {
        if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text,
          status: running && part.state === "streaming" ? { type: "running" } : { type: "complete" } }];
        if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return [];
        const tool = part as Extract<SidePanelMessage["parts"][number], { toolCallId: string }>;
        const complete = tool.state === "output-available";
        const outputFailure = tool.output && typeof tool.output === "object"
          && ((tool.output as { ok?: unknown }).ok === false || (tool.output as { isError?: unknown }).isError === true);
        const isError = tool.state === "output-error" || tool.state === "output-denied" || Boolean(outputFailure);
        return [{ type: "tool-call", toolCallId: tool.toolCallId,
          toolName: "toolName" in tool ? String(tool.toolName) : tool.type.slice(5),
          args: tool.input, result: complete ? tool.output : "errorText" in tool ? tool.errorText : tool.state === "output-denied" ? "工具操作被拒绝" : undefined,
          inputStreaming: tool.state === "input-streaming", isError,
          status: { type: isError ? "incomplete" : complete ? "complete" : running ? "running" : "requires-action" } }];
      });
      const view: MessageView = { id: source.id, role: source.role, parts, content: parts, source, status,
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
  private controller?: AbortController;
  private loadVersion = 0;
  private listVersion = 0;
  private closed = false;
  private unsubscribe?: () => void;
  private conversationList = new ConversationListProjection();

  constructor(private logger: EventLogger, private transport: (id: string) => ChatTransport<SidePanelMessage>, initialId: string = crypto.randomUUID()) {
    this.state = {
      thread: { messages: [], isRunning: false, isLoading: false, isDisabled: false }, composer: { text: "" },
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
    const siblings = new Map<string | null, string[]>();
    const parents = new Map<string, string | null>();
    for (const { parentId, message } of this.repository.messages) {
      parents.set(message.id, parentId);
      const group = siblings.get(parentId) ?? [];
      group.push(message.id); siblings.set(parentId, group);
    }
    this.updateThread({ messages: messages.map((message, index) => {
      const parent = parents.get(message.id) ?? messages[index - 1]?.id ?? null;
      const group = siblings.get(parent) ?? [];
      return this.projection.message(message, message.id === liveId, group.includes(message.id) ? group : [...group, message.id]);
    }) });
  }
  private remember(headId: string | null) {
    const parents = new Map(this.repository.messages.map((entry) => [entry.message.id, entry.parentId]));
    for (const message of branchMessages(this.repository, headId)) this.preferredChildren.set(parents.get(message.id) ?? null, message.id);
  }
  private restoreBranches(repository: ConversationRepository, events: readonly LogEvent[]) {
    this.repository = repository;
    this.preferredChildren.clear();
    for (const event of events) if (event.type === "conversation.branch.selected") {
      const head = (fromLogValue(event.content) as { headId?: string })?.headId;
      if (head) this.remember(head);
    }
    this.remember(this.repository.headId);
    this.projection.reset();
  }
  private async restore(id: string): Promise<LogEvent[]> {
    const events = await this.logger.restorationEvents(id);
    this.restoreBranches(await restoreConversationRepository(events), events);
    this.display(branchMessages(this.repository));
    return events;
  }
  connect() {
    this.closed = false;
    this.unsubscribe = this.logger.subscribe((event) => {
      if (event.type === "log.cleared") { void this.threads.reload().catch((error) => this.updateThread({ error })); return; }
      if (/^conversation\.(created|title\.updated|deleted|restored|submitted|finished|aborted|failed)$/.test(event.type))
        void this.threads.reload().catch((error) => this.updateThread({ error }));
    });
    void this.threads.reload().catch((error) => this.updateThread({ error }));
    return () => { this.closed = true; this.unsubscribe?.(); this.thread.cancelRun(); };
  }
  composer = {
    setText: (text: string) => this.publish({ composer: { text } }),
    send: () => { const text = this.state.composer.text; if (!text.trim() || this.state.thread.isRunning) return;
      this.composer.setText(""); return this.thread.append(text); },
  };
  thread = {
    getState: () => this.state.thread,
    subscribe: this.subscribe,
    cancelRun: () => { this.controller?.abort(); },
    append: (input: string | { content: readonly { type: "text"; text: string }[]; metadata?: unknown; role?: string; createdAt?: Date }) => {
      const message: SidePanelMessage = { id: crypto.randomUUID(), role: "user",
        parts: typeof input === "string" ? [{ type: "text", text: input }] : [...input.content],
        ...(typeof input === "string" ? {} : { metadata: input.metadata }) };
      return this.run([...branchMessages(this.repository), message], "submit-message");
    },
    startRun: ({ parentId }: { parentId: string }) => this.run(branchMessages(this.repository, parentId), "regenerate-message"),
    edit: (id: string, text: string) => {
      const item = this.repository.messages.find((entry) => entry.message.id === id);
      if (!item || !text.trim()) return;
      return this.run([...branchMessages(this.repository, item.parentId), { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }], "submit-message");
    },
    getMessageById: (id: string) => ({
      getCopyText: () => this.state.thread.messages.find((message) => message.id === id)?.parts
        .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "",
      reload: () => { const item = this.repository.messages.find((entry) => entry.message.id === id);
        if (item?.parentId) return this.thread.startRun({ parentId: item.parentId }); },
      switchToBranch: ({ position }: { position: "previous" | "next" }) => withIdleConversation(async () => {
        if (this.state.thread.isRunning || this.state.thread.isLoading) return;
        const item = this.repository.messages.find((entry) => entry.message.id === id);
        if (!item) return;
        this.remember(this.repository.headId);
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
        await this.logger.append({ type: "conversation.branch.selected", conversationId: this.state.threadListItem.id, content: { headId: head } });
        this.repository = { ...this.repository, headId: head };
        this.display(branchMessages(this.repository));
      }),
    }),
  };
  threads = {
    reload: async () => {
      const revision = ++this.listVersion;
      const summaries = this.conversationList.reset(await this.logger.summaryEvents());
      if (revision !== this.listVersion) return;
      this.publishThreadItems(summaries);
    },
    switchToNewThread: () => this.switchConversation(crypto.randomUUID(), false),
    switchToThread: (id: string) => this.switchConversation(id, true),
    item: ({ id }: { id: string }) => ({
      rename: (title: string) => withIdleConversation(() => this.logger.append({ type: "conversation.title.updated", conversationId: id, content: { title: title.trim() || "新对话", source: "manual" } })),
      delete: () => withIdleConversation(async () => { await abortConversationWork(id); await this.logger.deleteConversation(id);
        if (this.state.threadListItem.id === id) await this.switchConversation(crypto.randomUUID(), false); }),
    }),
    restore: (id: string) => withIdleConversation(() => this.logger.restoreConversation(id)),
  };
  private publishThreadItems(summaries: readonly ConversationSummary[]) {
    const items = summaries.map((item): ThreadItem => ({ ...item, remoteId: item.id, custom: { runStatus: item.runStatus } }));
    this.publish({ threads: { ...this.state.threads, threadItems: items, threadIds: items.map((item) => item.id) } });
  }
  private async switchConversation(id: string, exists: boolean) {
    if (this.state.thread.isRunning) throw new Error("当前会话尚未结束，请等待完成或先停止运行。");
    const revision = ++this.loadVersion;
    this.updateThread({ isLoading: true, error: undefined });
    try {
      const events = exists ? await this.logger.restorationEvents(id) : [];
      const repository = exists ? await restoreConversationRepository(events) : { headId: null, messages: [] };
      if (revision !== this.loadVersion) return;
      this.restoreBranches(repository, events);
      this.publish({ threadListItem: { id, ...(exists ? { remoteId: id } : {}) }, composer: { text: "" }, threads: { ...this.state.threads, mainThreadId: id } });
      this.display(branchMessages(repository));
      if (exists) this.logger.telemetry({ type: "conversation.selected", conversationId: id, content: null });
    } catch (error) { this.updateThread({ error }); throw error; }
    finally { if (revision === this.loadVersion) this.updateThread({ isLoading: false }); }
  }
  private async run(messages: SidePanelMessage[], trigger: "submit-message" | "regenerate-message") {
    if (this.state.thread.isRunning || this.state.thread.isLoading || this.closed) return;
    const id = this.state.threadListItem.id;
    const controller = this.controller = new AbortController();
    this.updateThread({ isRunning: true, error: undefined });
    this.display(messages);
    let failure: unknown;
    const priorFailureEventId = Math.max(0, ...(await this.logger.restorationEvents(id))
      .filter((event) => event.type === "conversation.failed").map((event) => event.id));
    let partial: SidePanelMessage | undefined;
    try {
      if (!this.state.threadListItem.remoteId) {
        await this.logger.append({ type: "conversation.created", conversationId: id, content: { title: "新对话" } });
        this.publish({ threadListItem: { id, remoteId: id } });
      }
      controller.signal.throwIfAborted();
      const user = messages.at(-1);
      if (user?.role === "user" && !this.repository.messages.some((item) => item.message.id === user.id)) {
        await this.logger.appendMessage(id, { ...user }, { parentId: messages.at(-2)?.id ?? null });
      }
      const stream = await this.transport(id).sendMessages({ trigger, chatId: id, messageId: undefined, messages, abortSignal: controller.signal });
      for await (const message of readMessageSnapshots<SidePanelMessage>(stream, (error) => { if (!controller.signal.aborted) failure = error; })) {
        partial = message;
        this.display([...messages, message], message.id);
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
    finally {
      let restoredEvents: LogEvent[] = [];
      try { restoredEvents = await this.restore(id); } catch (error) { failure ??= error; }
      if (failure !== undefined) {
        const recorded = restoredEvents.some((event) => event.type === "conversation.failed" && event.id > priorFailureEventId);
        if (!recorded) this.updateThread({ error: failure });
      }
      this.controller = undefined;
      this.updateThread({ isRunning: false });
    }
  }
}
