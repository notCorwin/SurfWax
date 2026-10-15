import { readUIMessageStream, streamText, type UIMessageChunk } from "ai";
import {
  EventLogger,
  fromLogValue,
  isConversationMessage,
  selectedHeadId,
  type ConversationMessage,
  type ConversationRepository,
  type LogEvent,
} from "./logging";
import { registerBackgroundRequest } from "./agent/coordinator";
import { createModel, retryModelOperation } from "./agent/model";
import type { ModelConfig } from "./types";

function visibleText(message: ConversationMessage | undefined): string {
  if (!message) return "";
  const value = message as unknown as Record<string, unknown>;
  const parts = Array.isArray(value.content) ? value.content : Array.isArray(value.parts) ? value.parts : [];
  return parts.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
    ? [String((part as { text?: unknown }).text ?? "")]
    : []).join("\n").trim();
}

async function waitForCompletedRun(logger: EventLogger, conversationId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      error === undefined ? resolve() : reject(error);
    };
    const onAbort = () => {
      finish(signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError"));
    };
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId !== conversationId || event.type !== "conversation.finished") return;
      finish();
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    void logger.conversation(conversationId).then((events) => {
      if (events.some((event) => event.type === "conversation.finished")) finish();
    }, finish);
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
      const manual = [...await logger.summaryEvents(conversationId)].reverse().find((event) =>
        event.type === "conversation.title.updated" && (fromLogValue(event.content) as { source?: string }).source === "manual");
      if (manual) return (fromLogValue(manual.content) as { title: string }).title;
      const repository = await logger.repository(conversationId);
      const firstUser = repository.messages.find(({ message }) => message.role === "user")?.message;
      const firstAssistant = repository.messages.find(({ message }) => message.role === "assistant")?.message;
      await logger.append({ type: "model.title.started", conversationId, content: null });
      const model = await createModel(config, logger, conversationId, { signal: abortController.signal });
      const { result, generated } = await retryModelOperation(async () => {
        let streamError: unknown;
        const result = streamText({
        model,
        onError: ({ error }) => { streamError = error; },
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
        // A clean EOF without a provider finish is also an interrupted request.
        if (streamError) throw streamError;
        if (await result.finishReason === "other") throw new TypeError("Title stream ended before completion");
        return { result, generated };
      }, { signal: abortController.signal, logger, conversationId, purpose: "title" });
      const title = [...(generated.trim().split(/\r?\n/, 1)[0]?.trim() ?? "")].slice(0, 120).join("");
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

function normalizeTerminalMessage(message: ConversationMessage, events: readonly LogEvent[], terminal: LogEvent): ConversationMessage {
  const runId = terminal.runId!;
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
    return toolEvent.output !== undefined
      ? [{ ...value, state: "output-available", output: fromLogValue(toolEvent.output) }]
      : [{ ...value, state: "output-error", errorText: String((fromLogValue(toolEvent.error) as { message?: string })?.message ?? fromLogValue(toolEvent.error) ?? "工具调用已中断。") }];
  });
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  const custom = metadata.custom && typeof metadata.custom === "object" && !Array.isArray(metadata.custom)
    ? metadata.custom as Record<string, unknown> : {};
  return terminal.type === "conversation.failed"
    ? { ...message, id: message.id || `failed-${runId}`, parts, metadata: { ...metadata,
      custom: { ...custom, interrupted: false, failure: fromLogValue(terminal.error) ?? "模型请求失败" } } }
    : { ...message, id: message.id || `interrupted-${runId}`, parts, metadata: { ...metadata,
      interrupted: true, custom: { ...custom, interrupted: true } } };
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
  return message?.parts.length ? normalizeTerminalMessage(message, events, terminal) : undefined;
}

export async function restoreConversationRepository(events: readonly LogEvent[]): Promise<ConversationRepository> {
  const stored = new Map<string, { eventId: number; firstEventId: number; runId?: string; parentId: string | null; message: ConversationMessage }>();
  const completedRuns = new Set(events
    .filter((event) => event.type === "conversation.finished" && event.runId)
    .map((event) => event.runId!));
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content);
    if (!isConversationMessage(message)) continue;
    stored.set(message.id, { eventId: event.id, firstEventId: stored.get(message.id)?.firstEventId ?? event.id, runId: event.runId, parentId: event.parentId ?? null, message });
  }
  for (const terminal of events.filter((event) => event.runId && (event.type === "conversation.aborted" || event.type === "conversation.failed"))) {
    if (completedRuns.has(terminal.runId!)) continue;
    const submitted = [...events].reverse().find((event) => event.runId === terminal.runId && event.type === "conversation.submitted");
    const content = submitted ? fromLogValue(submitted.content) as { messageId?: unknown } : undefined;
    const parentId = typeof content?.messageId === "string" ? content.messageId : null;
    const persistedPartial = [...stored.values()].find((item) => item.runId === terminal.runId && item.parentId === parentId && item.message.role === "assistant");
    if (persistedPartial) {
      persistedPartial.message = normalizeTerminalMessage(persistedPartial.message, events, terminal);
      continue;
    }
    const message = await replayRun(events, terminal);
    const siblings = [...stored.entries()].filter(([, item]) => item.parentId === parentId && item.message.role === "assistant");
    const synthetic = siblings.filter(([, item]) => item.message.id.startsWith("failed-")
      && (item.message.metadata as { custom?: { syntheticTerminal?: boolean } } | undefined)?.custom?.syntheticTerminal === true);
    // A failed regeneration must preserve a real prior reply, while a newer
    // output-free terminal supersedes an older synthetic diagnostic.
    if (!message && siblings.some(([, item]) => !synthetic.some(([id]) => id === item.message.id))) continue;
    const previousSynthetic = synthetic[0]?.[1];
    const syntheticId = synthetic[0]?.[0] ?? `failed-${terminal.runId}`;
    for (const [id] of synthetic.slice(1)) stored.delete(id);
    const restored = message ?? {
      id: syntheticId,
      role: "assistant" as const,
      parts: [],
      metadata: terminal.type === "conversation.aborted"
        ? { custom: { interrupted: true, syntheticTerminal: true } }
        : { custom: { failure: fromLogValue(terminal.error) ?? "模型请求失败", syntheticTerminal: true } },
    };
    stored.set(restored.id, {
      eventId: previousSynthetic?.eventId ?? terminal.id,
      firstEventId: previousSynthetic?.firstEventId ?? terminal.id,
      parentId,
      message: restored,
    });
  }
  const messages = [...stored.values()].sort((left, right) => left.firstEventId - right.firstEventId).map(({ parentId, message }) => ({ parentId, message }));
  return { headId: selectedHeadId(events, stored), messages };
}

export async function activeConversationMessages(logger: EventLogger, conversationId: string): Promise<ConversationMessage[]> {
  const repository = await restoreConversationRepository(await logger.restorationEvents(conversationId));
  const byId = new Map(repository.messages.map((item) => [item.message.id, item]));
  const messages: ConversationMessage[] = [];
  let id = repository.headId;
  while (id) {
    const item = byId.get(id);
    if (!item) break;
    if (!isSyntheticTerminalMessage(item.message)) messages.unshift(item.message);
    id = item.parentId;
  }
  return messages;
}

export function isSyntheticTerminalMessage(message: object): boolean {
  return ((message as { metadata?: { custom?: { syntheticTerminal?: boolean } } }).metadata)?.custom?.syntheticTerminal === true;
}
