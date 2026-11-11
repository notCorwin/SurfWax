import { useEffect, useMemo, useRef } from "react";
import { abortAllConversationWork } from "../agent/coordinator";
import { ensureConversationPrompt, PROMPT_TOOLS } from "../agent/prompt";
import { GOAL_INSTRUCTIONS } from "../agent/goal-completion";
import { GOAL_TOOLS } from "../agent/context-prompt";
import { ContextCompactor } from "../agent/compaction";
import { resolveModelLimit } from "../agent/model-limits";
import { modelDiagnosticContext } from "../agent/diagnostics";
import { createModel } from "../agent/model";
import { ensureAutomaticContextSummary } from "../agent/context-choice";
import { reasoningSettingsFor } from "../agent/reasoning";
import { createChatTransport } from "../agent/transport";
import type { ChromeExecutor } from "../chrome/executor";
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
  const executor = useMemo(() => {
    let instance: ChromeExecutor | undefined;
    let pending: Promise<ChromeExecutor> | undefined;
    let disposed = false;
    return {
      async get() {
        if (disposed) throw new Error("侧栏已关闭，请重新打开后重试。");
        pending ??= import("../chrome/executor").catch(() => { throw new Error("无法加载浏览器操作模块，请重新打开侧栏后重试。"); }).then(({ ChromeExecutor }) => {
          if (disposed) throw new Error("侧栏已关闭，请重新打开后重试。");
          return instance = new ChromeExecutor({ logger });
        }).catch((error) => { pending = undefined; throw error; });
        return pending;
      },
      async endRun() { await instance?.endRun(); },
      dispose() { disposed = true; instance?.dispose(); },
    };
  }, [logger]);
  // Configuration changes are deliberately hot-swapped for the next run.
  // An active run keeps the snapshot it started with; the conversation and
  // browser executor are not remounted underneath it.
  const latest = useRef({ config, systemPrompt, goalMode });
  latest.current = { config, systemPrompt, goalMode };
  const runtime = useMemo(() => new ConversationStore(logger, (conversationId) => {
    const { config, systemPrompt, goalMode } = latest.current;
    return createChatTransport(async (signal, branchIds, _resumed, onResponse, shouldYield, contextAnchor) => {
      signal.throwIfAborted();
      const [{ createAgent }, browserExecutor] = await Promise.all([import("../agent/runner").catch(() => { throw new Error("无法加载任务运行模块，请重新打开侧栏后重试。"); }), executor.get()]);
      signal.throwIfAborted();
      const reasoning = reasoningSettingsFor(config);
      await reasoning.ready;
      const languageModel = await createModel(config, logger, conversationId, { signal });
      signal.throwIfAborted();
      const modelLimit = await resolveModelLimit(config, { signal, diagnosticContext: modelDiagnosticContext(logger, conversationId) });
      signal.throwIfAborted();
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt, branchIds);
      return createAgent({ model: config, modelLimit, languageModel, reasoning: reasoning.snapshot().selected ?? undefined, executor: browserExecutor, logger, conversationId,
        instructions: systemPrompt, prompt, signal, onResponse, shouldYield, contextAnchor, goalMode,
        compactor: new ContextCompactor({ model: config, logger, conversationId, branchIds, signal, prompt }) });
    }, logger, conversationId, () => executor.endRun(), async (signal, headId) => {
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt);
      await ensureAutomaticContextSummary(logger, conversationId, config, signal, { forced: true, headId, instructions: prompt.instructions + (goalMode ? GOAL_INSTRUCTIONS : ""), tools: goalMode ? GOAL_TOOLS : PROMPT_TOOLS });
    }, systemPrompt, async (signal, runId) => {
      const browserExecutor = await executor.get();
      signal.throwIfAborted();
      const observer = observePageRefreshes(browserExecutor, conversationId, signal, runId, logger);
      try {
        await browserExecutor.beginRun();
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
