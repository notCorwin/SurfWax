import {
  DirectChatTransport,
  readUIMessageStream,
  type Agent,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { fromLogValue, type ConversationMessage, type EventLogger } from "../logging";
import { claimConversationRun } from "./coordinator";
import { guardActivePage } from "../chrome/page-guard";
import { ensureConversationPrompt } from "./prompt";
import { materializeToolCatalog } from "./tool-catalog";
import { recoverModelStream } from "./stream-recovery";

export type SidePanelMessage = UIMessage<any, never, any>;

export function followupDispatch(message: SidePanelMessage | undefined): { id: string; mode: "followup" | "immediate" } | undefined {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const custom = (metadata as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return undefined;
  const id = (custom as { followupId?: unknown }).followupId;
  const mode = (custom as { followupMode?: unknown }).followupMode;
  return typeof id === "string" && (mode === "followup" || mode === "immediate") ? { id, mode } : undefined;
}

function runId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function logStream(
  stream: ReadableStream<UIMessageChunk>,
  logger: EventLogger,
  conversationId: string,
  currentRunId: string,
  parentId: string | null,
  signal: AbortSignal,
  release: () => void | Promise<void>,
): ReadableStream<UIMessageChunk> {
  const [clientStream, eventStream] = stream.tee();
  const snapshots = readUIMessageStream<SidePanelMessage>({ stream: eventStream });
  const snapshotReader = snapshots.getReader();
  const clientReader = clientStream.getReader();
  let response: SidePanelMessage | undefined;
  let closed = false;
  let aborting = false;
  let streamError: string | undefined;

  const snapshotTask = (async () => {
    try {
      while (true) {
        const next = await snapshotReader.read();
        if (next.done) return;
        response = next.value;
      }
    } catch {
      // The visible stream owns the error. Keep the last valid message snapshot.
    }
  })();

  const finish = async (type: "conversation.finished" | "conversation.failed" | "conversation.aborted", detail?: unknown) => {
    if (closed) return;
    if (streamError && !signal.aborted && !aborting) {
      type = "conversation.failed";
      detail = streamError;
    }
    if (aborting && type === "conversation.finished") type = "conversation.aborted";
    closed = true;
    await snapshotTask;
    try {
      await logger.closePendingTools(currentRunId, conversationId, detail ?? type);
      if (response?.parts.length) {
        await logger.appendMessage(conversationId, response as ConversationMessage, {
          runId: currentRunId,
          parentId,
        });
      }
      await logger.append({
        type,
        conversationId,
        runId: currentRunId,
        content: response ? { messageId: response.id } : null,
        ...(type === "conversation.failed" ? { error: detail } : {}),
        ...(type === "conversation.aborted" ? { abort: { reason: detail ?? "stream-aborted" } } : {}),
      });
    } finally {
      logger.endRun(conversationId, currentRunId);
      await release();
    }
  };

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const next = await clientReader.read();
        if (next.done) {
          await finish(signal.aborted ? "conversation.aborted" : "conversation.finished", signal.reason);
          controller.close();
          return;
        }
        logger.record({
          type: "conversation.stream.chunk",
          conversationId,
          runId: currentRunId,
          content: next.value,
        });
        if (next.value.type === "error") streamError = next.value.errorText;
        controller.enqueue(next.value);
      } catch (error) {
        const aborted = signal.aborted || error instanceof Error && error.name === "AbortError";
        await finish(aborted ? "conversation.aborted" : "conversation.failed", error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      aborting = true;
      await Promise.allSettled([clientReader.cancel(reason), snapshotReader.cancel(reason)]);
      await finish("conversation.aborted", reason);
    },
  });
}

export function createChatTransport(agent: (signal: AbortSignal, branchIds: string[], resumed?: boolean) => Agent<any, any, any, any> | Promise<Agent<any, any, any, any>>, logger: EventLogger, conversationId: string, cleanup?: () => Promise<void>, onContextOverflow?: (signal: AbortSignal) => Promise<void>, systemPrompt?: string) {
  return {
    sendMessages: async (options: Parameters<ChatTransport<SidePanelMessage>["sendMessages"]>[0]) => {
      if (options.trigger !== "submit-message" && options.trigger !== "regenerate-message") {
        throw new Error(`Unsupported message trigger: ${options.trigger}`);
      }
      const currentRunId = runId();
      const lease = await claimConversationRun(conversationId, options.abortSignal, currentRunId);
      const releaseGuard = await guardActivePage(lease.signal).catch(() => () => undefined);
      const release = async () => { try { await cleanup?.(); } finally { releaseGuard(); lease.finish(); } };

      try {
        logger.beginRun(conversationId, currentRunId);
        await ensureConversationPrompt(logger, conversationId, systemPrompt, options.messages.map((message) => message.id));
        const existing = await logger.repository(conversationId);
        // UI snapshots can omit custom metadata; restore it from the canonical message.
        options = { ...options, messages: options.messages.map((message) => {
          const saved = existing.messages.find((entry) => entry.message.id === message.id)?.message;
          return saved?.metadata ? { ...message, metadata: saved.metadata } : message;
        }) };
        const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
        if (userMessage && !existing.messages.some(({ message }) => message.id === userMessage.id)) {
          const index = options.messages.findIndex((message) => message.id === userMessage.id);
          await logger.appendMessage(conversationId, userMessage as ConversationMessage, {
            runId: currentRunId,
            parentId: index > 0 ? options.messages[index - 1]!.id : null,
          });
        }
        const dispatched = followupDispatch(userMessage);
        if (dispatched) await logger.append({
          type: "conversation.followup.dispatched",
          conversationId,
          runId: currentRunId,
          content: dispatched,
        });
        await logger.append({
          type: "conversation.submitted",
          conversationId,
          runId: currentRunId,
          content: { chatId: options.chatId, messageId: userMessage?.id ?? null },
        });
        const messageId = globalThis.crypto.randomUUID();
        let resumed = false;
        const stream = recoverModelStream({
          messages: options.messages, signal: lease.signal, logger, conversationId, runId: currentRunId, parentId: userMessage?.id ?? null,
          onContextOverflow,
          prepareMessages: async (messages) => {
            const canonical = await logger.repository(conversationId);
            const saved = new Map(canonical.messages.map((entry) => [entry.message.id, entry.message]));
            return messages.map((message) => saved.get(message.id)?.metadata
              ? { ...message, metadata: saved.get(message.id)!.metadata } : message);
          },
          open: async (messages, captureError, phaseSignal) => {
            // Fresh prepare state sees new checkpoints and the expanded durable
            // branch after a disconnect. The executor keeps its bound browser.
            const runAgent = await agent(phaseSignal, messages.map((message) => message.id), resumed);
            resumed = true;
            const direct = new DirectChatTransport<any, any, any, any, SidePanelMessage>({ agent: runAgent,
              generateMessageId: () => messageId,
              onError: (error) => { captureError(error); return error instanceof Error ? error.message : String(error); },
            });
            return direct.sendMessages({ ...options, abortSignal: phaseSignal, messages: messages.map(materializeToolCatalog) as SidePanelMessage[] });
          },
        });
        return logStream(
          stream,
          logger,
          conversationId,
          currentRunId,
          userMessage?.id ?? null,
          lease.signal,
          release,
        );
      } catch (error) {
        const aborted = lease.signal.aborted || error instanceof Error && error.name === "AbortError";
        try {
          await logger.append({
            type: aborted ? "conversation.aborted" : "conversation.failed",
            conversationId,
            runId: currentRunId,
            content: null,
            ...(aborted ? { abort: { reason: lease.signal.reason ?? String(error) } } : { error }),
          });
        } finally {
          logger.endRun(conversationId, currentRunId);
          await release();
        }
        throw error;
      }
    },
    reconnectToStream: async () => null,
  } satisfies ChatTransport<SidePanelMessage>;
}
