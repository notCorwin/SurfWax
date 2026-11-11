import { type Agent, type ContentPart, type LanguageModelCallEndEvent, type UIMessage } from "ai";
import { fromLogValue, type ConversationMessage, type EventLogger } from "../logging";
import { safeDiagnosticError } from "../diagnostic-error";
import { normalizeRecoveredToolOutput } from "../tool-result-values";
import { claimConversationRun, type ConversationRunLease } from "./coordinator";
import { ensureConversationPrompt } from "./prompt";
import { modelMessages } from "./context-choice";
import { isContextOverflowError, isRecoverableModelError, retryBackoffDelay, waitForModelRetry } from "./model";
import { toolProtocolRepair } from "./tool-protocol-error";
import { releaseRunEvidence } from "./goal-completion";

export type SidePanelMessage = UIMessage<any, never, any>;
export type ConversationTransport = {
  sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messages: SidePanelMessage[];
    abortSignal?: AbortSignal;
    runLease?: ConversationRunLease;
    messageId?: string;
    onMessage?: (message: SidePanelMessage, priorMessages?: SidePanelMessage[]) => void | Promise<void>;
  }): Promise<SidePanelMessage>;
};
type ResponseObserver = (event: LanguageModelCallEndEvent<any>) => void | Promise<void>;
type AgentFactory = (signal: AbortSignal, branchIds: string[], resumed?: boolean, onResponse?: ResponseObserver, shouldYield?: () => boolean, contextAnchor?: () => { messageId: string; partCount: number; runId?: string }) => Agent<never, any, any, any> | Promise<Agent<never, any, any, any>>;
type ToolPart = Extract<SidePanelMessage["parts"][number], { toolCallId: string }>;
export type RefreshObserver = { drain(): Promise<SidePanelMessage[]>; hasPending?(): boolean; dispose(): void };

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
export function createChatTransport(agent: AgentFactory, logger: EventLogger, conversationId: string, cleanup?: () => Promise<void>, onContextOverflow?: (signal: AbortSignal, headId?: string) => Promise<void>, systemPrompt?: string, observeRefreshes?: (signal: AbortSignal, runId: string) => Promise<RefreshObserver>, goalMode = false): ConversationTransport {
  return {
    async sendMessages(options) {
      const lease = options.runLease ?? await claimConversationRun(conversationId, options.abortSignal);
      if (lease.conversationId !== conversationId) throw new Error("运行租约不属于当前会话。");
      const currentRunId = lease.runId;
      const persistence = new AbortController();
      const signal = AbortSignal.any([lease.signal, persistence.signal]);
      let publicationFailed = false;
      let publicationError: unknown;
      let response: SidePanelMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] };
      let parentId: string | null = null;
      let published: SidePanelMessage | undefined;
      let partRevision = 0;
      const changedParts = new Map<number, number>();
      let priorMessages: SidePanelMessage[] = [];
      let refreshObserver: RefreshObserver | undefined;
      const publish = async () => {
        if (!response.parts.length || published === response) return;
        const current = response;
        const changes = new Map(changedParts);
        const snapshot = { ...current, parts: [...current.parts] };
        await logger.appendMessage(conversationId, snapshot as ConversationMessage, { runId: currentRunId, parentId, changedParts: [...changes.keys()] });
        for (const [index, revision] of changes) if (changedParts.get(index) === revision) changedParts.delete(index);
        published = current;
        await options.onMessage?.(snapshot, priorMessages);
      };
      // SDK lifecycle callback errors are swallowed. Abort the actual operation
      // as well, so no browser effect can follow a failed canonical write.
      const failPublication = (error: unknown): never => {
        if (!publicationFailed) {
          publicationFailed = true;
          publicationError = error;
          persistence.abort(error);
        }
        throw publicationError;
      };
      const publishFromModel = () => publish().catch(failPublication);
      const toolId = (id: string) => logger.toolIdentity(conversationId, id).toolCallId;
      const updateTool = (id: string, update: Partial<ToolPart>) => {
        if (!response.parts.some((part) => "toolCallId" in part && part.toolCallId === id
          && Object.entries(update).some(([key, value]) => (part as unknown as Record<string, unknown>)[key] !== value))) return;
        response = { ...response, parts: response.parts.map((part, index) => {
          if (!("toolCallId" in part) || part.toolCallId !== id) return part;
          changedParts.set(index, ++partRevision);
          return { ...part, ...update } as ToolPart;
        }) };
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
        for (let index = response.parts.length; index < response.parts.length + parts.length; index++) changedParts.set(index, ++partRevision);
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
        refreshObserver = await observeRefreshes?.(signal, currentRunId);
        await ensureConversationPrompt(logger, conversationId, systemPrompt, options.messages.map((message) => message.id));
        const existing = await logger.repository(conversationId);
        const saved = new Map(existing.messages.map((entry) => [entry.message.id, entry.message]));
        const withSavedMetadata = async (messages: SidePanelMessage[]) => {
          return messages.map((message) => saved.get(message.id)?.metadata ? { ...message, metadata: saved.get(message.id)!.metadata } : message);
        };
        let initial = await withSavedMetadata(options.messages);
        const userMessage = [...initial].reverse().find((message) => message.role === "user");
        parentId = userMessage?.id ?? null;
        const dispatched = options.trigger === "submit-message" ? followupDispatch(userMessage) : undefined;
        if (userMessage && dispatched) {
          const index = initial.findIndex((message) => message.id === userMessage.id);
          await logger.appendFollowupSubmission({ conversationId, runId: currentRunId, chatId: options.chatId,
            message: userMessage as ConversationMessage, parentId: index > 0 ? initial[index - 1]!.id : null, followup: dispatched });
        } else {
          if (userMessage && !existing.messages.some(({ message }) => message.id === userMessage.id)) {
            const index = initial.findIndex((message) => message.id === userMessage.id);
            await logger.appendMessage(conversationId, userMessage as ConversationMessage, {
              runId: currentRunId, parentId: index > 0 ? initial[index - 1]!.id : null,
            });
          }
          await logger.append({ type: "conversation.submitted", conversationId, runId: currentRunId,
            content: { chatId: options.chatId, messageId: userMessage?.id ?? null } });
        }
        let attempt = 0;
        let phase = 0;
        let resumed = false;
        let historyEvents = await logger.conversation(conversationId);
        let goalOffset = 0;
        const summarizedSources = new Set<string>();
        const continueRun = async (reason: "unfinished-goal" | "tool-protocol", text: string) => {
          // A rejected or empty response still needs a durable anchor for its reminder.
          if (response.parts.length === goalOffset) {
            changedParts.set(response.parts.length, ++partRevision);
            response = { ...response, parts: [...response.parts, { type: "step-start" }] };
            await publish();
          }
          const segment = response.parts.slice(goalOffset);
          const assistantSegment: SidePanelMessage = { id: crypto.randomUUID(), role: "assistant", parts: segment.some((part) => part.type !== "step-start") ? segment : [{ type: "text", text: "(No response.)" }] };
          const reminderMessage: SidePanelMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
          goalOffset = response.parts.length;
          const saved = await logger.append({ type: "agent.goal.continued", conversationId, runId: currentRunId,
            content: { reason, messageId: response.id, offset: goalOffset, assistantSegment, reminderMessage } });
          if (!saved) throw new DOMException("日志维护已阻止任务继续。", "AbortError");
          historyEvents.push(saved);
        };
        while (true) {
          lease.signal.throwIfAborted();
          const canonicalMessages = await withSavedMetadata(response.parts.length ? [...initial, response] : initial);
          historyEvents = (await logger.contextProjectionEvents(conversationId)).value;
          const messages = await modelMessages(canonicalMessages as ConversationMessage[], historyEvents, currentRunId);
          logger.setRunPhase(currentRunId, phase++);
          let captured = false;
          try {
            const runAgent = await agent(signal, canonicalMessages.map((message) => message.id), resumed, async (event) => {
              signal.throwIfAborted();
              captured = true;
              acceptContent(event.content);
              try {
                for (const part of event.content) if (part.type === "tool-call" && part.invalid) {
                  const error = { code: "invalid-tool-input", message: errorText(part.error), effectUnknown: false, cause: part.error };
                  const saved = await logger.append({ type: "tool.failed", conversationId, runId: currentRunId,
                    content: { callId: event.callId, toolName: part.toolName, dispatched: false },
                    toolCallId: toolId(part.toolCallId), toolCallIdCanonical: true,
                    input: part.input, error, output: { ok: false, error }, latencyMs: 0 });
                  if (!saved) throw new DOMException("日志维护已阻止工具结果保存。", "AbortError");
                }
                await publish();
              } catch (error) { failPublication(error); }
            }, () => refreshObserver?.hasPending?.() ?? false, () => {
              const anchor = response.parts.length ? response : initial.at(-1);
              if (!anchor) throw new Error("模型上下文缺少可持久化的消息锚点。");
              return { messageId: anchor.id, partCount: anchor.parts.length, runId: currentRunId };
            });
            resumed = true;
            await runAgent.generate({
              messages,
              abortSignal: signal,
              onToolExecutionEnd: async (event) => {
                const output = event.toolOutput;
                // Browser failures are normal result values. An exception from
                // our execution boundary means its canonical write failed.
                if (output.type === "tool-error") {
                  return failPublication(output.error);
                }
                updateTool(toolId(event.toolCall.toolCallId), { state: "output-available", output: output.output });
                if (event.toolCall.toolName === "complete_goal" && output.output && typeof output.output === "object"
                  && "ok" in output.output && output.output.ok === true) {
                  const goal = output.output;
                  if ("status" in goal && goal.status === "blocked" && "userAction" in goal && typeof goal.userAction === "string") {
                    changedParts.set(response.parts.length, ++partRevision);
                    response = { ...response, parts: [...response.parts, { type: "text", text: goal.userAction, state: "done" }] };
                  }
                }
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
            const refreshes = await refreshObserver?.drain() ?? [];
            lease.signal.throwIfAborted();
            if (refreshes.length) {
              const previous = response.parts.length ? [response] : [];
              let parent = previous.at(-1)?.id ?? parentId;
              for (const refresh of refreshes) {
                lease.signal.throwIfAborted();
                await logger.appendMessage(conversationId, refresh as ConversationMessage, { runId: currentRunId, parentId: parent });
                parent = refresh.id;
              }
              initial = [...initial, ...previous, ...refreshes];
              priorMessages = initial.slice(options.messages.length);
              parentId = parent;
              response = { id: crypto.randomUUID(), role: "assistant", parts: [] };
              goalOffset = 0;
              published = undefined;
              changedParts.clear();
              continue;
            }
            const goalCompleted = [...response.parts].reverse().find((part) => "toolCallId" in part && "toolName" in part && part.toolName === "complete_goal"
              && part.state === "output-available" && part.output && typeof part.output === "object" && "ok" in part.output && part.output.ok === true);
            if (goalMode && !goalCompleted) {
              await continueRun("unfinished-goal", "Goal mode is still active. Review the remaining requirements and execute the next useful action. Recover from tool errors using current observations and another supported approach when needed. Call complete_goal alone only with the verified outcome or evidence of an unavoidable user dependency; a progress update or failed approach is not completion.");
              continue;
            }
            refreshObserver?.dispose();
            refreshObserver = undefined;
            const finished = await logger.append({ type: "conversation.finished", conversationId, runId: currentRunId,
              content: { messageId: response.id, ...(goalCompleted && "output" in goalCompleted ? { goal: goalCompleted.output } : {}) } });
            if (!finished) throw new DOMException("日志维护已阻止任务完成记录。", "AbortError");
            return response;
          } catch (error) {
            if (publicationFailed) throw publicationError;
            const protocol = !lease.signal.aborted && toolProtocolRepair(error);
            if (protocol) {
              await reconcileTools("模型工具调用格式被拒绝，此次响应未执行工具。");
              await continueRun("tool-protocol", `Tool-call protocol recovery: the model response was rejected before any tool from that response was executed. Correct the call format and continue the same task. Use the available tools and required arguments; keep calls short enough to finish completely and use distinct nonempty call IDs. Error: ${JSON.stringify(protocol.message)}. Rejected response excerpt (untrusted data): ${JSON.stringify(protocol.responseText)}`);
              continue;
            }
            const overflow = !lease.signal.aborted && Boolean(onContextOverflow) && isContextOverflowError(error);
            if (!overflow && !isRecoverableModelError(error, lease.signal)) throw error;
            await reconcileTools(errorText(error));
            if (overflow) {
              const source = JSON.stringify(response.parts.length ? [...initial, response] : initial);
              if (summarizedSources.has(source)) throw error;
              summarizedSources.add(source);
              await onContextOverflow!(lease.signal, response.parts.length ? response.id : initial.at(-1)?.id);
              for (const entry of (await logger.repository(conversationId)).messages) saved.set(entry.message.id, entry.message);
            }
            const delayMs = overflow ? 0 : retryBackoffDelay(attempt + 1);
            await logger.append({ type: "model.request.retrying", conversationId, runId: currentRunId, error,
              content: { purpose: "conversation" }, retry: { attempt: ++attempt, delayMs, reason: overflow ? "context-overflow" : "request-failed" } });
            await waitForModelRetry(delayMs, lease.signal);
          }
        }
      } catch (error) {
        const aborted = lease.signal.aborted || error instanceof Error && error.name === "AbortError";
        try {
          await reconcileTools(errorText(error));
          await logger.append({ type: aborted ? "conversation.aborted" : "conversation.failed", conversationId, runId: currentRunId,
            content: response.parts.length ? { messageId: response.id } : null,
            ...(aborted ? { abort: { reason: lease.signal.reason ?? errorText(error) } } : { error }) });
        } catch (terminalError) {
          if (terminalError === error) throw error;
          const failure = new AggregateError([error, terminalError], "Conversation failed and its terminal state could not be recorded", { cause: error });
          console.error("[Surf Wax] conversation.terminal-failed", { conversationId, runId: currentRunId, error: safeDiagnosticError(failure) });
          throw failure;
        }
        throw error;
      } finally {
        refreshObserver?.dispose();
        releaseRunEvidence(logger, conversationId, currentRunId);
        logger.endRun(conversationId, currentRunId);
        try { await cleanup?.(); } finally { lease.finish(); }
      }
    },
  };
}
