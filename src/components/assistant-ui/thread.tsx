"use client";

import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, PencilIcon, RotateCcwIcon, WrenchIcon } from "lucide-react";
import {
  type ComponentProps,
  type FC,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/error-notice";
import { LocalComposer } from "./local-composer";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";
import { workLabel } from "./work-time";
import type { ModelConfig } from "@/types";
import type { EventLogger, LogEvent } from "@/logging";

const ESTIMATED_TURN_HEIGHT = 200;
const AT_BOTTOM_THRESHOLD = 4;

type MessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>["components"];
type MessageRow = { id: string; role: "user" | "assistant" | "system" };
type Turn = { id: string; messageIds: string[]; assistantIds: string[] };
type WorkView = { mode: "process" | "final"; finalMessageId: string };
const WorkViewContext = createContext<WorkView | null>(null);

export function completedWork(events: readonly LogEvent[]): Map<string, number> {
  const started = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const event of events) {
    if (!event.runId) continue;
    if (event.type === "conversation.submitted") started.set(event.runId, Date.parse(event.timestamp));
    if (event.type !== "conversation.finished") continue;
    const messageId = (event.content as { messageId?: unknown } | null)?.messageId;
    const start = started.get(event.runId);
    if (typeof messageId === "string" && start !== undefined && Number.isFinite(start)) {
      completed.set(messageId, Math.max(0, Math.floor((Date.parse(event.timestamp) - start) / 1000)));
    }
  }
  return completed;
}

function useMessageRows(): readonly MessageRow[] {
  const previous = useRef<readonly MessageRow[]>([]);
  return useAuiState((state) => {
    const messages = state.thread.messages;
    if (previous.current.length === messages.length && previous.current.every((row, index) =>
      row.id === messages[index]!.id && row.role === messages[index]!.role)) return previous.current;
    previous.current = messages.map(({ id, role }) => ({ id, role }));
    return previous.current;
  });
}

function buildTurns(messages: readonly MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  for (const { id, role } of messages) {
    const last = turns.at(-1);
    if (role === "user" || !last) turns.push({ id, messageIds: [id], assistantIds: role === "assistant" ? [id] : [] });
    else {
      last.messageIds.push(id);
      if (role === "assistant") last.assistantIds.push(id);
    }
  }
  return turns;
}

export const Thread: FC<{ config: ModelConfig; logger: EventLogger; conversationId: string; contextBlocked?: boolean; draft?: string; onDraftChange: (value: string) => void }> = ({ config, logger, conversationId, contextBlocked, draft, onDraftChange }) => {
  const messages = useMessageRows();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const [completed, setCompleted] = useState(() => new Map<string, number>());
  useEffect(() => {
    let active = true;
    const refresh = () => void logger.summaryEvents(conversationId).then((events) => {
      if (active) setCompleted(completedWork(events));
    }).catch(() => undefined);
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId === conversationId && event.type === "conversation.finished") refresh();
    });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [logger, conversationId]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => turns[index]!.id,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 800, width: 430 },
    overscan: 4,
    scrollToFn: (offset, _options, instance) => {
      const scroller = instance.scrollElement;
      if (!scroller) return;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      if (stickyRef.current && maxScroll - scroller.scrollTop <= AT_BOTTOM_THRESHOLD && offset < maxScroll) return;
      scroller.scrollTo(0, offset);
    },
  });

  const jumpToBottom = useCallback(() => {
    stickyRef.current = true;
    if (turns.length > 0) virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller && stickyRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
  }, [turns.length, virtualizer]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let lastScrollTop = scroller.scrollTop;
    let lastScrollHeight = scroller.scrollHeight;
    let lastClientHeight = scroller.clientHeight;
    const onScroll = () => {
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_THRESHOLD;
      if (atBottom) stickyRef.current = true;
      else if (scroller.scrollTop < lastScrollTop
        && scroller.scrollHeight === lastScrollHeight
        && Math.abs(scroller.clientHeight - lastClientHeight) <= 1) stickyRef.current = false;
      lastScrollTop = scroller.scrollTop;
      lastScrollHeight = scroller.scrollHeight;
      lastClientHeight = scroller.clientHeight;
      setIsAtBottom(atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyRef.current = false;
    };
    const disarm = () => { stickyRef.current = false; };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchmove", disarm, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchmove", disarm);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const previousRunning = useRef(false);
  useLayoutEffect(() => {
    if (isRunning && !previousRunning.current) jumpToBottom();
    previousRunning.current = isRunning;
  }, [isRunning, jumpToBottom]);

  const firstTurnId = turns[0]?.id;
  const previousFirstTurnId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (previousFirstTurnId.current === firstTurnId) return;
    previousFirstTurnId.current = firstTurnId;
    if (firstTurnId) jumpToBottom();
  }, [firstTurnId, jumpToBottom]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));

  return (
    <ThreadPrimitive.Root data-testid="thread-root" className="relative flex h-full min-h-0 flex-col bg-background">
      <div ref={scrollerRef} data-testid="thread-viewport" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div ref={contentRef} className="mx-auto w-full max-w-(--thread-max-width) px-1 pt-3 pb-10">
          <div style={{ paddingTop, paddingBottom }}>
            {items.map((item) => {
              const turn = turns[item.index]!;
              const assistantIds = turn.assistantIds;
              const finalMessageId = assistantIds.at(-1);
              const duration = finalMessageId === undefined ? undefined : completed.get(finalMessageId);
              return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="conversation-turn flex flex-col">
                {turn.messageIds.filter((id) => !assistantIds.includes(id)).map((messageId) => (
                  <ThreadPrimitive.Unstable_MessageById key={messageId} messageId={messageId} components={MESSAGE_COMPONENTS} />
                ))}
                {duration === undefined || !finalMessageId ? assistantIds.map((messageId) => (
                  <ThreadPrimitive.Unstable_MessageById key={messageId} messageId={messageId} components={MESSAGE_COMPONENTS} />
                )) : <>
                  <details className="work-summary thinking-item px-2" data-testid="work-summary" onToggle={(event) => {
                    const row = event.currentTarget.closest<HTMLElement>(".conversation-turn");
                    if (row) virtualizer.measureElement(row);
                  }}>
                    <summary><ClockIcon aria-hidden="true" /><span>{workLabel(duration)}</span></summary>
                    <div className="work-summary-content">
                      {assistantIds.map((messageId) => <WorkViewContext.Provider key={messageId} value={{ mode: "process", finalMessageId }}>
                        <ThreadPrimitive.Unstable_MessageById messageId={messageId} components={MESSAGE_COMPONENTS} />
                      </WorkViewContext.Provider>)}
                    </div>
                  </details>
                  <WorkViewContext.Provider value={{ mode: "final", finalMessageId }}>
                    <ThreadPrimitive.Unstable_MessageById messageId={finalMessageId} components={MESSAGE_COMPONENTS} />
                  </WorkViewContext.Provider>
                </>}
              </div>;
            })}
          </div>
        </div>
      </div>
      <div className="relative shrink-0 bg-background px-1 pt-2 pb-2">
        {turns.length > 0 && !isAtBottom && (
          <Button type="button" variant="outline" size="icon-sm" className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 rounded-full" aria-label="滚动到底部" title="滚动到底部" onClick={jumpToBottom}>
            <ArrowDownIcon data-icon="icon" aria-hidden="true" />
          </Button>
        )}
        <LocalComposer config={config} blocked={contextBlocked} draft={draft} onDraftChange={onDraftChange} />
      </div>
    </ThreadPrimitive.Root>
  );
};

export const CONTINUE_INTERRUPTED_TEXT = "继续上一次被中断的工作。不要重复已经完成的操作；先根据上面的工具结果确认当前状态。";

const AssistantMessage: FC = () => {
  const aui = useAui();
  const workView = useContext(WorkViewContext);
  const parts = useAuiState((state) => state.message.parts);
  const messageId = useAuiState((state) => state.message.id);
  const interrupted = useAuiState((state) => state.message.metadata.custom?.interrupted === true);
  const latest = useAuiState((state) => state.thread.messages.at(-1)?.id === state.message.id);
  const lastAnswerStart = (() => {
    if (messageId !== workView?.finalMessageId) return parts.length;
    let index = parts.length;
    while (index > 0 && parts[index - 1]?.type === "text") index--;
    return index;
  })();
  const groupBy = useMemo(() => {
    const commandGroup = groupPartByType({ "tool-call": ["group-command"] });
    if (!workView) return commandGroup;
    const indices = new Map(parts.map((part, index) => [part, index]));
    return (part: typeof parts[number], context: Parameters<typeof commandGroup>[1]) => [
      (indices.get(part) ?? 0) >= lastAnswerStart ? "group-final" : "group-process",
      ...commandGroup(part, context),
    ] as const;
  }, [parts, workView?.mode, workView?.finalMessageId, lastAnswerStart]);
  if (workView?.mode === "process" && messageId === workView.finalMessageId && lastAnswerStart === 0) return null;
  if (workView?.mode === "final" && lastAnswerStart === parts.length) return null;
  return (
    <MessagePrimitive.Root data-role="assistant" aria-live={latest ? "polite" : undefined} className="assistant-message min-w-0 px-2 text-sm">
      <div className="assistant-message-content flex flex-col wrap-break-word">
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            if (part.type === "group-process") return workView?.mode === "process" ? children : null;
            if (part.type === "group-final") return workView?.mode === "final" ? children : null;
            if (part.type === "group-command") return part.indices.length === 1 || part.status.type === "running" ? children : (
              <details className="activity command-group" open={part.status.type === "incomplete"}>
                <summary><WrenchIcon aria-hidden="true" /><span>共 {part.indices.length} 次命令调用</span></summary>
                <div className="command-group-content">{children}</div>
              </details>
            );
            if (part.type === "text") return <MarkdownText />;
            if (part.type === "reasoning") return <Reasoning {...part} />;
            if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
            return null;
          }}
        </MessagePrimitive.GroupedParts>
        {interrupted && workView?.mode !== "final" && (
          <div className="interrupted-message" data-testid="interrupted-message">
            <span>回复已中断</span>
            {latest && <Button type="button" variant="outline" size="sm" data-testid="continue-interrupted" onClick={() => aui.thread.append({
              role: "user",
              content: [{ type: "text", text: CONTINUE_INTERRUPTED_TEXT }],
            })}>继续</Button>}
          </div>
        )}
        {workView?.mode !== "process" && <MessagePrimitive.Error>
          <ErrorPrimitive.Root>
            <ErrorNotice role="none" summary="模型请求失败。" details={<ErrorPrimitive.Message />} />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>}
      </div>
      {workView?.mode !== "process" && <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
        <ActionBarPrimitive.Root hideWhenRunning>
          <ActionBarPrimitive.Reload type="button" data-testid="replay-message-button" className="inline-flex size-7 items-center justify-center rounded hover:bg-muted" aria-label="重新生成回复" title="重新生成回复">
            <RotateCcwIcon className="size-3.5" aria-hidden="true" />
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
        <MessageBranches />
      </div>}
    </MessagePrimitive.Root>
  );
};

const MessageBranches: FC = () => (
  <BranchPickerPrimitive.Root hideWhenSingleBranch className="flex items-center gap-0.5 tabular-nums" aria-label="消息分支">
    <BranchPickerPrimitive.Previous type="button" className="inline-flex size-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label="上一个分支" title="上一个分支">
      <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
    </BranchPickerPrimitive.Previous>
    <span className="min-w-8 text-center"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
    <BranchPickerPrimitive.Next type="button" className="inline-flex size-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label="下一个分支" title="下一个分支">
      <ChevronRightIcon className="size-3.5" aria-hidden="true" />
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);

const UserMessage: FC = () => {
  const editing = useAuiState((state) => state.message.composer.isEditing);
  const running = useAuiState((state) => state.thread.isRunning);
  return (
    <MessagePrimitive.Root data-role="user" className="ml-auto max-w-[94%] text-sm leading-relaxed">
      {editing ? (
        <ComposerPrimitive.Root className="rounded-xl border border-border/70 bg-muted/30 p-2 shadow-sm focus-within:border-ring">
          <ComposerPrimitive.Input data-testid="edit-message-input" autoFocus rows={2} className="min-h-14 max-h-32 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-1 text-sm leading-relaxed outline-none" aria-label="编辑消息" />
          <div className="mt-2 flex justify-end gap-1">
            <ComposerPrimitive.Cancel type="button" className="inline-flex min-h-8 items-center rounded-md px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">取消</ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send type="submit" className="inline-flex min-h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">保存并重新生成</ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      ) : (
        <div className="rounded-xl border border-primary/40 bg-primary/15 px-3 py-2 wrap-break-word">
          <MessagePrimitive.Parts />
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1 text-xs text-muted-foreground">
        {!editing && !running && <ActionBarPrimitive.Root>
          <ActionBarPrimitive.Edit type="button" data-testid="edit-message-button" className="inline-flex size-7 items-center justify-center rounded hover:bg-muted" aria-label="编辑消息" title="编辑消息">
            <PencilIcon className="size-3.5" aria-hidden="true" />
          </ActionBarPrimitive.Edit>
        </ActionBarPrimitive.Root>}
        <MessageBranches />
      </div>
    </MessagePrimitive.Root>
  );
};

const MESSAGE_COMPONENTS: MessageComponents = { UserMessage, AssistantMessage };

export default Thread;
