import {
  DirectChatTransport,
  readUIMessageStream,
  type Agent,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { ConversationMessage, EventLogger } from "../logging";

type SidePanelMessage = UIMessage<any, never, any>;

function runId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function logStream(
  stream: ReadableStream<UIMessageChunk>,
  logger: EventLogger,
  currentRunId: string,
): ReadableStream<UIMessageChunk> {
  const [clientStream, eventStream] = stream.tee();
  const snapshots = readUIMessageStream<SidePanelMessage>({ stream: eventStream });
  const snapshotReader = snapshots.getReader();
  const clientReader = clientStream.getReader();
  let response: SidePanelMessage | undefined;
  let text = "";
  let reasoning = "";
  let closed = false;

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
    closed = true;
    await snapshotTask;
    if (response) await logger.appendMessage(response as ConversationMessage, currentRunId);
    await logger.append({
      type,
      runId: currentRunId,
      content: response ? { messageId: response.id } : { text, reasoning },
      ...(type === "conversation.failed" ? { error: detail } : {}),
      ...(type === "conversation.aborted" ? { abort: { reason: detail ?? "stream-aborted" } } : {}),
    });
    logger.endRun(currentRunId);
  };

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const next = await clientReader.read();
        if (next.done) {
          await finish("conversation.finished");
          controller.close();
          return;
        }
        if (next.value.type === "text-delta") text += next.value.delta;
        if (next.value.type === "reasoning-delta") reasoning += next.value.delta;
        controller.enqueue(next.value);
      } catch (error) {
        await finish("conversation.failed", error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await Promise.allSettled([clientReader.cancel(reason), snapshotReader.cancel(reason)]);
      await finish("conversation.aborted", reason);
    },
  });
}

export function createChatTransport(agent: Agent<any, any, any, any>, logger: EventLogger) {
  const direct = new DirectChatTransport<any, any, any, any, SidePanelMessage>({
    agent,
    onError: (error) => error instanceof Error ? error.message : String(error),
  });

  return {
    sendMessages: async (options: Parameters<ChatTransport<SidePanelMessage>["sendMessages"]>[0]) => {
      if (options.trigger !== "submit-message") throw new Error(`Unsupported message trigger: ${options.trigger}`);
      const currentRunId = runId();
      logger.beginRun(currentRunId);

      try {
        const existing = await logger.messages();
        const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
        if (userMessage && !existing.some((message) => message.id === userMessage.id)) {
          await logger.appendMessage(userMessage as ConversationMessage, currentRunId);
        }
        const messages = await logger.messages() as SidePanelMessage[];
        await logger.append({
          type: "conversation.submitted",
          runId: currentRunId,
          content: { chatId: options.chatId, messageId: userMessage?.id ?? null },
        });
        return logStream(await direct.sendMessages({ ...options, messages }), logger, currentRunId);
      } catch (error) {
        await logger.append({ type: "conversation.failed", runId: currentRunId, content: null, error });
        logger.endRun(currentRunId);
        throw error;
      }
    },
    reconnectToStream: async () => null,
  } satisfies ChatTransport<SidePanelMessage>;
}
