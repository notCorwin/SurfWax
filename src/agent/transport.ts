import { convertToModelMessages, type Agent, type ContentPart, type LanguageModelCallEndEvent, type UIMessage } from "ai";
import { fromLogValue, type ConversationMessage, type EventLogger } from "../logging";
import { normalizeRecoveredToolOutput } from "../tool-result-values";
import { claimConversationRun } from "./coordinator";
import { ensureConversationPrompt } from "./prompt";
import { materializeToolCatalog } from "./tool-catalog";
import { isContextOverflowError, isRecoverableModelError, retryBackoffDelay, waitForModelRetry } from "./model";

export type SidePanelMessage = UIMessage<any, never, any>;
export type ConversationTransport = {
  sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messages: SidePanelMessage[];
    abortSignal?: AbortSignal;
    messageId?: string;
    onMessage?: (message: SidePanelMessage) => void | Promise<void>;
  }): Promise<SidePanelMessage>;
};
type ResponseObserver = (event: LanguageModelCallEndEvent<any>) => void | Promise<void>;
type AgentFactory = (signal: AbortSignal, branchIds: string[], resumed?: boolean, onResponse?: ResponseObserver) => Agent<never, any, any, any> | Promise<Agent<never, any, any, any>>;
type ToolPart = Extract<SidePanelMessage["parts"][number], { toolCallId: string }>;

export function followupDispatch(message: SidePanelMessage | undefined): { id: string; mode: "followup" | "immediate" } | undefined {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const custom = (metadata as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return undefined;
  const id = (custom as { followupId?: unknown }).followupId;
  const mode = (custom as { followupMode?: unknown }).followupMode;
  return typeof id === "string" && (mode === "followup" || mode === "immediate") ? { id, mode } : undefined;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Each publication contains complete model content or a completed tool result. */
export function createChatTransport(agent: AgentFactory, logger: EventLogger, conversationId: string, cleanup?: () => Promise<void>, onContextOverflow?: (signal: AbortSignal) => Promise<void>, systemPrompt?: string): ConversationTransport {
  return {
    async sendMessages(options) {
      const currentRunId = crypto.randomUUID();
      const lease = await claimConversationRun(conversationId, options.abortSignal, currentRunId);
      const persistence = new AbortController();
      const signal = AbortSignal.any([lease.signal, persistence.signal]);
      let publicationFailed = false;
      let publicationError: unknown;
      let response: SidePanelMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] };
      let parentId: string | null = null;
      let published: SidePanelMessage | undefined;
      const publish = async () => {
        if (!response.parts.length || published === response) return;
        const snapshot = { ...response, parts: [...response.parts] };
        await logger.appendMessage(conversationId, snapshot as ConversationMessage, { runId: currentRunId, parentId });
        published = response;
        await options.onMessage?.(snapshot);
      };
      // SDK lifecycle callback errors are swallowed. Abort the actual operation
      // as well, so no browser effect can follow a failed canonical write.
      const failPublication = (error: unknown): never => {
        publicationFailed = true;
        publicationError = error;
        persistence.abort(error);
        throw error;
      };
      const publishFromModel = () => publish().catch(failPublication);
      const toolId = (id: string) => logger.toolIdentity(conversationId, id).toolCallId;
      const updateTool = (id: string, update: Partial<ToolPart>) => {
        if (!response.parts.some((part) => "toolCallId" in part && part.toolCallId === id
          && Object.entries(update).some(([key, value]) => (part as unknown as Record<string, unknown>)[key] !== value))) return;
        response = { ...response, parts: response.parts.map((part) => "toolCallId" in part && part.toolCallId === id ? { ...part, ...update } as ToolPart : part) };
      };
      const acceptContent = (content: readonly ContentPart<any>[]) => {
        const parts: SidePanelMessage["parts"] = [{ type: "step-start" }];
        for (const part of content) {
          const providerMetadata = "providerMetadata" in part ? part.providerMetadata : undefined;
          if (part.type === "text" || part.type === "reasoning") parts.push({ ...part, state: "done" });
          else if (part.type === "file" || part.type === "reasoning-file") parts.push({ type: part.type,
            mediaType: part.file.mediaType, url: `data:${part.file.mediaType};base64,${part.file.base64}`, providerMetadata });
          else if (part.type === "source") {
            if (part.sourceType === "url") parts.push({ type: "source-url", sourceId: part.id, url: part.url, title: part.title, providerMetadata });
            else parts.push({ type: "source-document", sourceId: part.id, mediaType: part.mediaType, title: part.title, filename: part.filename, providerMetadata });
          } else if (part.type === "custom") parts.push({ ...part });
          else if (part.type === "tool-call") parts.push({ type: "dynamic-tool", toolName: part.toolName,
            toolCallId: toolId(part.toolCallId), input: part.input, callProviderMetadata: providerMetadata,
            ...(part.title === undefined ? {} : { title: part.title }),
            ...(part.toolMetadata === undefined ? {} : { toolMetadata: part.toolMetadata }),
            ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
            ...(part.invalid ? { state: "output-error", errorText: errorText(part.error) } : { state: "input-available" }) });
        }
        response = { ...response, parts: [...response.parts, ...parts] };
      };
      const acceptResults = (content: readonly ContentPart<any>[]) => {
        for (const part of content) {
          if (part.type === "tool-result") updateTool(toolId(part.toolCallId), { state: "output-available", output: part.output,
            resultProviderMetadata: part.providerMetadata });
          if (part.type === "tool-error") updateTool(toolId(part.toolCallId), { state: "output-error", errorText: errorText(part.error),
            resultProviderMetadata: part.providerMetadata });
        }
      };
      const reconcileTools = async (reason: unknown) => {
        await publish();
        await logger.closePendingTools(currentRunId, conversationId, reason);
        const events = await logger.conversation(conversationId);
        const terminals = new Map(events.filter((event) => event.runId === currentRunId && event.toolCallId && ["tool.finished", "tool.failed"].includes(event.type)).map((event) => [event.toolCallId!, event]));
        for (const part of response.parts) {
          if (!("toolCallId" in part) || part.state !== "input-available") continue;
          const terminal = terminals.get(part.toolCallId);
          if (terminal?.output !== undefined) updateTool(part.toolCallId, { state: "output-available", output: normalizeRecoveredToolOutput(fromLogValue(terminal.output, terminal.valueEncoding)) });
          else updateTool(part.toolCallId, { state: "output-error", errorText: terminal ? errorText(fromLogValue(terminal.error, terminal.valueEncoding)) : "工具调用已中断，此操作未执行。" });
        }
        await publish();
      };
      try {
        logger.beginRun(conversationId, currentRunId);
        lease.signal.throwIfAborted();
        await ensureConversationPrompt(logger, conversationId, systemPrompt, options.messages.map((message) => message.id));
        const existing = await logger.repository(conversationId);
        const withSavedMetadata = async (messages: SidePanelMessage[]) => {
          const saved = new Map((await logger.repository(conversationId)).messages.map((entry) => [entry.message.id, entry.message]));
          return messages.map((message) => saved.get(message.id)?.metadata ? { ...message, metadata: saved.get(message.id)!.metadata } : message);
        };
        const initial = await withSavedMetadata(options.messages);
        const userMessage = [...initial].reverse().find((message) => message.role === "user");
        parentId = userMessage?.id ?? null;
        if (userMessage && !existing.messages.some(({ message }) => message.id === userMessage.id)) {
          const index = initial.findIndex((message) => message.id === userMessage.id);
          await logger.appendMessage(conversationId, userMessage as ConversationMessage, {
            runId: currentRunId, parentId: index > 0 ? initial[index - 1]!.id : null,
          });
        }
        const dispatched = followupDispatch(userMessage);
        if (dispatched) await logger.append({ type: "conversation.followup.dispatched", conversationId, runId: currentRunId, content: dispatched });
        await logger.append({ type: "conversation.submitted", conversationId, runId: currentRunId,
          content: { chatId: options.chatId, messageId: userMessage?.id ?? null } });
        let attempt = 0;
        let resumed = false;
        const summarizedSources = new Set<string>();
        while (true) {
          lease.signal.throwIfAborted();
          const messages = await withSavedMetadata(response.parts.length ? [...initial, response] : initial);
          logger.setRunPhase(currentRunId, attempt);
          let captured = false;
          try {
            const runAgent = await agent(signal, messages.map((message) => message.id), resumed, async (event) => {
              signal.throwIfAborted();
              captured = true;
              acceptContent(event.content);
              try {
                for (const part of event.content) if (part.type === "tool-call" && part.invalid) {
                  const saved = await logger.append({ type: "tool.failed", conversationId, runId: currentRunId,
                    content: { callId: event.callId, toolName: part.toolName },
                    toolCallId: toolId(part.toolCallId), toolCallIdCanonical: true,
                    input: part.input, error: part.error, output: { ok: false, error: part.error }, latencyMs: 0 });
                  if (!saved) throw new DOMException("日志维护已阻止工具结果保存。", "AbortError");
                }
                await publish();
              } catch (error) { failPublication(error); }
            });
            resumed = true;
            await runAgent.generate({
              messages: await convertToModelMessages(messages.map(materializeToolCatalog), { tools: runAgent.tools }),
              abortSignal: signal,
              onToolExecutionEnd: async (event) => {
                const output = event.toolOutput;
                // Browser failures are normal result values. An exception from
                // our execution boundary means its canonical write failed.
                if (output.type === "tool-error") {
                  return failPublication(output.error);
                }
                updateTool(toolId(event.toolCall.toolCallId), { state: "output-available", output: output.output });
                await publishFromModel();
              },
              onStepEnd: async (event) => {
                if (!captured) acceptContent(event.content);
                captured = false;
                acceptResults(event.content);
                await publishFromModel();
              },
            });
            if (publicationFailed) throw publicationError;
            lease.signal.throwIfAborted();
            await reconcileTools("任务已完成");
            const finished = await logger.append({ type: "conversation.finished", conversationId, runId: currentRunId, content: { messageId: response.id } });
            if (!finished) throw new DOMException("日志维护已阻止任务完成记录。", "AbortError");
            return response;
          } catch (error) {
            if (publicationFailed) throw publicationError;
            const overflow = !lease.signal.aborted && Boolean(onContextOverflow) && isContextOverflowError(error);
            if (!overflow && !isRecoverableModelError(error, lease.signal)) throw error;
            await reconcileTools(errorText(error));
            if (overflow) {
              const source = JSON.stringify(response.parts.length ? [...initial, response] : initial);
              if (summarizedSources.has(source)) throw error;
              summarizedSources.add(source);
              await onContextOverflow!(lease.signal);
            }
            const delayMs = overflow ? 0 : retryBackoffDelay(attempt + 1);
            await logger.append({ type: "model.request.retrying", conversationId, runId: currentRunId, error,
              content: { purpose: "conversation" }, retry: { attempt: ++attempt, delayMs, reason: overflow ? "context-overflow" : "request-failed" } });
            await waitForModelRetry(delayMs, lease.signal);
          }
        }
      } catch (error) {
        const aborted = lease.signal.aborted || error instanceof Error && error.name === "AbortError";
        await reconcileTools(errorText(error));
        await logger.append({ type: aborted ? "conversation.aborted" : "conversation.failed", conversationId, runId: currentRunId,
          content: response.parts.length ? { messageId: response.id } : null,
          ...(aborted ? { abort: { reason: lease.signal.reason ?? errorText(error) } } : { error }) });
        throw error;
      } finally {
        logger.endRun(conversationId, currentRunId);
        try { await cleanup?.(); } finally { lease.finish(); }
      }
    },
  };
}
