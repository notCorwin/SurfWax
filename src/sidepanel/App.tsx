import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { CodeXmlIcon, MessageSquarePlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationMenu } from "../components/assistant-ui/thread-list";
import { Thread } from "../components/assistant-ui/thread";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/error-notice";
import { generateConversationTitle } from "../conversations";
import { activeContext, ensureAutomaticContextSummary } from "../agent/context-choice";
import { contextPressure, pendingContextChoice } from "../agent/compaction";
import { activeRunIdentity, claimConversationRun, getRunIdentity, registerBackgroundRequest, withIdleConversation, type RunIdentity } from "../agent/coordinator";
import { EventLogger, fromLogValue, rebuildConversationList } from "../logging";
import type { ModelConfig } from "../types";
import { useSidePanelRuntime } from "./useSidePanelRuntime";
import { useRunState } from "./useRunState";
import { commandRuntime, createThreadView, RuntimeViewContext, useRuntimeView } from "./runtime-view";
import { useSidePanelSession } from "./useSidePanelSession";
import "../styles.css";
import "./styles.css";

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

function UserScriptsButton() {
  return <Button type="button" variant="ghost" size="icon-sm" data-testid="open-user-scripts"
    aria-label="打开用户脚本" title="打开用户脚本" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("userscripts.html") })}>
    <CodeXmlIcon aria-hidden="true" />
  </Button>;
}

function NewConversationButton({ setWarning }: { setWarning: (message: string) => void }) {
  const runtime = useRuntimeView();
  const { locked } = useRunState();
  useEffect(() => { if (!locked) setWarning(""); }, [locked, setWarning]);
  return <Button type="button" variant="ghost" size="icon-sm" aria-label="新对话" title="新对话" data-testid="new-conversation" disabled={locked}
    onClick={() => void withIdleConversation(async () => { await runtime.assistant.threads.switchToNewThread(); setWarning(""); }).catch((error) => setWarning(String(error.message)))}>
    <MessageSquarePlusIcon aria-hidden="true" />
  </Button>;
}

function Header({ conversation = false, logger }: { conversation?: boolean; logger?: EventLogger }) {
  const [warning, setWarning] = useState("");
  return <><a className="skip-link" href="#chat-content">跳转到内容</a><header className="app-header">
    {conversation && logger ? <ConversationMenu logger={logger} /> : <h1>Surf Wax</h1>}
    <div className="flex gap-2">{conversation && <NewConversationButton setWarning={setWarning} />}<UserScriptsButton /><SettingsButton /></div>
  </header>{warning && <p role="status" className="conversation-notice">{warning}</p>}</>;
}

export function App() {
  const session = useSidePanelSession();
  const [fatal, setFatal] = useState<unknown>();
  const logger = useMemo(() => new EventLogger({ onError: setFatal }), []);

  if (fatal !== undefined) {
    const reloadExtension = fatal instanceof Error && fatal.message.startsWith("后台初始化失败");
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <Header />
        <section id="chat-content" tabIndex={-1} className="chat-scroll">
          <div className="empty-state" data-testid="fatal-log-error">
            <ErrorNotice summary={reloadExtension ? "后台初始化失败；请重新加载扩展。" : "事件日志不可用；请检查存储并重新打开侧栏。"} error={fatal} />
            <Button type="button" variant="outline" data-testid="reload-sidepanel" onClick={() => reloadExtension ? chrome.runtime.reload() : location.reload()}>{reloadExtension ? "重新加载扩展" : "重新加载侧栏"}</Button>
          </div>
        </section>
      </main>
    );
  }

  if (session.configured) {
    return <ConfiguredChat config={session.config} systemPrompt={session.systemPrompt} logger={logger} onError={setFatal} />;
  }

  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <Header />
      <section id="chat-content" tabIndex={-1} className="chat-scroll">
        <div className="empty-state" data-testid="config-required-state">
          <h2>{session.configReady ? "先完成模型配置" : "正在准备对话…"}</h2>
          <p>{session.configReady ? "打开设置页选择 Provider，并填写 Model ID 和 API Key。" : "正在读取模型配置…"}</p>
          {session.error !== undefined && <ErrorNotice summary="配置读取失败；请打开设置页重试。" error={session.error} />}
        </div>
      </section>
    </main>
  );
}

function ConfiguredChat({ config, systemPrompt, logger, onError }: { config: ModelConfig; systemPrompt?: string; logger: EventLogger; onError: (error: unknown) => void }) {
  const [initialThreadId, setInitialThreadId] = useState<string | null>();

  useEffect(() => {
    let active = true;
    // Wait for worker boot outside the recovery lock: worker reconciliation
    // uses that same lock before it begins replying to ownership queries.
    void activeRunIdentity().then(() => logger.recoverDanglingRuns(async () => { const owner = await activeRunIdentity(); return owner ? [owner.runId] : []; })).then(() => {
      if (!active) return;
      setInitialThreadId(null);
    }).catch((error) => {
      if (active) onError(error);
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
  return <ConfiguredRuntime config={config} systemPrompt={systemPrompt} logger={logger} initialThreadId={initialThreadId ?? undefined} />;
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

function ConfiguredRuntime({ config, systemPrompt, logger, initialThreadId }: { config: ModelConfig; systemPrompt?: string; logger: EventLogger; initialThreadId?: string }) {
  const runtime = useSidePanelRuntime(config, systemPrompt, logger, initialThreadId);
  const commands = useMemo(() => commandRuntime(runtime), [runtime]);
  const view = useMemo(() => ({ ...createThreadView(runtime.thread), assistant: runtime }), [runtime]);
  return (
    <RuntimeViewContext.Provider value={view}>
      <AssistantRuntimeProvider runtime={commands}>
        <ConfiguredConversation config={config} logger={logger} />
      </AssistantRuntimeProvider>
    </RuntimeViewContext.Provider>
  );
}

function ConfiguredConversation({ config, logger }: { config: ModelConfig; logger: EventLogger }) {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const drafts = useRef(new Map<string, string>());
  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <ReloadConversationList logger={logger} config={config} />
      <Header conversation logger={logger} />
      <RunOwnershipNotice />
      <ConversationView key={threadId} config={config} logger={logger} threadId={threadId} drafts={drafts.current} />
    </main>
  );
}

function RunOwnershipNotice() {
  const [owner, setOwner] = useState<RunIdentity>();
  const localRunning = useAuiState((state) => state.thread.isRunning);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const changed = (message: { type?: string; identity?: RunIdentity | null }) => {
      if (message.type !== "surf-wax:run-state") return;
      revision += 1;
      if (active) setOwner(message.identity ?? undefined);
    };
    chrome.runtime.onMessage.addListener(changed);
    const requestedAt = revision;
    void activeRunIdentity().then((identity) => { if (active && revision === requestedAt) setOwner(identity); }).catch(() => undefined);
    return () => { active = false; chrome.runtime.onMessage.removeListener(changed); };
  }, []);
  return owner && !localRunning && owner.runId !== getRunIdentity()?.runId
    ? <p role="status" data-testid="other-run-busy" className="conversation-notice">其他窗口已有任务运行；请等待完成或在原侧栏停止任务。</p>
    : null;
}

function ConversationView({ config, logger, threadId, drafts }: { config: ModelConfig; logger: EventLogger; threadId: string; drafts: Map<string, string> }) {
  const conversationId = useAuiState((state) => state.threadListItem.remoteId ?? state.threadListItem.id);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const [guardWarning, setGuardWarning] = useState("");
  const [contextStatus, setContextStatus] = useState<{ message: string; error: boolean }>();
  const [compactionBusy, setCompactionBusy] = useState(false);
  const [compactionError, setCompactionError] = useState("");
  const [retry, setRetry] = useState<{ attempt: number; delayMs: number; reason: string }>();
  const refreshing = useRef(false);
  const compactionController = useRef<AbortController | undefined>(undefined);
  const refreshContext = useRef<(forced?: boolean) => Promise<void>>(async () => undefined);
  useEffect(() => {
    const onMessage = (message: { type?: string; tabId?: number }) => {
      if (message?.type === "surf-wax:guard-warning") setGuardWarning(
        Number.isInteger(message.tabId) ? `标签页 ${message.tabId} 无法启用防点击保护；智能体仍可继续运行。` : "当前标签页无法启用防点击保护；智能体仍可继续运行。",
      );
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);
  useEffect(() => logger.subscribe((event) => {
    if (event.conversationId !== conversationId) return;
    if (event.type === "context.compacted" || event.type === "context.checkpoint.applied") {
      setContextStatus({ message: "历史上下文已被压缩成摘要", error: false });
      setCompactionError("");
    } else if (event.type === "context.compaction.started") {
      setContextStatus({ message: "正在自动压缩上下文…", error: false });
    } else if (event.type === "context.limit.unavailable") {
      setContextStatus({ message: "无法取得模型上下文窗口；自动压缩暂不可用，可在设置中手动指定。", error: true });
    } else if (event.type === "context.compaction.failed") {
      setContextStatus({ message: "上下文压缩失败；请检查模型响应或设置中的窗口大小。", error: true });
      setCompactionError(JSON.stringify(fromLogValue(event.error)) ?? "模型未能生成摘要");
    } else if (event.type === "context.compaction.aborted") {
      setContextStatus({ message: "上下文压缩已停止；原始历史已保留。", error: false });
    } else if (["request.retry", "conversation.stream.retry", "model.request.retrying", "model.stream.retrying"].includes(event.type)) {
      const value = fromLogValue(event.retry) as { attempt?: number; delayMs?: number } | undefined;
      const content = fromLogValue(event.content) as { status?: number; reason?: string } | undefined;
      setRetry({ attempt: value?.attempt ?? 1, delayMs: value?.delayMs ?? 0,
        reason: content?.status ? `服务返回 ${content.status}` : content?.reason === "network" ? "网络连接中断" : content?.reason ?? "暂时无法完成请求" });
    } else if (["request.completed", "request.aborted", "request.failed", "conversation.finished", "conversation.aborted", "conversation.failed"].includes(event.type)) {
      setRetry(undefined);
    }
  }), [conversationId, logger]);
  useEffect(() => {
    let active = true;
    const refresh = async (force = false) => {
      if (refreshing.current || isRunning) return;
      refreshing.current = true;
      const controller = new AbortController();
      compactionController.current = controller;
      let lease: Awaited<ReturnType<typeof claimConversationRun>> | undefined;
      const unregister = registerBackgroundRequest(controller, conversationId);
      try {
        const before = await activeContext(logger, conversationId);
        if (!active) return;
        const lastRun = [...before.events].reverse().find((event) => ["conversation.finished", "conversation.failed", "conversation.aborted", "conversation.submitted"].includes(event.type));
        const overflow = lastRun?.type === "conversation.failed"
          && /context.{0,30}(length|window|token)|maximum.{0,30}token/i.test(JSON.stringify(lastRun.error))
          && (!before.checkpoint || before.checkpoint.eventId < lastRun.id);
        const pressure = await contextPressure({ raw: before.raw, branchIds: before.branchIds, events: before.events, model: config, signal: controller.signal });
        if (!active) return;
        if (!force && !overflow && !pendingContextChoice(before.events, before.branchIds)
          && (!pressure || pressure.estimated <= pressure.threshold)) {
          setContextStatus(before.checkpoint ? { message: "历史上下文已被压缩成摘要", error: false } : undefined);
          return;
        }
        // Post-turn upkeep yields to an active owner, including another side panel.
        if (await activeRunIdentity()) return;
        controller.signal.throwIfAborted();
        lease = await claimConversationRun(conversationId, controller.signal);
        if (!active) { controller.abort("sidepanel-closed"); return; }
        setCompactionBusy(true);
        setCompactionError("");
        await ensureAutomaticContextSummary(logger, conversationId, config, lease.signal, { forced: force || overflow, limit: pressure?.limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (active && !controller.signal.aborted && !lease?.signal.aborted && !message.includes("已有任务运行")) {
          setCompactionError(message);
          setContextStatus({ message: "上下文自动压缩失败；原始历史已保留。", error: true });
        }
      } finally {
        unregister();
        lease?.finish();
        if (compactionController.current === controller) compactionController.current = undefined;
        refreshing.current = false;
        if (active) setCompactionBusy(false);
      }
    };
    refreshContext.current = refresh;
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId !== conversationId) return;
      if (event.type === "conversation.finished" || event.type === "conversation.branch.selected") void refresh();
      if (event.type === "conversation.failed" && /context.{0,30}(length|window|token)|maximum.{0,30}token/i.test(JSON.stringify(event.error))) void refresh(true);
    });
    void refresh();
    return () => { active = false; unsubscribe(); compactionController.current?.abort("sidepanel-closed"); };
  }, [config, conversationId, isRunning, logger]);
  return (
    <>
      {guardWarning && <ErrorNotice role="status" summary={guardWarning} />}
      {contextStatus && (contextStatus.error
        ? <ErrorNotice testId="context-status" summary={contextStatus.message} />
        : <p role="status" data-testid="context-status">{contextStatus.message}</p>)}
      {retry && <p role="status" data-testid="request-retry" className="conversation-notice">
        {retry.reason}；正在第 {retry.attempt} 次重试，等待 {Math.ceil(retry.delayMs / 1000)} 秒。
      </p>}
      {(compactionBusy || compactionError) && <section role="group" aria-label="上下文处理" data-testid="context-maintenance" className="conversation-notice">
        <div className="flex gap-2">
          {compactionBusy ? <Button type="button" variant="outline" onClick={() => compactionController.current?.abort("user-stopped-compaction")}>停止压缩</Button>
            : <Button type="button" variant="outline" disabled={isRunning} onClick={() => void refreshContext.current(true)}>重试压缩</Button>}
        </div>
        {compactionBusy && <p role="status">正在处理上下文…</p>}
        {compactionError && <ErrorNotice testId="context-maintenance-error" summary="上下文处理失败；可以重试压缩。" error={compactionError} />}
      </section>}
      <section id="chat-content" tabIndex={-1} className="chat-scroll" data-testid="chat-scroll">
        <Thread config={config} logger={logger} conversationId={conversationId} contextBlocked={compactionBusy} draft={drafts.get(threadId)} onDraftChange={(value) => {
          if (value) drafts.set(threadId, value);
          else drafts.delete(threadId);
        }} />
      </section>
    </>
  );
}
