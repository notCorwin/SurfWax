import {
  DirectChatTransport,
  type Agent,
  type ChatTransport,
  type ProviderMetadata,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { EventLogger, ConversationMessage } from "../logging";
import { parseChromeToolInput } from "../chrome/tool";
import type { ChromeToolMeta, ChromeToolInput, JsonValue } from "../types";

export const CHROME_TOOL_METADATA_PROVIDER = "side-agent-runtime";
export const CHROME_TOOL_METADATA_KEY = "chromeToolMeta";
type SidePanelUIMessage = UIMessage<any, never, any>;

type ChromeToolMetadataObject = Record<string, JsonValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Display title of a Chrome command: the four identifying fields of the parsed
// command, nothing else. Derived by projection — never re-parsed.
function chromeCommandMeta(command: ChromeToolInput): ChromeToolMeta {
  return {
    operation: command.operation,
    path: command.operation === "describe" || command.operation === "call" ? command.path : undefined,
    eventPath: command.operation === "waitEvent" ? command.eventPath : undefined,
    action: command.operation === "cdp" ? command.action : undefined,
    command: command.operation === "cdp" && command.action === "send" ? command.command : undefined,
  };
}

export function createChromeToolProviderMetadata(input: unknown): ProviderMetadata | undefined {
  let meta: ChromeToolMeta;
  try {
    meta = chromeCommandMeta(parseChromeToolInput(input));
  } catch {
    return undefined;
  }

  const serialized = Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
  ) as ChromeToolMetadataObject;

  return {
    [CHROME_TOOL_METADATA_PROVIDER]: {
      [CHROME_TOOL_METADATA_KEY]: serialized,
    },
  };
}

const OPERATIONS = new Set(["describe", "call", "waitEvent", "cdp"]);
const CDP_ACTIONS = new Set(["attach", "send", "detach"]);

export function readChromeToolMeta(providerMetadata: unknown): ChromeToolMeta | null {
  if (!isRecord(providerMetadata)) return null;

  const provider = providerMetadata[CHROME_TOOL_METADATA_PROVIDER];
  const value = isRecord(provider) ? provider[CHROME_TOOL_METADATA_KEY] : undefined;
  if (!isRecord(value) || typeof value.operation !== "string" || !OPERATIONS.has(value.operation)) return null;
  for (const key of ["path", "eventPath", "action", "command"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }

  const meta = value as unknown as ChromeToolMeta;
  if (meta.action !== undefined && !CDP_ACTIONS.has(meta.action)) return null;
  if (meta.operation === "call" && !meta.path) return null;
  if (meta.operation === "waitEvent" && !meta.eventPath) return null;
  if (meta.operation === "cdp" && meta.action !== "attach" && meta.action !== "detach" && !meta.command) return null;
  // ponytail: guards metadata we serialized ourselves this session; round-trip
  // through parseChromeToolInput instead if it ever crosses a persistence boundary.
  return meta;
}

export function formatToolLabel(meta: ChromeToolMeta): string {
  switch (meta.operation) {
    case "call":
      return meta.path?.trim() || "call";
    case "describe": {
      const path = meta.path?.trim();
      return path ? `describe · ${path}` : "describe";
    }
    case "waitEvent": {
      const eventPath = meta.eventPath?.trim();
      return eventPath ? `waitEvent · ${eventPath}` : "waitEvent";
    }
    case "cdp": {
      const command = meta.command?.trim();
      if (command) return `cdp · ${meta.action ?? "send"} · ${command}`;
      return meta.action ? `cdp · ${meta.action}` : "cdp";
    }
  }
}

function attachProviderMetadata(
  chunk: UIMessageChunk,
  providerMetadata: ProviderMetadata,
): UIMessageChunk {
  const existing = (chunk as { providerMetadata?: ProviderMetadata }).providerMetadata;
  return {
    ...chunk,
    providerMetadata: {
      ...existing,
      ...providerMetadata,
    },
  } as UIMessageChunk;
}

export function enrichChromeToolStream(
  stream: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  const metadataByToolCall = new Map<string, ProviderMetadata>();

  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (
          (chunk.type === "tool-input-available" || chunk.type === "tool-input-error") &&
          chunk.toolName === "chrome"
        ) {
          const providerMetadata = createChromeToolProviderMetadata(chunk.input);
          if (providerMetadata) {
            if (chunk.type === "tool-input-available") {
              metadataByToolCall.set(chunk.toolCallId, providerMetadata);
            }
            controller.enqueue(attachProviderMetadata(chunk, providerMetadata));
            return;
          }
        }

        if (chunk.type === "tool-output-available" || chunk.type === "tool-output-error") {
          const providerMetadata = metadataByToolCall.get(chunk.toolCallId);
          if (providerMetadata) {
            controller.enqueue(attachProviderMetadata(chunk, providerMetadata));
            if (chunk.type === "tool-output-error" || !chunk.preliminary) {
              metadataByToolCall.delete(chunk.toolCallId);
            }
            return;
          }
        }

        controller.enqueue(chunk);
      },
      flush() {
        metadataByToolCall.clear();
      },
    }),
  );
}

function createRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function trackChatStream(
  stream: ReadableStream<UIMessageChunk>,
  logger: EventLogger | undefined,
  runId: string,
): ReadableStream<UIMessageChunk> {
  if (!logger) return stream;

  const [clientStream, logStream] = stream.tee();
  const responseStream = readUIMessageStream<SidePanelUIMessage>({ stream: logStream as ReadableStream<UIMessageChunk> });
  const responseReader = responseStream.getReader();
  let responseMessage: SidePanelUIMessage | undefined;
  const responseTask = (async () => {
    try {
      while (true) {
        const next = await responseReader.read();
        if (next.done) break;
        responseMessage = next.value;
      }
    } catch {
      // The client stream still owns the visible error; retain the last valid snapshot.
    } finally {
      responseReader.releaseLock();
    }
  })();
  const clientReader = clientStream.getReader();
  let text = "";
  let reasoning = "";
  let closed = false;

  const finish = async (event: string, payload: unknown) => {
    if (closed) return;
    closed = true;
    await responseTask;
    if (responseMessage) await logger.appendMessage(responseMessage as ConversationMessage, runId);
    logger.record({ category: "conversation", type: event, runId, content: payload });
    if (responseMessage) {
      logger.record({
        category: "conversation",
        type: event === "stream.cancelled" ? "conversation.aborted" : "conversation.finished",
        runId,
        content: { messageId: responseMessage.id },
        ...(event === "stream.cancelled" ? { abort: { reason: "stream-aborted" } } : {}),
      });
    }
    logger.endRun(runId);
  };

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const next = await clientReader.read();
        if (next.done) {
          await finish("stream.finished", { text, reasoning });
          controller.close();
          return;
        }

        const chunk = next.value;
        if (chunk.type === "text-delta") text += chunk.delta;
        if (chunk.type === "reasoning-delta") reasoning += chunk.delta;
        controller.enqueue(chunk);
      } catch (error) {
        await finish("stream.failed", { error, text, reasoning });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await Promise.all([clientReader.cancel(reason), responseReader.cancel(reason)]);
      await finish("stream.cancelled", { reason, text, reasoning });
    },
  });
}

export function createChromeChatTransport(agent: Agent<any, any, any, any>, logger?: EventLogger) {
  return {
    sendMessages: async (options: Parameters<ChatTransport<SidePanelUIMessage>["sendMessages"]>[0]) => {
      const runId = createRunId();
      logger?.beginRun(runId);
      try {
        let messages = options.messages;
        if (logger) {
          const existing = await logger.messages();
          const latestUserMessage = [...options.messages].reverse().find((message) => message.role === "user");
          if (options.trigger === "submit-message" && latestUserMessage) {
            const previous = existing.find((message) => message.id === latestUserMessage.id);
            if (!previous || JSON.stringify(previous) !== JSON.stringify(latestUserMessage)) {
              await logger.appendMessage(latestUserMessage as ConversationMessage, runId);
            }
          }

          const canonical = await logger.messages();
          if (options.trigger === "regenerate-message" && options.messageId) {
            const messageIndex = canonical.findIndex((message) => message.id === options.messageId);
            messages = (messageIndex >= 0 ? canonical.slice(0, messageIndex) : canonical) as SidePanelUIMessage[];
          } else {
            messages = canonical as SidePanelUIMessage[];
          }
          await logger.appendContext(messages.map((message) => message.id), runId);
          logger.record({
            category: "conversation",
            type: "conversation.submitted",
            runId,
            content: { chatId: options.chatId, messageId: options.messageId, trigger: options.trigger, message: latestUserMessage },
          });
        }

        const direct = new DirectChatTransport<any, any, any, any, SidePanelUIMessage>({
          agent,
          onError: (error) => error instanceof Error ? error.message : String(error),
        });
        const stream = await direct.sendMessages({ ...options, messages });
        return trackChatStream(enrichChromeToolStream(stream), logger, runId);
      } catch (error) {
        logger?.record({ category: "conversation", type: "conversation.failed", runId, content: { error }, error, level: "error" });
        logger?.endRun(runId);
        throw error;
      }
    },
    reconnectToStream: async (_options: Parameters<ChatTransport<SidePanelUIMessage>["reconnectToStream"]>[0]) => {
      return null;
    },
  };
}
