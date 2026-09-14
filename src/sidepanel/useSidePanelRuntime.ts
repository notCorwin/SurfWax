import type { AssistantRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { useEffect, useMemo } from "react";
import { createAgent } from "../agent/runner";
import { ChromeBridge } from "../chrome/bridge";
import type { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { createChromeChatTransport } from "./chrome-tool-metadata";
import { UserScriptRegistry } from "../userscripts/registry";

type SidePanelUIMessage = UIMessage<any, any, any>;

type SidePanelRuntime = {
  thread: Pick<AssistantRuntime["thread"], "cancelRun">;
};
type SidePanelBridge = Pick<ChromeBridge, "dispose">;

export function createSidePanelCloser(
  runtime: SidePanelRuntime,
  bridge: SidePanelBridge,
  logger?: EventLogger,
): () => void {
  let closed = false;

  return () => {
    if (closed) return;
    closed = true;
    runtime.thread.cancelRun();
    bridge.dispose();
    logger?.record({ category: "system", type: "sidepanel.closed", content: null });
    void logger?.flush();
  };
}

export function useSidePanelRuntime(
  config: ModelConfig,
  suggestions: readonly { prompt: string }[],
  logger?: EventLogger,
  initialMessages: SidePanelUIMessage[] = [],
): AssistantRuntime {
  const userScripts = useMemo(() => new UserScriptRegistry({ logger }), [logger]);
  const bridge = useMemo(() => new ChromeBridge({ userScripts }), [userScripts]);
  const agent = useMemo(() => createAgent({ model: config, bridge, logger }), [config, bridge, logger]);
  const transport = useMemo(() => createChromeChatTransport(agent, logger), [agent, logger]);
  const runtime = useChatRuntime<SidePanelUIMessage>({ id: "side-agent-runtime", messages: initialMessages, transport: transport as any, suggestions });

  useEffect(() => {
    const close = createSidePanelCloser(runtime, bridge, logger);
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [bridge, logger, runtime]);

  return runtime;
}
