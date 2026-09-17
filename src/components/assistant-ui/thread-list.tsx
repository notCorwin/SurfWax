"use client";

import { ThreadListItemPrimitive, ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArchiveIcon, MenuIcon, MessageSquarePlusIcon, PencilIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FC, type MouseEvent } from "react";
import { fromLogValue, isConversationMessage, type EventLogger, type LogEvent } from "../../logging";
import { Button } from "../ui/button";

export function buildMessageSearchIndex(events: readonly LogEvent[]): Map<string, string> {
  const messages = new Map<string, Map<string, string>>();
  for (const event of events) {
    if (!event.conversationId || event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content);
    if (!isConversationMessage(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = message.parts.flatMap((part) => part && typeof part === "object"
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text] : []).join("\n");
    const byId = messages.get(event.conversationId) ?? new Map<string, string>();
    byId.set(message.id, text);
    messages.set(event.conversationId, byId);
  }
  return new Map([...messages].map(([id, byId]) => [id, [...byId.values()].join("\n").toLocaleLowerCase()]));
}

export const ConversationMenu: FC<{ logger: EventLogger }> = ({ logger }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const aui = useAui();
  const title = useAuiState((state) => state.threadListItem.title || "新对话");
  const running = useAuiState((state) => state.thread.isRunning);
  const threadIds = useAuiState((state) => state.threads.threadIds);
  const archivedIds = useAuiState((state) => state.threads.archivedThreadIds);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => new Map<string, string>());
  const [warning, setWarning] = useState("");
  const [searchError, setSearchError] = useState("");
  const requestSearchIndex = useRef<() => void>(() => undefined);
  const close = () => dialog.current?.close();
  const warn = () => setWarning("当前会话尚未结束，请等待完成或先停止运行。");

  useEffect(() => { if (!running) setWarning(""); }, [running]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let revision = 0;
    let requested = false;
    // ponytail: scan saved messages on menu open; add a persistent search index only if this becomes slow.
    const refresh = () => {
      requested = true;
      const current = ++revision;
      void logger.messageEvents().then((events) => {
        if (active && current === revision) { setIndex(buildMessageSearchIndex(events)); setSearchError(""); }
      }).catch((error) => {
        if (active && current === revision) setSearchError(error instanceof Error ? error.message : String(error));
      });
    };
    requestSearchIndex.current = () => { if (!requested) refresh(); };
    const prefetch = setTimeout(() => requestSearchIndex.current(), 500);
    const unsubscribe = logger.subscribe((event) => {
      if (event.type === "conversation.message" || event.type === "conversation.deleted") refresh();
    });
    return () => { active = false; clearTimeout(prefetch); requestSearchIndex.current = () => undefined; unsubscribe(); };
  }, [logger, open]);

  useEffect(() => { if (open && query.trim()) requestSearchIndex.current(); }, [open, query]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = useCallback((item: { id: string; remoteId?: string; title?: string }) => !needle
    || (item.title ?? "新对话").toLocaleLowerCase().includes(needle)
    || (index.get(item.remoteId ?? item.id) ?? "").includes(needle), [index, needle]);
  const visible = (ids: readonly string[]) => ids.filter((id) => matches(aui.threads.item({ id }).getState())).length;
  const regularCount = open ? visible(threadIds) : 0;
  const archivedCount = open ? visible(archivedIds) : 0;

  return (
    <>
      <Button ref={trigger} type="button" variant="ghost" className="conversation-trigger" data-testid="conversation-menu" onClick={() => { setOpen(true); dialog.current?.showModal(); }}>
        <MenuIcon aria-hidden="true" />
        <span>{title}</span>
      </Button>
      <dialog ref={dialog} className="conversation-dialog" aria-label="对话列表" onClose={() => { setOpen(false); setWarning(""); setQuery(""); setIndex(new Map()); trigger.current?.focus(); }} onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}>
        {open && <ThreadListPrimitive.Root className="conversation-drawer">
          <header>
            <strong>对话</strong>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭对话列表" title="关闭" onClick={close}>
              <XIcon aria-hidden="true" />
            </Button>
          </header>
          <input type="search" aria-label="搜索会话" placeholder="搜索标题或消息…" value={query} onChange={(event) => setQuery(event.target.value)} className="conversation-search" />
          {warning && <p role="status" className="conversation-notice">{warning}</p>}
          {searchError && <p role="alert" className="conversation-notice">搜索记录读取失败：{searchError}</p>}
          <ThreadListPrimitive.New className="conversation-new" onClick={(event) => {
            if (running) { event.preventDefault(); warn(); return; }
            close();
          }}>
            <MessageSquarePlusIcon aria-hidden="true" />
            新对话
          </ThreadListPrimitive.New>
          <div className="conversation-items">
            {regularCount > 0 && <h2 className="conversation-section-title">当前会话</h2>}
            <ThreadListPrimitive.Items>
              {({ threadListItem }) => matches(threadListItem) ? <ConversationItem close={close} running={running} warn={warn} /> : null}
            </ThreadListPrimitive.Items>
            {archivedCount > 0 && <h2 className="conversation-section-title">已归档</h2>}
            <ThreadListPrimitive.Items archived>
              {({ threadListItem }) => matches(threadListItem) ? <ConversationItem close={close} running={running} warn={warn} archived /> : null}
            </ThreadListPrimitive.Items>
            {regularCount + archivedCount === 0 && <p className="conversation-empty">{needle ? "没有找到匹配的会话" : "暂无已保存的会话"}</p>}
          </div>
        </ThreadListPrimitive.Root>}
      </dialog>
    </>
  );
};

const ConversationItem: FC<{ close: () => void; running: boolean; warn: () => void; archived?: boolean }> = ({ close, running, warn, archived = false }) => {
  const aui = useAui();
  const title = useAuiState((state) => state.threadListItem.title || "新对话");
  const isCurrent = useAuiState((state) => state.threads.mainThreadId === state.threadListItem.id);
  const runStatus = useAuiState((state) => (state.threadListItem.custom as { runStatus?: string } | undefined)?.runStatus ?? "idle");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const finishEditing = () => {
    const search = input.current?.closest("dialog")?.querySelector<HTMLInputElement>("input[type=search]");
    setEditing(false);
    setError("");
    requestAnimationFrame(() => (renameButton.current ?? search)?.focus());
  };
  const save = () => {
    const value = draft.trim();
    if (!value) { setError("请输入会话名称"); input.current?.focus(); return; }
    void aui.threadListItem.rename(value);
    finishEditing();
  };
  const cancel = finishEditing;
  const guard = (event: MouseEvent<HTMLButtonElement>, wouldSwitch: boolean) => {
    if (!running || !wouldSwitch) return false;
    event.preventDefault();
    warn();
    return true;
  };
  return (
    <ThreadListItemPrimitive.Root className="conversation-item">
      {editing ? <div className="conversation-rename">
        <input ref={input} autoFocus aria-label="会话名称" aria-invalid={Boolean(error)} value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); save(); }
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
        }} />
        <Button type="button" size="sm" onClick={save}>保存</Button>
        <Button type="button" size="sm" variant="ghost" onClick={cancel}>取消</Button>
        {error && <small role="alert">{error}</small>}
      </div> : <>
        <ThreadListItemPrimitive.Trigger className="conversation-select" onClick={(event) => {
          if (guard(event, !isCurrent)) return;
          close();
        }}>
          <span><ThreadListItemPrimitive.Title fallback="新对话" /></span>
          {runStatus !== "idle" && <small data-status={runStatus}>{runStatus === "running" ? "运行中" : "已中断"}</small>}
        </ThreadListItemPrimitive.Trigger>
        <Button ref={renameButton} type="button" variant="ghost" size="icon-sm" className="conversation-action" aria-label={`重命名 ${title}`} title="重命名" onClick={() => { setDraft(title); setEditing(true); }}>
          <PencilIcon aria-hidden="true" />
        </Button>
        {archived ? <ThreadListItemPrimitive.Unarchive className="conversation-action" aria-label={`恢复 ${title}`} title="恢复归档"><RotateCcwIcon aria-hidden="true" /></ThreadListItemPrimitive.Unarchive>
          : <ThreadListItemPrimitive.Archive className="conversation-action" aria-label={`归档 ${title}`} title="归档" onClick={(event) => { guard(event, isCurrent); }}><ArchiveIcon aria-hidden="true" /></ThreadListItemPrimitive.Archive>}
        <ThreadListItemPrimitive.Delete
          className="conversation-delete"
          aria-label={`永久删除 ${title}`}
          title="永久删除"
          onClick={(event) => {
            if (guard(event, isCurrent)) return;
            if (!globalThis.confirm("确定永久删除这条对话及其事件日志吗？此操作不可恢复。")) event.preventDefault();
          }}
        >
          <Trash2Icon aria-hidden="true" />
        </ThreadListItemPrimitive.Delete>
      </>}
    </ThreadListItemPrimitive.Root>
  );
};
