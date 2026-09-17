import {
  useAui,
  type GenericThreadHistoryAdapter,
  type MessageFormatAdapter,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { readUIMessageStream, streamText, type UIMessageChunk } from "ai";
import { useMemo } from "react";
import {
  EventLogger,
  fromLogValue,
  isConversationMessage,
  rebuildConversationList,
  selectedHeadId,
  type ConversationMessage,
  type ConversationRepository,
  type ConversationSummary,
  type LogEvent,
} from "./logging";
import { abortConversationWork, registerBackgroundRequest } from "./agent/coordinator";
import { createModel } from "./agent/model";
import type { ModelConfig } from "./types";

function metadata(summary: ConversationSummary) {
  return {
    remoteId: summary.id,
    status: summary.status,
    title: summary.title,
    lastMessageAt: new Date(summary.lastMessageAt),
    custom: { runStatus: summary.runStatus, createdAt: summary.createdAt },
  };
}

function visibleText(message: ThreadMessage | ConversationMessage | undefined): string {
  if (!message) return "";
  const value = message as unknown as Record<string, unknown>;
  const parts = Array.isArray(value.content) ? value.content : Array.isArray(value.parts) ? value.parts : [];
  return parts.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
    ? [String((part as { text?: unknown }).text ?? "")]
    : []).join("\n").trim();
}

async function waitForCompletedRun(logger: EventLogger, conversationId: string, signal: AbortSignal): Promise<void> {
  if ((await logger.conversation(conversationId)).some((event) => event.type === "conversation.finished")) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      unsubscribe();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId !== conversationId || event.type !== "conversation.finished") return;
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const titleRequests = new Map<string, Promise<string>>();

export function generateConversationTitle(logger: EventLogger, config: ModelConfig, conversationId: string): Promise<string> {
  const pending = titleRequests.get(conversationId);
  if (pending) return pending;
  const task = (async () => {
    const abortController = new AbortController();
    const unregister = registerBackgroundRequest(abortController, conversationId);
    try {
      await waitForCompletedRun(logger, conversationId, abortController.signal);
      const repository = await logger.repository(conversationId);
      const firstUser = repository.messages.find(({ message }) => message.role === "user")?.message;
      const firstAssistant = repository.messages.find(({ message }) => message.role === "assistant")?.message;
      await logger.append({ type: "model.title.started", conversationId, content: null });
      const result = streamText({
        model: createModel(config, logger, conversationId),
        maxRetries: 0,
        abortSignal: abortController.signal,
        prompt: [
          "请为下面这段对话生成一个简洁的单行标题。只返回标题，不要引号、解释或标点包装。",
          `用户：${visibleText(firstUser)}`,
          `助手：${visibleText(firstAssistant)}`,
        ].join("\n\n"),
      });
      let generated = "";
      for await (const delta of result.textStream) generated += delta;
      const title = generated.trim().split(/\r?\n/, 1)[0]?.trim();
      if (!title) throw new Error("模型没有返回对话标题");
      await logger.append({
        type: "model.title.finished",
        conversationId,
        content: { title },
        stopReason: await result.finishReason,
        usage: await result.usage,
        providerMetadata: await result.providerMetadata,
      });
      const manuallyNamed = (await logger.summaryEvents(conversationId)).some((event) =>
        event.type === "conversation.title.updated" && (fromLogValue(event.content) as { source?: string }).source === "manual");
      if (!manuallyNamed) await logger.append({ type: "conversation.title.updated", conversationId, content: { title } });
      return title;
    } catch (error) {
      const aborted = abortController.signal.aborted;
      await logger.append({
        type: aborted ? "model.title.aborted" : "model.title.failed",
        conversationId,
        content: null,
        ...(aborted ? { abort: { reason: abortController.signal.reason } } : { error }),
      });
      throw error;
    } finally {
      unregister();
    }
  })();
  titleRequests.set(conversationId, task);
  void task.then(
    () => titleRequests.delete(conversationId),
    () => titleRequests.delete(conversationId),
  );
  return task;
}

function withoutId(message: ConversationMessage): Record<string, unknown> {
  const { id: _id, ...content } = message;
  return content;
}

function normalizeInterruptedMessage(message: ConversationMessage, events: readonly LogEvent[], runId: string): ConversationMessage {
  const tools = new Map<string, LogEvent>();
  for (const event of events) if (event.runId === runId && event.toolCallId) tools.set(event.toolCallId, event);
  const parts = message.parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [part];
    const value = part as Record<string, unknown>;
    if (value.type === "text" || value.type === "reasoning") return [{ ...value, state: "done" }];
    if (value.type !== "dynamic-tool" && typeof value.type === "string" && !value.type.startsWith("tool-")) return [part];
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (!toolCallId) return [part];
    const toolEvent = tools.get(toolCallId);
    if (!toolEvent) return [];
    return toolEvent.type === "tool.finished"
      ? [{ ...value, state: "output-available", output: fromLogValue(toolEvent.output) }]
      : [{ ...value, state: "output-error", errorText: "Side Panel 关闭时工具尚未完成。" }];
  });
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  return { ...message, id: message.id || `interrupted-${runId}`, parts, metadata: { ...metadata, interrupted: true } };
}

async function replayRun(events: readonly LogEvent[], terminal: LogEvent): Promise<ConversationMessage | undefined> {
  const chunks = events
    .filter((event) => event.runId === terminal.runId && event.type === "conversation.stream.chunk")
    .map((event) => fromLogValue(event.content) as UIMessageChunk);
  if (!terminal.runId || chunks.length === 0) return undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let message: ConversationMessage | undefined;
  for await (const snapshot of readUIMessageStream({ stream })) message = snapshot as ConversationMessage;
  return message?.parts.length ? normalizeInterruptedMessage(message, events, terminal.runId) : undefined;
}

export async function restoreConversationRepository(events: readonly LogEvent[]): Promise<ConversationRepository> {
  const stored = new Map<string, { eventId: number; parentId: string | null; message: ConversationMessage }>();
  const completedRuns = new Set(events
    .filter((event) => event.type === "conversation.finished" && event.runId)
    .map((event) => event.runId!));
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content);
    if (!isConversationMessage(message)) continue;
    stored.set(message.id, { eventId: event.id, parentId: event.parentId ?? null, message });
  }
  for (const terminal of events.filter((event) => event.runId && (event.type === "conversation.aborted" || event.type === "conversation.failed"))) {
    if (completedRuns.has(terminal.runId!)) continue;
    const submitted = [...events].reverse().find((event) => event.runId === terminal.runId && event.type === "conversation.submitted");
    const content = submitted ? fromLogValue(submitted.content) as { messageId?: unknown } : undefined;
    const parentId = typeof content?.messageId === "string" ? content.messageId : null;
    const persistedPartial = [...stored.values()].find((item) => item.parentId === parentId && item.message.role === "assistant");
    if (persistedPartial) {
      persistedPartial.message = normalizeInterruptedMessage(persistedPartial.message, events, terminal.runId!);
      continue;
    }
    const message = await replayRun(events, terminal);
    if (!message) continue;
    stored.set(message.id, {
      eventId: terminal.id,
      parentId,
      message,
    });
  }
  const messages = [...stored.values()].sort((left, right) => left.eventId - right.eventId).map(({ parentId, message }) => ({ parentId, message }));
  return { headId: selectedHeadId(events, stored), messages };
}

function formattedHistory<TMessage, TStorageFormat extends Record<string, unknown>>(
  format: MessageFormatAdapter<TMessage, TStorageFormat>,
  logger: EventLogger,
  getRemoteId: () => string | undefined,
  initialize: () => Promise<string>,
): GenericThreadHistoryAdapter<TMessage> {
  return {
    async load() {
      const remoteId = getRemoteId();
      if (!remoteId) return { headId: null, messages: [] };
      const repository = await restoreConversationRepository(await logger.restorationEvents(remoteId));
      return {
        headId: repository.headId,
        messages: repository.messages.map(({ parentId, message }) => format.decode({
          id: message.id,
          parent_id: parentId,
          format: format.format,
          content: withoutId(message) as TStorageFormat,
        })),
      };
    },
    async append(item) {
      const remoteId = await initialize();
      const id = format.getId(item.message);
      const encoded = { id, ...format.encode(item) } as unknown as ConversationMessage;
      if (encoded.role === "assistant" && encoded.parts.length === 0) return;
      const repository = await logger.repository(remoteId);
      if (repository.messages.some(({ message }) => message.id === id)) return;
      await logger.appendMessage(remoteId, encoded, { parentId: item.parentId });
    },
    async update(item, localMessageId) {
      const remoteId = await initialize();
      await logger.appendMessage(remoteId, { id: localMessageId, ...format.encode(item) } as unknown as ConversationMessage, { parentId: item.parentId });
    },
  };
}

export function createConversationAdapter(logger: EventLogger, config: ModelConfig): RemoteThreadListAdapter {
  async function summaries(): Promise<ConversationSummary[]> {
    return rebuildConversationList(await logger.summaryEvents());
  }

  function useConversationAdapters() {
    const aui = useAui();
    const history = useMemo<ThreadHistoryAdapter>(() => ({
      async load() {
        return { messages: [] };
      },
      async append() {},
      withFormat: (format) => formattedHistory(
        format,
        logger,
        () => aui.threadListItem.getState().remoteId,
        async () => (await aui.threadListItem.initialize()).remoteId,
      ),
    }), [aui]);
    return useMemo(() => ({ history }), [history]);
  }

  return {
    async list() {
      return { threads: (await summaries()).map(metadata) };
    },
    async initialize(threadId) {
      const exists = (await summaries()).some(({ id }) => id === threadId);
      if (!exists) await logger.append({ type: "conversation.created", conversationId: threadId, content: { title: "新对话" } });
      return { remoteId: threadId };
    },
    async rename(remoteId, title) {
      await logger.append({ type: "conversation.title.updated", conversationId: remoteId, content: { title: title.trim() || "新对话", source: "manual" } });
    },
    async archive(remoteId) {
      await logger.append({ type: "conversation.archived", conversationId: remoteId, content: null });
    },
    async unarchive(remoteId) {
      await logger.append({ type: "conversation.unarchived", conversationId: remoteId, content: null });
    },
    async delete(remoteId) {
      await abortConversationWork(remoteId);
      await logger.deleteConversation(remoteId);
    },
    async fetch(threadId) {
      const summary = (await summaries()).find(({ id }) => id === threadId);
      if (!summary) throw new Error(`Conversation "${threadId}" was not found`);
      return metadata(summary);
    },
    async generateTitle(remoteId, _messages) {
      return createAssistantStream(async (controller) => {
        controller.appendText(await generateConversationTitle(logger, config, remoteId));
      });
    },
    unstable_useAdapters: useConversationAdapters,
  };
}
