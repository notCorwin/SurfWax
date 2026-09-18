import { useAuiState, useRemoteThreadListRuntime, type AssistantRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo } from "react";
import { abortAllConversationWork } from "../agent/coordinator";
import { createAgent } from "../agent/runner";
import { ContextCompactor } from "../agent/compaction";
import { createModel } from "../agent/model";
import { createChatTransport } from "../agent/transport";
import { ChromeExecutor } from "../chrome/executor";
import { createConversationAdapter } from "../conversations";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";

type CloseableRuntime = { thread: Pick<AssistantRuntime["thread"], "cancelRun"> };

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

function useConversationRuntime(config: ModelConfig, logger: EventLogger): AssistantRuntime {
  const conversationId = useAuiState((state) => state.threadListItem.remoteId ?? state.threadListItem.id);
  const executor = useMemo(() => new ChromeExecutor({ logger }), [logger]);
  const transport = useMemo(
    () => createChatTransport((signal, branchIds) => {
      const languageModel = createModel(config, logger, conversationId);
      return createAgent({ model: config, languageModel, executor, logger, conversationId,
        compactor: new ContextCompactor({ model: config, logger, conversationId, branchIds, signal }) });
    }, logger, conversationId),
    [config, conversationId, executor, logger],
  );
  const runtime = useChatRuntime({
    id: conversationId,
    transport,
    unstable_onBranchChange: ({ headId }) => {
      void logger.append({ type: "conversation.branch.selected", conversationId, content: { headId } });
    },
  });

  useEffect(() => {
    const dispose = () => executor.dispose();
    globalThis.addEventListener("pagehide", dispose);
    return () => {
      globalThis.removeEventListener("pagehide", dispose);
      executor.dispose();
    };
  }, [executor]);

  return runtime;
}

export function useSidePanelRuntime(
  config: ModelConfig,
  logger: EventLogger,
  initialThreadId?: string,
): AssistantRuntime {
  const adapter = useMemo(() => createConversationAdapter(logger, config), [config, logger]);
  const runtime = useRemoteThreadListRuntime({
    adapter,
    initialThreadId,
    runtimeHook: () => useConversationRuntime(config, logger),
    onThreadIdChange: (conversationId) => {
      if (conversationId) logger.record({ type: "conversation.selected", conversationId, content: null });
    },
  });

  useEffect(() => {
    const close = createSidePanelCloser(runtime, logger);
    const clear = (message: unknown, _sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "side-agent:clear-log") return false;
      close();
      logger.stop();
      void logger.flush()
        .then(() => logger.clear())
        .then(() => {
          respond({ ok: true });
          globalThis.location.reload();
        })
        .catch((error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    };
    globalThis.addEventListener("pagehide", close);
    chrome.runtime.onMessage.addListener(clear);
    return () => {
      globalThis.removeEventListener("pagehide", close);
      chrome.runtime.onMessage.removeListener(clear);
      close();
    };
  }, [logger, runtime]);

  return runtime;
}
