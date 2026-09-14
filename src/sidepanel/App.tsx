import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EventLogger } from "../logging";
import type { ModelConfig } from "../types";
import { UserScriptsPanel } from "../userscripts/UserScriptsPanel";
import { ChromeToolCall } from "./ChromeToolCall";
import { useSidePanelSession } from "./useSidePanelSession";
import { useSidePanelRuntime } from "./useSidePanelRuntime";
import { Thread } from "../components/assistant-ui/thread";
import "../styles.css";
import "./styles.css";

const welcomeSuggestions = [
  { prompt: "移除页面广告" },
  { prompt: "添加深色模式" },
  { prompt: "做最酷的事情" },
] as const;

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

export function App() {
  const session = useSidePanelSession();
  const eventLogger = useMemo(() => new EventLogger(), []);

  return (
    <SidePanelLayout modelLabel={session.modelLabel} logger={eventLogger}>
      {session.configured ? (
        <ConfiguredChat key={session.chatKey} config={session.config} logger={eventLogger} />
      ) : (
        <div className="empty-state" data-testid="config-required-state">
          <div className="empty-icon">⌘</div>
          <h2>{session.configReady ? "先完成模型配置" : "正在读取配置…"}</h2>
          <p>
            {session.configReady
              ? "打开设置页填写 Provider、Model ID 和 API Key，保存后即可开始对话。"
              : "正在检查本地保存的模型配置。"}
          </p>
          {session.status && <p className="config-status" role="status">{session.status}</p>}
        </div>
      )}
    </SidePanelLayout>
  );
}

function SidePanelLayout({
  modelLabel,
  logger,
  children,
}: {
  modelLabel: string;
  logger: EventLogger;
  children: ReactNode;
}) {
  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <header className="app-header">
        <div className="app-title">
          <h1>Side Agent Runtime</h1>
          {modelLabel && <p className="app-model" data-testid="model-label">{modelLabel}</p>}
        </div>
        <button
          type="button"
          className="open-settings-button"
          data-testid="open-settings"
          aria-label="打开设置"
          title="打开设置"
          onClick={openSettings}
        >
          <SettingsIcon className="size-4" aria-hidden="true" />
        </button>
      </header>

      <UserScriptsPanel logger={logger} mode="sidepanel" />

      <section className="chat-scroll" data-testid="chat-scroll" aria-live="polite">
        {children}
      </section>
    </main>
  );
}

function ConfiguredChat({ config, logger }: { config: ModelConfig; logger: EventLogger }) {
  const [messages, setMessages] = useState<UIMessage[] | null>(null);

  useEffect(() => {
    let active = true;
    void logger.messages().then((stored) => {
      if (active) setMessages(stored as UIMessage[]);
    }).catch(() => {
      if (active) setMessages([]);
    });
    return () => {
      active = false;
    };
  }, [logger]);

  if (!messages) return <div className="empty-state" data-testid="conversation-loading">正在恢复对话…</div>;
  return <ConfiguredChatRuntime config={config} logger={logger} messages={messages} />;
}

function ConfiguredChatRuntime({
  config,
  logger,
  messages,
}: {
  config: ModelConfig;
  logger: EventLogger;
  messages: UIMessage[];
}) {
  const runtime = useSidePanelRuntime(config, welcomeSuggestions, logger, messages);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={THREAD_COMPONENTS} />
    </AssistantRuntimeProvider>
  );
}

const THREAD_COMPONENTS = { ToolFallback: ChromeToolCall };
