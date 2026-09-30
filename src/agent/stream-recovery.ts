import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { fromLogValue, type EventLogger, type ConversationMessage } from "../logging";
import { isContextOverflowError, isRecoverableModelError, retryBackoffDelay, waitForModelRetry } from "./model";

type OpenPhase = (messages: UIMessage[], captureError: (error: unknown) => void, signal: AbortSignal) => Promise<ReadableStream<UIMessageChunk>>;
async function snapshot(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  let latest: UIMessage | undefined;
  try {
    for await (const message of readUIMessageStream({ stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) })) latest = message;
  } catch { /* Keep complete text and accepted tool results from the last snapshot. */ }
  return latest;
}
/** Resume an interrupted request from durable text/results, without re-running accepted tool calls. */
export function recoverModelStream(options: { open: OpenPhase; messages: UIMessage[]; signal: AbortSignal; logger: EventLogger; conversationId: string; runId: string; parentId: string | null; sleep?: (ms: number) => Promise<void>;
  prepareMessages?: (messages: UIMessage[]) => Promise<UIMessage[]>; onContextOverflow?: (signal: AbortSignal) => Promise<void>;
}): ReadableStream<UIMessageChunk> {
  const chunks: UIMessageChunk[] = [];
  let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
  let cancelled = false;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let messages = options.messages;
      let attempt = 0;
      let started = false;
      const summarizedSources = new Set<string>();
      const emit = (chunk: UIMessageChunk) => { chunks.push(chunk); if (!cancelled) controller.enqueue(chunk); };
      try {
        while (!cancelled) {
          signal.throwIfAborted();
          messages = await options.prepareMessages?.(messages) ?? messages;
          signal.throwIfAborted();
          options.logger.setRunPhase(options.runId, attempt);
          const phase = new AbortController();
          const phaseSignal = AbortSignal.any([signal, phase.signal]);
          let originalError: unknown;
          const openParts = new Map<string, "text" | "reasoning">();
          let finish: UIMessageChunk | undefined;
          try {
            reader = (await options.open(messages, (error) => { originalError = error; }, phaseSignal)).getReader();
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              let chunk = next.value;
              if (chunk.type === "error") throw originalError ?? new Error(chunk.errorText);
              if (chunk.type === "start") { if (started) continue; started = true; }
              if (chunk.type === "finish") { finish = chunk; continue; }
              if (attempt > 0 && "toolCallId" in chunk) chunk = { ...chunk, toolCallId: `${attempt}:${chunk.toolCallId}` } as UIMessageChunk;
              if (["text-start", "text-delta", "text-end", "reasoning-start", "reasoning-delta", "reasoning-end"].includes(chunk.type)) {
                chunk = { ...chunk, id: `${attempt}:${(chunk as { id: string }).id}` } as UIMessageChunk;
                const id = (chunk as { id: string }).id;
                if (chunk.type.endsWith("-start")) openParts.set(id, chunk.type.startsWith("text") ? "text" : "reasoning");
                if (chunk.type.endsWith("-end")) openParts.delete(id);
              }
              emit(chunk);
            }
            if (originalError) throw originalError;
            if (!finish) throw new TypeError("Model stream ended before its finish event");
            emit(finish);
            controller.close();
            return;
          } catch (error) {
            const failure = originalError ?? error;
            const overflow = !signal.aborted && Boolean(options.onContextOverflow) && isContextOverflowError(failure);
            const reason = overflow ? "context-overflow" : "stream-disconnected";
            phase.abort(reason);
            await reader?.cancel(reason).catch(() => undefined);
            if (!overflow && !isRecoverableModelError(failure, signal)) throw error;
            for (const [id, type] of openParts) emit({ type: `${type}-end`, id });
            await options.logger.closePendingTools(options.runId, options.conversationId, reason);
            let partial = await snapshot(chunks);
            if (partial) {
              const events = await options.logger.conversation(options.conversationId);
              const terminals = new Map(events.filter((event) => event.runId === options.runId && event.toolCallId && ["tool.finished", "tool.failed"].includes(event.type)).map((event) => [event.toolCallId!, event]));
              for (const part of partial.parts) {
                if (!("toolCallId" in part) || !["input-streaming", "input-available"].includes(String((part as any).state))) continue;
                if ((part as any).state === "input-streaming") {
                  const toolName = "toolName" in part ? String(part.toolName) : part.type.slice("tool-".length);
                  emit({ type: "tool-input-error", toolCallId: String(part.toolCallId), toolName, input: {},
                    dynamic: part.type === "dynamic-tool", errorText: "请求断线时工具参数尚未接收完整；此操作未执行。" });
                  continue;
                }
                const terminal = terminals.get(String(part.toolCallId));
                if (terminal?.output !== undefined) emit({ type: "tool-output-available", toolCallId: String(part.toolCallId), output: fromLogValue(terminal.output) });
                else emit({ type: "tool-output-error", toolCallId: String(part.toolCallId), errorText: "请求断线；此操作完成状态不明确，请先检查页面。" });
              }
              partial = await snapshot(chunks);
              if (partial?.parts.length) {
                await options.logger.appendMessage(options.conversationId, partial as ConversationMessage, { runId: options.runId, parentId: options.parentId });
                messages = [...options.messages, partial];
              }
            }
            if (overflow) {
              // A second rejection of the same durable source means the summary did
              // not fit the provider. Preserve it and report the original failure.
              const source = JSON.stringify(messages.filter((message) => message.role !== "assistant" || message.parts.length));
              if (summarizedSources.has(source)) throw failure;
              summarizedSources.add(source);
              await options.onContextOverflow!(signal);
              signal.throwIfAborted();
            }
            const delayMs = overflow ? 0 : retryBackoffDelay(attempt + 1);
            await options.logger.append({ type: "model.stream.retrying", conversationId: options.conversationId, runId: options.runId, error: failure, retry: { attempt: ++attempt, delayMs, reason } });
            await waitForModelRetry(delayMs, signal, options.sleep);
          } finally { reader?.releaseLock(); reader = undefined; }
        }
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel(reason) { cancelled = true; cancellation.abort(reason); await reader?.cancel(reason); },
  });
}
