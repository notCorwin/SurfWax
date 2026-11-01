"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import { useThreadState } from "@/sidepanel/runtime-view";
import { useRunState } from "@/sidepanel/useRunState";
import { createTurnProjection } from "@/sidepanel/turn-projection";
import { Welcome } from "./welcome";
import { ErrorNotice } from "../ui/error-notice";
import { LocalComposer } from "./local-composer";
import { MessageRow } from "./message-row";
import { projectToolTimeline } from "./tool-timeline";
import { WaitingStatus } from "./waiting-status";
import type { ModelConfig } from "@/types";
import type { EventLogger } from "@/logging";

export function Thread({ config, logger, conversationId, contextBlocked, draft, onDraftChange, goalMode, onGoalModeChange }: {
  config: ModelConfig; logger: EventLogger; conversationId: string; contextBlocked?: boolean; draft?: string; onDraftChange: (value: string) => void;
  goalMode: boolean; onGoalModeChange: (value: boolean) => void;
}) {
  const state = useThreadState();
  const { locked } = useRunState();
  const projectTurns = useMemo(createTurnProjection, []);
  const turns = useMemo(() => projectTurns(state.messages), [projectTurns, state.messages]);
  const [warning, setWarning] = useState("");
  const command = useCallback((action: () => void) => {
    if (locked) { setWarning("当前会话尚未结束，请等待完成或先停止运行。"); return; }
    void Promise.resolve().then(action).catch((error) => setWarning(error instanceof Error ? error.message : String(error)));
  }, [locked]);
  useEffect(() => { if (!locked) setWarning(""); }, [locked]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: turns.length, estimateSize: () => 200, getItemKey: projectTurns.getItemKey(),
    getScrollElement: () => scroller.current, initialRect: { height: 800, width: 430 }, overscan: 2,
    useFlushSync: false, directDomUpdates: true, useAnimationFrameWithResizeObserver: true });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  return <div data-testid="thread-root" className="relative flex h-full min-h-0 flex-col">
    {state.error !== undefined && <ErrorNotice summary="会话读取失败，请重试。" error={state.error} />}
    {warning && <p role="status" className="conversation-notice">{warning}</p>}
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport ref={scroller} data-testid="thread-viewport" className="overflow-x-hidden">
          <MessageScrollerContent className="mx-auto block w-full max-w-(--thread-max-width) px-4 pt-5 pb-8">
            {turns.length === 0 && !state.isLoading && <Welcome disabled={locked} />}
            {state.isLoading && <p role="status" className="conversation-notice py-8">正在读取对话…</p>}
            <div ref={virtualizer.containerRef} className="relative w-full" style={{ height: totalSize }}>
              {items.map((item) => {
                const turn = turns[item.index]!;
                const liveTurn = state.isRunning && item.index === turns.length - 1;
                const timeline = projectToolTimeline(turn.messages, liveTurn);
                return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="conversation-turn absolute top-0 left-0 flex w-full flex-col" style={{ transform: `translate3d(0, ${item.start}px, 0)` }}>
                  {turn.messages.map((message) => <MessageRow key={message.id} message={message} messages={turn.messages} latest={message.id === state.messages.at(-1)?.id}
                    running={liveTurn} locked={locked} command={command} timeline={timeline} />)}
                  {liveTurn && <WaitingStatus logger={logger} conversationId={conversationId} running={state.isRunning} stopping={state.isStopping}
                    stoppingAt={state.stoppingAt} toolsRunning={turn.messages.some((message) => message.parts.some((part) => part.type === "tool-call" && part.status.type === "running"))} />}
                </div>;
              })}
            </div>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {turns.length > 0 && <MessageScrollerButton aria-label="滚动到底部" title="滚动到底部" />}
      </MessageScroller>
    </MessageScrollerProvider>
    <div className="composer-dock shrink-0 px-3 pt-2 pb-3">
      <LocalComposer config={config} logger={logger} conversationId={conversationId} blocked={contextBlocked} draft={draft} onDraftChange={onDraftChange} goalMode={goalMode} onGoalModeChange={onGoalModeChange} />
    </div>
  </div>;
}
export { CONTINUE_INTERRUPTED_TEXT } from "./message-row";
export default Thread;
