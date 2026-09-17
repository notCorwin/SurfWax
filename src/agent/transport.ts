import {
  DirectChatTransport,
  readUIMessageStream,
  type Agent,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { ConversationMessage, EventLogger } from "../logging";
import { claimConversationRun } from "./coordinator";
import { guardActivePage } from "../chrome/page-guard";

type SidePanelMessage = UIMessage<any, never, any>;

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
  release: () => void,
): ReadableStream<UIMessageChunk> {
  const [clientStream, eventStream] = stream.tee();
  const snapshots = readUIMessageStream<SidePanelMessage>({ stream: eventStream });
  const snapshotReader = snapshots.getReader();
  const clientReader = clientStream.getReader();
  let response: SidePanelMessage | undefined;
  let closed = false;
  let aborting = false;

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
    if (aborting && type === "conversation.finished") type = "conversation.aborted";
    closed = true;
    await snapshotTask;
    try {
      if (type === "conversation.finished" && response) {
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
      release();
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
        controller.enqueue(next.value);
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
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

export function createChatTransport(agent: Agent<any, any, any, any>, logger: EventLogger, conversationId: string) {
  const direct = new DirectChatTransport<any, any, any, any, SidePanelMessage>({
    agent,
    generateMessageId: () => globalThis.crypto.randomUUID(),
    onError: (error) => error instanceof Error ? error.message : String(error),
  });

  return {
    sendMessages: async (options: Parameters<ChatTransport<SidePanelMessage>["sendMessages"]>[0]) => {
      if (options.trigger !== "submit-message") throw new Error(`Unsupported message trigger: ${options.trigger}`);
      const currentRunId = runId();
      const lease = await claimConversationRun(conversationId, options.abortSignal);
      const releaseGuard = await guardActivePage(lease.signal).catch(() => () => undefined);
      const release = () => { releaseGuard(); lease.finish(); };

      try {
        logger.beginRun(conversationId, currentRunId);
        const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
        const existing = await logger.repository(conversationId);
        if (userMessage && !existing.messages.some(({ message }) => message.id === userMessage.id)) {
          const index = options.messages.findIndex((message) => message.id === userMessage.id);
          await logger.appendMessage(conversationId, userMessage as ConversationMessage, {
            runId: currentRunId,
            parentId: index > 0 ? options.messages[index - 1]!.id : null,
          });
        }
        await logger.append({
          type: "conversation.submitted",
          conversationId,
          runId: currentRunId,
          content: { chatId: options.chatId, messageId: userMessage?.id ?? null },
        });
        return logStream(
          await direct.sendMessages({ ...options, abortSignal: lease.signal, messages: options.messages }),
          logger,
          conversationId,
          currentRunId,
          userMessage?.id ?? null,
          lease.signal,
          release,
        );
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        try {
          await logger.append({
            type: aborted ? "conversation.aborted" : "conversation.failed",
            conversationId,
            runId: currentRunId,
            content: null,
            ...(aborted ? { abort: { reason: error.message } } : { error }),
          });
        } finally {
          logger.endRun(conversationId, currentRunId);
          release();
        }
        throw error;
      }
    },
    reconnectToStream: async () => null,
  } satisfies ChatTransport<SidePanelMessage>;
}
