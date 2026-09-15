import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConversationMenu } from "../components/assistant-ui/thread-list";
import { Thread } from "../components/assistant-ui/thread";
import { Button } from "../components/ui/button";
import { generateConversationTitle } from "../conversations";
import { EventLogger, rebuildConversationList, selectedConversationId } from "../logging";
import type { ModelConfig } from "../types";
import { useSidePanelRuntime } from "./useSidePanelRuntime";
import { useSidePanelSession } from "./useSidePanelSession";
import "../styles.css";
import "./styles.css";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SettingsButton() {
  return (
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
  );
}

export function App() {
  const session = useSidePanelSession();
  const [fatal, setFatal] = useState("");
  const logger = useMemo(() => new EventLogger({ onError: (error) => setFatal(errorText(error)) }), []);

  if (fatal) {
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <header className="app-header"><h1>Side Agent Runtime</h1><SettingsButton /></header>
        <section className="chat-scroll">
          <div className="empty-state" role="alert" data-testid="fatal-log-error">
            <h2>事件日志不可用</h2><p>{fatal}</p>
          </div>
        </section>
      </main>
    );
  }

  if (session.configured) {
    return <ConfiguredChat key={session.chatKey} config={session.config} logger={logger} onError={setFatal} />;
  }

  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <header className="app-header"><h1>Side Agent Runtime</h1><SettingsButton /></header>
      <section className="chat-scroll">
        <div className="empty-state" data-testid="config-required-state">
          <h2>{session.configReady ? "先完成模型配置" : "正在读取配置…"}</h2>
          <p>{session.configReady ? "打开设置页填写 Base URL、Model ID 和 API Key。" : "正在检查本地模型配置。"}</p>
          {session.status && <p role="status">{session.status}</p>}
        </div>
      </section>
    </main>
  );
}

function ConfiguredChat({ config, logger, onError }: { config: ModelConfig; logger: EventLogger; onError: (message: string) => void }) {
  const [initialThreadId, setInitialThreadId] = useState<string | null>();

  useEffect(() => {
    let active = true;
    void logger.recoverDanglingRuns().then(() => logger.summaryEvents()).then((events) => {
      if (!active) return;
      setInitialThreadId(selectedConversationId(events) ?? rebuildConversationList(events)[0]?.id ?? null);
    }).catch((error) => {
      if (active) onError(errorText(error));
    });
    return () => { active = false; };
  }, [logger, onError]);

  if (initialThreadId === undefined) {
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <header className="app-header"><h1>Side Agent Runtime</h1><SettingsButton /></header>
        <section className="chat-scroll"><div className="empty-state" data-testid="conversation-loading">正在恢复对话…</div></section>
      </main>
    );
  }
  return <ConfiguredRuntime config={config} logger={logger} initialThreadId={initialThreadId ?? undefined} />;
}

function ReloadConversationList({ logger, config }: { logger: EventLogger; config: ModelConfig }) {
  const aui = useAui();
  useEffect(() => {
    const recoverTitle = async (conversationId: string) => {
      const events = await logger.summaryEvents(conversationId);
      const summary = rebuildConversationList(events)[0];
      const lastTitleLifecycle = [...events].reverse().find((event) => event.type.startsWith("model.title."));
      if (!summary || summary.title !== "新对话" || !events.some((event) => event.type === "conversation.finished")) return;
      if (lastTitleLifecycle?.type === "model.title.finished" || lastTitleLifecycle?.type === "model.title.failed") return;
      await generateConversationTitle(logger, config, conversationId);
    };
    void logger.summaryEvents().then((events) => Promise.allSettled(
      rebuildConversationList(events).map(({ id }) => recoverTitle(id)),
    ));
    return logger.subscribe((event) => {
      if (["conversation.submitted", "conversation.finished", "conversation.failed", "conversation.aborted", "conversation.title.updated"].includes(event.type)) {
        void aui.threads.reload();
      }
      if (event.type === "conversation.finished" && event.conversationId) void recoverTitle(event.conversationId).catch(() => undefined);
    });
  }, [aui, config, logger]);
  return null;
}

function ConfiguredRuntime({ config, logger, initialThreadId }: { config: ModelConfig; logger: EventLogger; initialThreadId?: string }) {
  const runtime = useSidePanelRuntime(config, logger, initialThreadId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="app-shell" data-testid="sidepanel-shell">
        <ReloadConversationList logger={logger} config={config} />
        <header className="app-header">
          <ConversationMenu />
          <SettingsButton />
        </header>
        <section className="chat-scroll" data-testid="chat-scroll"><Thread /></section>
      </main>
    </AssistantRuntimeProvider>
  );
}
