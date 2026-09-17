import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { CodeXmlIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConversationMenu } from "../components/assistant-ui/thread-list";
import { Thread } from "../components/assistant-ui/thread";
import { Button } from "../components/ui/button";
import { generateConversationTitle } from "../conversations";
import { EventLogger, rebuildConversationList } from "../logging";
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
      variant="ghost"
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

function ScriptsButton() {
  return <Button type="button" variant="ghost" size="icon-sm" aria-label="管理用户脚本" title="管理用户脚本" data-testid="open-user-scripts"
    onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("userscripts.html") })}>
    <CodeXmlIcon aria-hidden="true" />
  </Button>;
}

function UserScriptsNotice() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const check = () => {
      if (!chrome.userScripts) { setEnabled(false); return; }
      void Promise.resolve().then(() => chrome.userScripts.getScripts()).then(
        () => { if (active) setEnabled(true); },
        () => { if (active) setEnabled(false); },
      );
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    chrome.tabs.onActivated.addListener(check);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      chrome.tabs.onActivated.removeListener(check);
    };
  }, []);
  if (enabled !== false) return null;
  return <p role="status" data-testid="user-scripts-disabled" className="user-scripts-notice">
    尚未开启 Allow User Scripts。请在 Surf Wax 扩展详情中开启。{' '}
    <button type="button" onClick={() => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>打开扩展详情</button>
  </p>;
}

function Header({ conversation = false }: { conversation?: boolean }) {
  return <><a className="skip-link" href="#chat-content">跳转到内容</a><header className="app-header">
    {conversation ? <ConversationMenu /> : <h1>Surf Wax</h1>}
    <div className="flex gap-2"><ScriptsButton /><SettingsButton /></div>
  </header><UserScriptsNotice /></>;
}

export function App() {
  const session = useSidePanelSession();
  const [fatal, setFatal] = useState("");
  const logger = useMemo(() => new EventLogger({ onError: (error) => setFatal(errorText(error)) }), []);

  if (fatal) {
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <Header />
        <section id="chat-content" tabIndex={-1} className="chat-scroll">
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
      <Header />
      <section id="chat-content" tabIndex={-1} className="chat-scroll">
        <div className="empty-state" data-testid="config-required-state">
          <h2>{session.configReady ? "先完成模型配置" : "正在准备对话…"}</h2>
          <p>{session.configReady ? "打开设置页填写 Base URL、Model ID 和 API Key。" : "正在读取模型配置…"}</p>
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
    void logger.recoverDanglingRuns().then(() => {
      if (!active) return;
      setInitialThreadId(null);
    }).catch((error) => {
      if (active) onError(errorText(error));
    });
    return () => { active = false; };
  }, [logger, onError]);

  if (initialThreadId === undefined) {
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <Header />
        <section id="chat-content" tabIndex={-1} className="chat-scroll"><div className="empty-state" data-testid="conversation-loading">正在恢复对话…</div></section>
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
  const [guardWarning, setGuardWarning] = useState("");
  const [contextStatus, setContextStatus] = useState("");
  useEffect(() => {
    const onMessage = (message: { type?: string; detail?: string }) => {
      if (message?.type === "surf-wax:guard-warning") setGuardWarning(message.detail ?? "网页无法防止点击");
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);
  useEffect(() => logger.subscribe((event) => {
    if (event.type === "context.compacted" || event.type === "context.checkpoint.applied") {
      setContextStatus("模型正在使用压缩摘要；完整对话仍保留在记录中。");
    } else if (event.type === "context.limit.unavailable") {
      setContextStatus("无法取得模型上下文窗口；自动压缩暂不可用，可在设置中手动指定。");
    } else if (event.type === "context.compaction.failed") {
      setContextStatus("上下文压缩失败；请检查模型响应或设置中的窗口大小。");
    } else if (event.type === "conversation.selected") setContextStatus("");
  }), [logger]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="app-shell" data-testid="sidepanel-shell">
        <ReloadConversationList logger={logger} config={config} />
        <Header conversation />
        {guardWarning && <p role="status">{guardWarning}</p>}
        {contextStatus && <p role="status" data-testid="context-status">{contextStatus}</p>}
        <section id="chat-content" tabIndex={-1} className="chat-scroll" data-testid="chat-scroll"><Thread config={config} /></section>
      </main>
    </AssistantRuntimeProvider>
  );
}
