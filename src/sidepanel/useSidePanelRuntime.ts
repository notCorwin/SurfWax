import { useEffect, useMemo, useRef } from "react";
import { abortAllConversationWork } from "../agent/coordinator";
import { ensureConversationPrompt, PROMPT_TOOLS } from "../agent/prompt";
import { createAgent } from "../agent/runner";
import { ContextCompactor } from "../agent/compaction";
import { createModel } from "../agent/model";
import { ensureAutomaticContextSummary } from "../agent/context-choice";
import { reasoningSettingsFor } from "../agent/reasoning";
import { createChatTransport } from "../agent/transport";
import { ChromeExecutor } from "../chrome/executor";
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
    logger?.record({ type: "sidepanel.closed", content: null });
    void logger?.flush();
  };
}

export function useSidePanelRuntime(config: ModelConfig, systemPrompt: string | undefined, logger: EventLogger, initialThreadId?: string) {
  const executor = useMemo(() => new ChromeExecutor({ logger }), [logger]);
  const latest = useRef({ config, systemPrompt });
  latest.current = { config, systemPrompt };
  const runtime = useMemo(() => new ConversationStore(logger, (conversationId) => {
    const { config, systemPrompt } = latest.current;
    return createChatTransport(async (signal, branchIds, resumed) => {
      signal.throwIfAborted();
      if (!resumed) await executor.beginRun();
      const reasoning = reasoningSettingsFor(config);
      await reasoning.ready;
      const languageModel = await createModel(config, logger, conversationId, { signal });
      signal.throwIfAborted();
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt, branchIds);
      return createAgent({ model: config, languageModel, reasoning: reasoning.snapshot().selected ?? undefined, executor, logger, conversationId,
        instructions: systemPrompt, prompt, signal,
        compactor: new ContextCompactor({ model: config, logger, conversationId, branchIds, signal, prompt }) });
    }, logger, conversationId, () => executor.endRun(), async (signal) => {
      const prompt = await ensureConversationPrompt(logger, conversationId, systemPrompt);
      await ensureAutomaticContextSummary(logger, conversationId, config, signal, { forced: true, instructions: prompt.instructions, tools: PROMPT_TOOLS });
    }, systemPrompt);
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
