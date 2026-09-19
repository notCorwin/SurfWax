import { AssistantRuntimeProvider, ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { CodeXmlIcon, MessageSquarePlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationMenu } from "../components/assistant-ui/thread-list";
import { Thread } from "../components/assistant-ui/thread";
import { Button, buttonVariants } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/error-notice";
import { generateConversationTitle } from "../conversations";
import { activeContext, applySummaryChoice, ensureContextChoice, forkSelection, proposeJevSelection, type SelectionProposal } from "../agent/context-choice";
import { pendingContextChoice } from "../agent/compaction";
import { EventLogger, rebuildConversationList } from "../logging";
import type { JevConfig, ModelConfig } from "../types";
import { useSidePanelRuntime } from "./useSidePanelRuntime";
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

function ScriptsButton() {
  return <Button type="button" variant="ghost" size="icon-sm" aria-label="管理用户脚本" title="管理用户脚本" data-testid="open-user-scripts"
    onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("userscripts.html") })}>
    <CodeXmlIcon aria-hidden="true" />
  </Button>;
}

function NewConversationButton({ setWarning }: { setWarning: (message: string) => void }) {
  const running = useAuiState((state) => state.thread.isRunning);
  useEffect(() => { if (!running) setWarning(""); }, [running, setWarning]);
  return <ThreadListPrimitive.New
    className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
    aria-label="新对话"
    title="新对话"
    data-testid="new-conversation"
    onClick={(event) => {
      if (running) { event.preventDefault(); setWarning("当前会话尚未结束，请等待完成或先停止运行。"); }
      else setWarning("");
    }}
  ><MessageSquarePlusIcon aria-hidden="true" /></ThreadListPrimitive.New>;
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

function Header({ conversation = false, logger }: { conversation?: boolean; logger?: EventLogger }) {
  const [warning, setWarning] = useState("");
  return <><a className="skip-link" href="#chat-content">跳转到内容</a><header className="app-header">
    {conversation && logger ? <ConversationMenu logger={logger} /> : <h1>Surf Wax</h1>}
    <div className="flex gap-2">{conversation && <NewConversationButton setWarning={setWarning} />}<ScriptsButton /><SettingsButton /></div>
  </header>{warning && <p role="status" className="conversation-notice">{warning}</p>}<UserScriptsNotice /></>;
}

export function App() {
  const session = useSidePanelSession();
  const [fatal, setFatal] = useState<unknown>();
  const logger = useMemo(() => new EventLogger({ onError: setFatal }), []);

  if (fatal !== undefined) {
    return (
      <main className="app-shell" data-testid="sidepanel-shell">
        <Header />
        <section id="chat-content" tabIndex={-1} className="chat-scroll">
          <div className="empty-state" data-testid="fatal-log-error">
            <ErrorNotice summary="事件日志不可用；请检查存储并重新打开侧栏。" error={fatal} />
          </div>
        </section>
      </main>
    );
  }

  if (session.configured) {
    return <ConfiguredChat key={session.chatKey} config={session.config} jevConfig={session.jevConfigured ? session.jevConfig : undefined} logger={logger} onError={setFatal} />;
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

function ConfiguredChat({ config, jevConfig, logger, onError }: { config: ModelConfig; jevConfig?: JevConfig; logger: EventLogger; onError: (error: unknown) => void }) {
  const [initialThreadId, setInitialThreadId] = useState<string | null>();

  useEffect(() => {
    let active = true;
    void logger.recoverDanglingRuns().then(() => {
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
  return <ConfiguredRuntime config={config} jevConfig={jevConfig} logger={logger} initialThreadId={initialThreadId ?? undefined} />;
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

function ConfiguredRuntime({ config, jevConfig, logger, initialThreadId }: { config: ModelConfig; jevConfig?: JevConfig; logger: EventLogger; initialThreadId?: string }) {
  const runtime = useSidePanelRuntime(config, logger, initialThreadId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ConfiguredConversation config={config} jevConfig={jevConfig} logger={logger} />
    </AssistantRuntimeProvider>
  );
}

function ConfiguredConversation({ config, jevConfig, logger }: { config: ModelConfig; jevConfig?: JevConfig; logger: EventLogger }) {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const drafts = useRef(new Map<string, string>());
  return (
    <main className="app-shell" data-testid="sidepanel-shell">
      <ReloadConversationList logger={logger} config={config} />
      <Header conversation logger={logger} />
      <ConversationView key={threadId} config={config} jevConfig={jevConfig} logger={logger} threadId={threadId} drafts={drafts.current} />
    </main>
  );
}

function ConversationView({ config, jevConfig, logger, threadId, drafts }: { config: ModelConfig; jevConfig?: JevConfig; logger: EventLogger; threadId: string; drafts: Map<string, string> }) {
  const aui = useAui();
  const conversationId = useAuiState((state) => state.threadListItem.remoteId ?? state.threadListItem.id);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const [guardWarning, setGuardWarning] = useState("");
  const [contextStatus, setContextStatus] = useState<{ message: string; error: boolean }>();
  const [choicePending, setChoicePending] = useState(false);
  const [proposal, setProposal] = useState<SelectionProposal>();
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [choiceError, setChoiceError] = useState("");
  const refreshing = useRef(false);
  const choiceController = useRef<AbortController | undefined>(undefined);
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
    } else if (event.type === "context.limit.unavailable") {
      setContextStatus({ message: "无法取得模型上下文窗口；自动压缩暂不可用，可在设置中手动指定。", error: true });
    } else if (event.type === "context.compaction.failed") {
      setContextStatus({ message: "上下文压缩失败；请检查模型响应或设置中的窗口大小。", error: true });
    }
  }), [conversationId, logger]);
  useEffect(() => {
    let active = true;
    const refresh = async (force = false) => {
      if (refreshing.current || isRunning) return;
      refreshing.current = true;
      try {
        const before = await activeContext(logger, conversationId);
        const lastRun = [...before.events].reverse().find((event) => ["conversation.finished", "conversation.failed", "conversation.aborted", "conversation.submitted"].includes(event.type));
        const overflow = lastRun?.type === "conversation.failed" && /context.{0,30}(length|window|token)|maximum.{0,30}token/i.test(JSON.stringify(lastRun.error));
        if (lastRun && (lastRun.type === "conversation.finished" || force || overflow) && !pendingContextChoice(before.events, before.branchIds)) {
          await ensureContextChoice(logger, conversationId, config, force || overflow);
        }
        const after = await activeContext(logger, conversationId);
        if (active) {
          setChoicePending(pendingContextChoice(after.events, after.branchIds));
          if (after.checkpoint) setContextStatus({ message: "历史上下文已被压缩成摘要", error: false });
        }
      } catch (error) {
        if (active) setChoiceError(error instanceof Error ? error.message : String(error));
      } finally { refreshing.current = false; }
    };
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId !== conversationId) return;
      if (event.type === "conversation.finished" || event.type === "conversation.branch.selected" || event.type.startsWith("context.choice.")) void refresh();
      if (event.type === "conversation.failed" && /context.{0,30}(length|window|token)|maximum.{0,30}token/i.test(JSON.stringify(event.error))) void refresh(true);
    });
    void refresh();
    return () => { active = false; unsubscribe(); choiceController.current?.abort("panel closed"); };
  }, [config, conversationId, isRunning, logger]);

  const runChoice = async (action: (signal: AbortSignal) => Promise<void>) => {
    setChoiceBusy(true);
    setChoiceError("");
    const controller = new AbortController();
    choiceController.current = controller;
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setChoiceError(error instanceof Error ? error.message : String(error)); }
    finally { choiceController.current = undefined; setChoiceBusy(false); }
  };
  const commitSelection = async (choice: SelectionProposal, threshold?: number) => {
    const childId = await forkSelection(logger, conversationId, choice, threshold);
    setChoicePending(false);
    setProposal(undefined);
    await aui.threads.reload();
    const ids = aui.threads.getState().threadIds;
    const localId = ids.find((id) => aui.threads.item({ id }).getState().remoteId === childId) ?? childId;
    aui.threads.switchToThread(localId);
  };
  return (
    <>
      {guardWarning && <ErrorNotice role="status" summary={guardWarning} />}
      {contextStatus && (contextStatus.error
        ? <ErrorNotice testId="context-status" summary={contextStatus.message} />
        : <p role="status" data-testid="context-status">{contextStatus.message}</p>)}
      {choicePending && <section role="group" aria-label="上下文处理" data-testid="context-choice" className="conversation-notice">
        <p>上下文已达到阈值。请选择 Jev 重选或 LLM 摘要后继续。</p>
        {!jevConfig && <p>Jev 尚未配置。<button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>打开设置</button></p>}
        {proposal && proposal.estimated > proposal.inputThreshold && <p>
          {proposal.minimumRaisedThreshold === undefined
            ? "即使提高至 0.99，按当前估算仍无法达到上下文窗口的 30%；请改用摘要。"
            : `按当前估算，临时最低保留评分至少提高到 ${proposal.minimumRaisedThreshold.toFixed(2)}，才能降至上下文窗口的 30%。`}
        </p>}
        <div className="flex gap-2">
          {jevConfig && !proposal && <Button type="button" disabled={choiceBusy} onClick={() => void runChoice(async (signal) => {
            const next = await proposeJevSelection({ logger, conversationId, model: config, jev: jevConfig, signal });
            if (next.estimated <= next.inputThreshold) await commitSelection(next);
            else setProposal(next);
          })}>Jev 重选</Button>}
          {proposal?.minimumRaisedThreshold !== undefined && <Button type="button" disabled={choiceBusy} onClick={() => void runChoice(async () => {
            await commitSelection(proposal, proposal.minimumRaisedThreshold);
          })}>临时提高并创建新会话</Button>}
          <Button type="button" variant="outline" disabled={choiceBusy} onClick={() => void runChoice(async (signal) => {
            await applySummaryChoice(logger, conversationId, config, signal);
            setChoicePending(false);
            setProposal(undefined);
          })}>LLM 摘要</Button>
        </div>
        {choiceBusy && <p role="status">正在处理上下文…</p>}
        {choiceError && <ErrorNotice summary="上下文处理失败；可以重试或选择摘要。" error={choiceError} />}
      </section>}
      <section id="chat-content" tabIndex={-1} className="chat-scroll" data-testid="chat-scroll">
        <Thread config={config} logger={logger} conversationId={conversationId} contextBlocked={choicePending} draft={drafts.get(threadId)} onDraftChange={(value) => {
          if (value) drafts.set(threadId, value);
          else drafts.delete(threadId);
        }} />
      </section>
    </>
  );
}
