import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Thread } from "../components/assistant-ui/thread";
import { Button } from "../components/ui/button";
import { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { useSidePanelRuntime } from "./useSidePanelRuntime";
import { useSidePanelSession } from "./useSidePanelSession";
import "../styles.css";
import "./styles.css";

type SidePanelMessage = UIMessage<unknown, never, any>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const session = useSidePanelSession();
  const [fatal, setFatal] = useState("");
  const logger = useMemo(() => new EventLogger({ onError: (error) => setFatal(errorText(error)) }), []);

  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <header className="app-header">
        <h1>Side Agent Runtime</h1>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          data-testid="open-settings"
          aria-label="打开设置"
          title="打开设置"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          <SettingsIcon aria-hidden="true" />
        </Button>
      </header>

      <section className="chat-scroll" data-testid="chat-scroll" aria-live="polite">
        {fatal ? (
          <div className="empty-state" role="alert" data-testid="fatal-log-error">
            <h2>事件日志不可用</h2>
            <p>{fatal}</p>
          </div>
        ) : session.configured ? (
          <ConfiguredChat key={session.chatKey} config={session.config} logger={logger} onError={setFatal} />
        ) : (
          <div className="empty-state" data-testid="config-required-state">
            <h2>{session.configReady ? "先完成模型配置" : "正在读取配置…"}</h2>
            <p>{session.configReady ? "打开设置页填写 Base URL、Model ID 和 API Key。" : "正在检查本地模型配置。"}</p>
            {session.status && <p role="status">{session.status}</p>}
          </div>
        )}
      </section>
    </main>
  );
}

function ConfiguredChat({
  config,
  logger,
  onError,
}: {
  config: ModelConfig;
  logger: EventLogger;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<SidePanelMessage[] | null>(null);

  useEffect(() => {
    let active = true;
    void logger.messages().then((stored) => {
      if (active) setMessages(stored as SidePanelMessage[]);
    }).catch((error) => {
      if (active) onError(errorText(error));
    });
    return () => {
      active = false;
    };
  }, [logger, onError]);

  if (!messages) return <div className="empty-state" data-testid="conversation-loading">正在恢复对话…</div>;
  return <ConfiguredRuntime config={config} logger={logger} messages={messages} />;
}

function ConfiguredRuntime({ config, logger, messages }: { config: ModelConfig; logger: EventLogger; messages: SidePanelMessage[] }) {
  const runtime = useSidePanelRuntime(config, logger, messages);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
