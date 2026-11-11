import { useEffect, useMemo, useRef } from "react";
import { abortAllConversationWork } from "../agent/coordinator";
import { ensureConversationPrompt, PROMPT_TOOLS } from "../agent/prompt";
import { createAgent, GOAL_INSTRUCTIONS, GOAL_TOOLS } from "../agent/runner";
import { ContextCompactor } from "../agent/compaction";
import { resolveModelLimit } from "../agent/model-limits";
import { modelDiagnosticContext } from "../agent/diagnostics";
import { createModel } from "../agent/model";
import { ensureAutomaticContextSummary } from "../agent/context-choice";
import { reasoningSettingsFor } from "../agent/reasoning";
import { createChatTransport } from "../agent/transport";
import { ChromeExecutor } from "../chrome/executor";
import { observePageRefreshes } from "../chrome/refresh-observer";
import { ConversationStore } from "./conversation-store";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";

type CloseableRuntime = { thread: { cancelRun: () => unknown } };

export function createSidePanelCloser(runtime: CloseableRuntime, logger?: EventLogger): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    abortAllConversationWork();
    runtime.thread.cancelRun();
    logger?.telemetry({ type: "sidepanel.closed", content: null });
    void logger?.flush();
  };
}

export function useSidePanelRuntime(config: ModelConfig, systemPrompt: string | undefined, logger: EventLogger, initialThreadId?: string, goalMode = true) {
  const executor = useMemo(() => new ChromeExecutor({ logger }), [logger]);
  // Configuration changes are deliberately hot-swapped for the next run.
  // An active run keeps the snapshot it started with; the conversation and
  // browser executor are not remounted underneath it.
  const latest = useRef({ config, systemPrompt, goalMode });
  latest.current = { config, systemPrompt, goalMode };
  const runtime = useMemo(() => new ConversationStore(logger, (conversationId) => {
    const { config, systemPrompt, goalMode } = latest.current;
    return createChatTransport(async (signal, branchIds, _resumed, onResponse, shouldYield, contextAnchor) => {
      signal.throwIfAborted();
      const reasoning = reasoningSettingsFor(config);
      await reasoning.ready;
      const languageModel = await createModel(config, logger, conversationId, { signal });
      signal.throwIfAborted();
      const modelLimit = await resolveModelLimit(config, { signal, diagnosticContext: modelDiagnosticContext(logger, conversationId) });
      signal.throwIfAborted();
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt, branchIds);
      return createAgent({ model: config, modelLimit, languageModel, reasoning: reasoning.snapshot().selected ?? undefined, executor, logger, conversationId,
        instructions: systemPrompt, prompt, signal, onResponse, shouldYield, contextAnchor, goalMode,
        compactor: new ContextCompactor({ model: config, logger, conversationId, branchIds, signal, prompt }) });
    }, logger, conversationId, () => executor.endRun(), async (signal) => {
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt);
      await ensureAutomaticContextSummary(logger, conversationId, config, signal, { forced: true, instructions: prompt.instructions + (goalMode ? GOAL_INSTRUCTIONS : ""), tools: goalMode ? GOAL_TOOLS : PROMPT_TOOLS });
    }, systemPrompt, async (signal, runId) => {
      const observer = observePageRefreshes(executor, conversationId, signal, runId, logger);
      try {
        await executor.beginRun();
        signal.throwIfAborted();
        return observer;
      } catch (error) { observer.dispose(); throw error; }
    }, goalMode);
  }, initialThreadId), [executor, logger, initialThreadId]);

  useEffect(() => runtime.connect(), [runtime]);

  useEffect(() => {
    const close = createSidePanelCloser(runtime, logger);
    globalThis.addEventListener("pagehide", close);
    return () => {
      globalThis.removeEventListener("pagehide", close);
      close();
    };
  }, [logger, runtime]);

  useEffect(() => () => executor.dispose(), [executor]);

  return runtime;
}
