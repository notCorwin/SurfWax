"use client";

import { useAui, useAuiState, type AssistantState } from "@assistant-ui/react";
import { ArchiveIcon, PencilIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { flushSync } from "react-dom";
import { activeRunIdentity, withIdleConversation } from "../../agent/coordinator";
import { fromLogValue, isConversationMessage, type EventLogger, type LogEvent } from "../../logging";
import { useRunState } from "../../sidepanel/useRunState";
import { useRuntimeView } from "../../sidepanel/runtime-view";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ErrorNotice } from "../ui/error-notice";

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
  const trigger = useRef<HTMLButtonElement>(null);
  const aui = useAui();
  const { locked } = useRunState();
  const threads = useAuiState((state) => state.threads);
  const { threadItems: allItems, mainThreadId: currentId, threadIds, archivedThreadIds: archivedIds } = threads;
  const title = allItems.find((item) => item.id === currentId)?.title || "新对话";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => new Map<string, string>());
  const [warning, setWarning] = useState("");
  const [searchError, setSearchError] = useState<unknown>();
  const requestSearchIndex = useRef<() => void>(() => undefined);
  const cachedMessages = useRef(new Map<string, Map<string, LogEvent>>());
  const ingest = (event: LogEvent) => {
    if (!event.conversationId) return;
    const message = fromLogValue(event.content);
    if (!isConversationMessage(message)) return;
    const entries = cachedMessages.current.get(event.conversationId) ?? new Map<string, LogEvent>();
    if ((entries.get(message.id)?.id ?? -1) < event.id) entries.set(message.id, event);
    cachedMessages.current.set(event.conversationId, entries);
  };
  const indexed = useRef(false);
  const close = () => { setOpen(false); setWarning(""); setQuery(""); };
  const warn = () => setWarning("当前会话尚未结束，请等待完成或先停止运行。");

  useEffect(() => { if (!locked) setWarning(""); }, [locked]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let revision = 0;
    let requested = false;
    // This cache is a derived view of the canonical log, updated one event at a time.
    const refresh = () => {
      requested = true;
      const current = ++revision;
      void (indexed.current ? Promise.resolve([]) : logger.messageEvents()).then((events) => {
        if (active && current === revision) { for (const event of events) ingest(event); indexed.current = true; setIndex(buildMessageSearchIndex([...cachedMessages.current.values()].flatMap((entries) => [...entries.values()]))); setSearchError(undefined); }
      }).catch((error) => {
        if (active && current === revision) setSearchError(error);
      });
    };
    requestSearchIndex.current = () => { if (!requested) refresh(); };
    const prefetch = setTimeout(() => requestSearchIndex.current(), 500);
    return () => { active = false; clearTimeout(prefetch); requestSearchIndex.current = () => undefined; };
  }, [logger, open]);

  useEffect(() => logger.subscribe((event) => {
    if (event.type === "conversation.message") {
      ingest(event);
      if (indexed.current && event.conversationId) {
        const changed = buildMessageSearchIndex([...cachedMessages.current.get(event.conversationId)!.values()]);
        setIndex((previous) => new Map([...previous, ...changed]));
      }
    }
    if (event.type === "conversation.deleted") {
      const id = (fromLogValue(event.content) as { conversationId?: string })?.conversationId;
      if (id) cachedMessages.current.delete(id);
      setIndex((previous) => { const next = new Map(previous); if (id) next.delete(id); return next; });
    }
  }), [logger]);

  useEffect(() => { if (open && query.trim()) requestSearchIndex.current(); }, [open, query]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = useCallback((item: { id: string; remoteId?: string; title?: string }) => !needle
    || (item.title ?? "新对话").toLocaleLowerCase().includes(needle)
    || (index.get(item.remoteId ?? item.id) ?? "").includes(needle), [index, needle]);
  const visible = (ids: readonly string[]) => allItems.filter((item) => ids.includes(item.id) && matches(item)).length;
  const regularCount = open ? visible(threadIds) : 0;
  const archivedCount = open ? visible(archivedIds) : 0;

  const renderItems = (ids: readonly string[], archived = false) => ids.map((id) => {
    const item = allItems.find((item) => item.id === id);
    return item && matches(item) ? <ConversationItem key={id} item={item} isCurrent={currentId === id} close={close} locked={locked} warn={warn} archived={archived} /> : null;
  });
  return <Dialog open={open} onOpenChange={(value) => { if (value) setOpen(true); else close(); }}>
    <DialogTrigger asChild><Button ref={trigger} type="button" variant="ghost" className="conversation-trigger" data-testid="conversation-menu"><span>{title}</span></Button></DialogTrigger>
    <DialogContent className="conversation-dialog" aria-describedby={undefined} showCloseButton={false}
      onEscapeKeyDown={(event) => { if (document.activeElement?.getAttribute("aria-label") === "会话名称") event.preventDefault(); }}>
      <div className="conversation-drawer">
        <header><DialogTitle className="text-base">对话列表</DialogTitle><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭对话列表" title="关闭" onClick={close}><XIcon aria-hidden="true" /></Button></header>
        <Input type="search" aria-label="搜索会话" placeholder="搜索标题或消息…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {warning && <p role="status" className="conversation-notice">{warning}</p>}
        {searchError !== undefined && <ErrorNotice summary="搜索记录读取失败。" error={searchError} />}
        <div className="conversation-items">
          {regularCount > 0 && <h2 className="conversation-section-title">当前会话</h2>}{renderItems(threadIds)}
          {archivedCount > 0 && <h2 className="conversation-section-title">已归档</h2>}{renderItems(archivedIds, true)}
          {regularCount + archivedCount === 0 && <p className="conversation-empty">{needle ? "没有找到匹配的会话" : "暂无已保存的会话"}</p>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
};

type Item = AssistantState["threads"]["threadItems"][number];
const ConversationItem: FC<{ item: Item; isCurrent: boolean; close: () => void; locked: boolean; warn: () => void; archived?: boolean }> = ({ item, isCurrent, close, locked, warn, archived = false }) => {
  const runtime = useRuntimeView();
  const aui = useAui();
  const client = aui.threads.item({ id: item.id });
  const title = item.title || "新对话";
  const runStatus = item.custom?.runStatus ?? "idle";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const finishEditing = () => { setEditing(false); setError(""); };
  const mutate = async (action: () => void) => {
    if (locked || await activeRunIdentity()) { warn(); return; }
    action();
  };
  const save = () => {
    if (!draft.trim()) { setError("请输入会话名称"); input.current?.focus(); return; }
    void mutate(() => { client.rename(draft.trim()); finishEditing(); });
  };
  return <div className="conversation-item" data-active={isCurrent ? "" : undefined}>
    {editing ? <div className="conversation-rename">
      <Input ref={input} autoFocus aria-label="会话名称" aria-invalid={Boolean(error)} disabled={locked} value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} onKeyDown={(event) => {
        event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); save(); } if (event.key === "Escape") { event.preventDefault(); finishEditing(); }
      }} />
      <Button type="button" size="sm" disabled={locked} onClick={save}>保存</Button><Button type="button" size="sm" variant="ghost" onClick={finishEditing}>取消</Button>
      {error && <small role="alert">{error}</small>}
    </div> : <>
      <Button type="button" variant="ghost" className="conversation-select" disabled={locked && !isCurrent} onClick={() => {
        if (isCurrent) { close(); return; }
        if (locked) { warn(); return; }
        void withIdleConversation(async () => {
          await runtime.assistant.threads.switchToThread(item.id);
          // Commit the destination composer before dismissing the modal so a
          // fast keystroke cannot be saved under the conversation just left.
          flushSync(close);
        }).catch(warn);
      }}><span>{title}</span>{runStatus !== "idle" && <small data-status={String(runStatus)}>{runStatus === "running" ? "运行中" : "已中断"}</small>}</Button>
      <Button type="button" variant="ghost" size="icon-sm" disabled={locked} className="conversation-action" aria-label={`重命名 ${title}`} title="重命名" onClick={() => void mutate(() => { setDraft(title); setEditing(true); })}><PencilIcon aria-hidden="true" /></Button>
      <Button type="button" variant="ghost" size="icon-sm" disabled={locked} className="conversation-action" aria-label={`${archived ? "恢复" : "归档"} ${title}`} title={archived ? "恢复归档" : "归档"} onClick={() => void mutate(() => archived ? client.unarchive() : client.archive())}>
        {archived ? <RotateCcwIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" disabled={locked} className="conversation-delete" aria-label={`永久删除 ${title}`} title="永久删除" onClick={() => void mutate(() => {
        if (globalThis.confirm("确定永久删除这条对话及其事件日志吗？此操作不可恢复。")) client.delete();
      })}><Trash2Icon aria-hidden="true" /></Button>
    </>}
  </div>;
};
