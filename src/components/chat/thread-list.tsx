"use client";
import { usePanelRuntime, usePanelState, type PanelState } from "@/sidepanel/runtime-view";

import { ChevronDownIcon, SearchIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { flushSync } from "react-dom";
import { activeRunIdentity, withIdleConversation } from "../../agent/coordinator";
import { fromLogValue, isConversationMessage, type EventLogger, type LogEvent } from "../../logging";
import { useRunState } from "../../sidepanel/useRunState";
import { useRuntimeView } from "../../sidepanel/runtime-view";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { InputGroup, InputGroupInput, InputGroupAddon } from "../ui/input-group";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ErrorNotice } from "../ui/error-notice";

export function buildMessageSearchIndex(events: readonly LogEvent[]): Map<string, string> {
  const messages = new Map<string, Map<string, string>>();
  for (const event of events) {
    if (!event.conversationId || event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content, event.valueEncoding);
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
  const runtimeCommands = usePanelRuntime();
  const searchInput = useRef<HTMLInputElement>(null);
  const { locked } = useRunState();
  const threads = usePanelState((state) => state.threads);
  const { threadItems: allItems, mainThreadId: currentId } = threads;
  const title = allItems.find((item) => item.id === currentId)?.title || "新对话";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => new Map<string, string>());
  const [warning, setWarning] = useState("");
  const [searchError, setSearchError] = useState<unknown>();
  const [deleted, setDeleted] = useState<{ id: string; title: string }>();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestSearchIndex = useRef<() => void>(() => undefined);
  const cachedMessages = useRef(new Map<string, Map<string, LogEvent>>());
  const ingest = (event: LogEvent) => {
    if (!event.conversationId) return;
    const message = fromLogValue(event.content, event.valueEncoding);
    if (!isConversationMessage(message)) return;
    const entries = cachedMessages.current.get(event.conversationId) ?? new Map<string, LogEvent>();
    if ((entries.get(message.id)?.id ?? -1) < event.id) entries.set(message.id, event);
    cachedMessages.current.set(event.conversationId, entries);
  };
  const indexed = useRef(false);
  const close = () => { setOpen(false); setWarning(""); setQuery(""); };
  const warn = () => setWarning("当前会话尚未结束，请等待完成或先停止运行。");

  useEffect(() => { if (!locked) setWarning(""); }, [locked]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const deletedConversation = (id: string, deletedTitle: string) => {
    setDeleted({ id, title: deletedTitle });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setDeleted(undefined), 6_000);
  };

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
      const id = event.conversationId ?? (fromLogValue(event.content, event.valueEncoding) as { conversationId?: string } | null)?.conversationId;
      setIndex((previous) => { const next = new Map(previous); if (id) next.delete(id); return next; });
    }
    if (event.type === "conversation.restored" && event.conversationId) {
      const entries = cachedMessages.current.get(event.conversationId);
      if (entries) setIndex((previous) => new Map([...previous, ...buildMessageSearchIndex([...entries.values()])]));
    }
  }), [logger]);

  useEffect(() => { if (open && query.trim()) requestSearchIndex.current(); }, [open, query]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = useCallback((item: { id: string; remoteId?: string; title?: string }) => !needle
    || (item.title ?? "新对话").toLocaleLowerCase().includes(needle)
    || (index.get(item.remoteId ?? item.id) ?? "").includes(needle), [index, needle]);
  const visibleItems = open ? allItems.filter(matches) : [];
  return <Popover open={open} onOpenChange={(value) => { if (value) setOpen(true); else close(); }}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" className="conversation-trigger" data-testid="conversation-menu" title={title}><span>{title}</span><ChevronDownIcon data-icon="inline-end" aria-hidden="true" /></Button></PopoverTrigger>
    <PopoverContent className="conversation-dropdown flex min-h-0 flex-col gap-1 overflow-hidden p-2" aria-label="对话列表"
      side="bottom" align="start" sideOffset={8} collisionPadding={12}
      onOpenAutoFocus={(event) => { event.preventDefault(); searchInput.current?.focus(); }}
      onEscapeKeyDown={(event) => { if (document.activeElement?.getAttribute("aria-label") === "会话名称") event.preventDefault(); }}>
      <InputGroup className="shrink-0"><InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon><InputGroupInput ref={searchInput} type="search" aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></InputGroup>
      {warning && <p role="status" className="conversation-notice">{warning}</p>}
      {deleted && <div role="status" className="conversation-notice flex items-center justify-between gap-2"><span>已删除“{deleted.title}”</span>
        <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void runtimeCommands.threads.restore(deleted.id).then(async () => {
          clearTimeout(undoTimer.current); setDeleted(undefined);
          const events = await logger.messageEvents();
          for (const event of events) ingest(event);
          indexed.current = true;
          setIndex(buildMessageSearchIndex([...cachedMessages.current.values()].flatMap((entries) => [...entries.values()])));
        }).catch(warn)}>撤销</Button></div>}
      {searchError !== undefined && <ErrorNotice summary="搜索记录读取失败。" error={searchError} />}
      <div className="conversation-items">
        {visibleItems.map((item) => <ConversationItem key={item.id} item={item} isCurrent={currentId === item.id} close={close} locked={locked} warn={warn} onDeleted={deletedConversation} />)}
        {visibleItems.length === 0 && <p className="conversation-empty">{needle ? "没有找到匹配的会话" : "暂无已保存的会话"}</p>}
      </div>
    </PopoverContent>
  </Popover>;
};

type Item = PanelState["threads"]["threadItems"][number];
const ConversationItem: FC<{ item: Item; isCurrent: boolean; close: () => void; locked: boolean; warn: () => void; onDeleted: (id: string, title: string) => void }> = ({ item, isCurrent, close, locked, warn, onDeleted }) => {
  const runtime = useRuntimeView();
  const runtimeCommands = usePanelRuntime();
  const client = runtimeCommands.threads.item({ id: item.id });
  const title = item.title || "新对话";
  const runStatus = item.custom?.runStatus ?? "idle";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const finishEditing = () => { setEditing(false); setError(""); };
  const mutate = async (action: () => unknown) => {
    try { if (locked || await activeRunIdentity()) { warn(); return; } await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const save = () => {
    if (!draft.trim()) { setError("请输入会话名称"); input.current?.focus(); return; }
    void mutate(async () => { await client.rename(draft.trim()); finishEditing(); });
  };
  return <div className="conversation-item group" data-active={isCurrent ? "" : undefined}>
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
          await runtime.runtime.threads.switchToThread(item.id);
          // Commit the destination composer before dismissing the dropdown so a
          // fast keystroke cannot be saved under the conversation just left.
          flushSync(close);
        }).catch(warn);
      }}><span>{title}</span>{runStatus !== "idle" && <small data-status={String(runStatus)}>{runStatus === "running" ? "运行中" : "已中断"}</small>}</Button>
      <div role="group" aria-label="会话操作" className="pointer-events-none flex shrink-0 items-center gap-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
        <Button type="button" variant="ghost" size="icon-sm" disabled={locked} className="conversation-action" aria-label={`重命名 ${title}`} title="重命名" onClick={() => void mutate(() => { setDraft(title); setEditing(true); })}><PencilIcon aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={locked} className="conversation-delete" aria-label={`删除 ${title}`} title="删除" onClick={() => void mutate(async () => { await client.delete(); onDeleted(item.id, title); })}><Trash2Icon aria-hidden="true" /></Button>
      </div>
    </>}
    {!editing && error && <ErrorNotice summary="会话操作失败。" error={error} />}
  </div>;
};
