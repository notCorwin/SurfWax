import type { AssistantRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import type { UIMessage } from "ai";
import { useEffect, useMemo } from "react";
import { createAgent } from "../agent/runner";
import { createChatTransport } from "../agent/transport";
import { ChromeExecutor } from "../chrome/executor";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";

type SidePanelMessage = UIMessage<any, never, any>;
type CloseableRuntime = { thread: Pick<AssistantRuntime["thread"], "cancelRun"> };
type DisposableExecutor = Pick<ChromeExecutor, "dispose">;

export function createSidePanelCloser(
  runtime: CloseableRuntime,
  executor: DisposableExecutor,
  logger?: EventLogger,
): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    runtime.thread.cancelRun();
    executor.dispose();
    logger?.record({ type: "sidepanel.closed", content: null });
    void logger?.flush();
  };
}

export function useSidePanelRuntime(
  config: ModelConfig,
  logger: EventLogger,
  initialMessages: SidePanelMessage[] = [],
): AssistantRuntime {
  const executor = useMemo(() => new ChromeExecutor({ logger }), [logger]);
  const agent = useMemo(() => createAgent({ model: config, executor, logger }), [config, executor, logger]);
  const transport = useMemo(() => createChatTransport(agent, logger), [agent, logger]);
  const runtime = useChatRuntime<SidePanelMessage>({
    id: "side-agent-runtime",
    messages: initialMessages,
    transport,
  });

  useEffect(() => {
    const close = createSidePanelCloser(runtime, executor, logger);
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
  }, [executor, logger, runtime]);

  return runtime;
}
