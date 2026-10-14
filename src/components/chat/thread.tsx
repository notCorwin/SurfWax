"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import { useFrameThread } from "@/sidepanel/frame-view";
import { useRunState } from "@/sidepanel/useRunState";
import { createTurnProjection } from "@/sidepanel/turn-projection";
import { Welcome } from "./welcome";
import { ErrorNotice } from "../ui/error-notice";
import { LocalComposer } from "./local-composer";
import { MessageRow, type MessageView, type WorkView } from "./message-row";
import { workLabel } from "./work-time";
import type { ModelConfig } from "@/types";
import type { EventLogger, LogEvent } from "@/logging";

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

export function Thread({ config, logger, conversationId, contextBlocked, draft, onDraftChange }: {
  config: ModelConfig; logger: EventLogger; conversationId: string; contextBlocked?: boolean; draft?: string; onDraftChange: (value: string) => void;
}) {
  const state = useFrameThread();
  const { locked } = useRunState();
  const projectTurns = useMemo(createTurnProjection, []);
  const turns = useMemo(() => projectTurns(state.messages), [projectTurns, state.messages]);
  const [completed, setCompleted] = useState(() => new Map<string, number>());
  const [warning, setWarning] = useState("");
  const command = useCallback((action: () => void) => {
    if (locked) { setWarning("当前会话尚未结束，请等待完成或先停止运行。"); return; }
    void Promise.resolve().then(action).catch((error) => setWarning(error instanceof Error ? error.message : String(error)));
  }, [locked]);
  useEffect(() => {
    let active = true;
    const refresh = () => void logger.summaryEvents(conversationId).then((events) => { if (active) setCompleted(completedWork(events)); });
    const unsubscribe = logger.subscribe((event) => { if (event.conversationId === conversationId && event.type === "conversation.finished") refresh(); });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [logger, conversationId]);
  useEffect(() => { if (!locked) setWarning(""); }, [locked]);
  const scroller = useRef<HTMLDivElement>(null);
  const followingEnd = useRef(true);
  const virtualizer = useVirtualizer({ count: turns.length, estimateSize: () => 200, getItemKey: projectTurns.getItemKey(),
    getScrollElement: () => scroller.current, initialRect: { height: 800, width: 430 }, overscan: 2,
    useFlushSync: false, directDomUpdates: true, useAnimationFrameWithResizeObserver: true });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const viewport = scroller.current;
    if (!viewport || !followingEnd.current || turns.length === 0) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [state.messages, totalSize, turns.length]);
  return <div data-testid="thread-root" className="relative flex h-full min-h-0 flex-col">
    {state.error !== undefined && <ErrorNotice summary="会话读取失败，请重试。" error={state.error} />}
    {warning && <p role="status" className="conversation-notice">{warning}</p>}
    <MessageScrollerProvider autoScroll={false}>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport ref={scroller} data-testid="thread-viewport" className="overflow-x-hidden"
          onWheel={() => { followingEnd.current = false; }} onTouchMove={() => { followingEnd.current = false; }}
          onPointerDown={() => { followingEnd.current = false; }}
          onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) followingEnd.current = false; }}
          onScroll={(event) => { const viewport = event.currentTarget; if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) followingEnd.current = true; }}>
          <MessageScrollerContent className="mx-auto block w-full max-w-(--thread-max-width) px-4 pt-5 pb-8">
            {turns.length === 0 && !state.isLoading && <Welcome disabled={locked} />}
            {state.isLoading && <p role="status" className="conversation-notice py-8">正在读取对话…</p>}
            <div ref={virtualizer.containerRef} className="relative w-full" style={{ height: totalSize }}>
              {items.map((item) => {
                const turn = turns[item.index]!;
                const final = turn.assistants.at(-1);
                const duration = final ? completed.get(final.id) : undefined;
                const row = (message: MessageView, work?: WorkView) => <MessageRow key={message.id} message={message} messages={turn.messages} latest={message.id === state.messages.at(-1)?.id}
                  running={state.isRunning && item.index === turns.length - 1} locked={locked} command={command} work={work} />;
                return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="conversation-turn absolute top-0 left-0 flex w-full flex-col gap-3" style={{ transform: `translate3d(0, ${item.start}px, 0)` }}>
                  {turn.messages.filter((message) => message.role !== "assistant").map((message) => row(message))}
                  {duration === undefined || !final ? turn.assistants.map((message) => row(message)) : <>
                    <details className="work-summary thinking-item px-2" data-testid="work-summary" onToggle={(event) => {
                      const element = event.currentTarget.closest<HTMLElement>(".conversation-turn"); if (element) virtualizer.measureElement(element);
                    }}>
                      <summary><span>{workLabel(duration)}</span></summary>
                      <div className="work-summary-content">{turn.assistants.map((message) => row(message, { mode: "process", finalMessageId: final.id }))}</div>
                    </details>
                    {row(final, { mode: "final", finalMessageId: final.id })}
                  </>}
                </div>;
              })}
            </div>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {turns.length > 0 && <MessageScrollerButton aria-label="滚动到底部" title="滚动到底部"
          onClick={() => { followingEnd.current = true; }} />}
      </MessageScroller>
    </MessageScrollerProvider>
    <div className="composer-dock shrink-0 px-3 pt-2 pb-3">
      <LocalComposer config={config} logger={logger} conversationId={conversationId} blocked={contextBlocked} draft={draft} onDraftChange={onDraftChange} />
    </div>
  </div>;
}
export { CONTINUE_INTERRUPTED_TEXT } from "./message-row";
export default Thread;
