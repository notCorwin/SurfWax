"use client";

import {
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import {
  type ComponentProps,
  type FC,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { LocalComposer } from "./local-composer";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";

const ESTIMATED_TURN_HEIGHT = 200;
const AT_BOTTOM_THRESHOLD = 4;

type MessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>["components"];
type MessageRow = { id: string; role: "user" | "assistant" | "system" };
type Turn = { id: string; messageIds: string[] };

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
    if (role === "user" || !last) turns.push({ id, messageIds: [id] });
    else last.messageIds.push(id);
  }
  return turns;
}

export const Thread: FC = () => {
  const messages = useMessageRows();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const turns = useMemo(() => buildTurns(messages), [messages]);
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
            {items.map((item) => (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="conversation-turn flex flex-col">
                {turns[item.index]!.messageIds.map((messageId) => (
                  <ThreadPrimitive.Unstable_MessageById
                    key={messageId}
                    messageId={messageId}
                    components={MESSAGE_COMPONENTS}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="relative shrink-0 bg-background px-1 pt-2 pb-2">
        {!isAtBottom && (
          <Button type="button" variant="outline" size="icon-sm" className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 rounded-full" aria-label="滚动到底部" title="滚动到底部" onClick={jumpToBottom}>
            <ArrowDownIcon data-icon="icon" aria-hidden="true" />
          </Button>
        )}
        <LocalComposer />
      </div>
    </ThreadPrimitive.Root>
  );
};

export const CONTINUE_INTERRUPTED_TEXT = "继续上一次被中断的工作。不要重复已经完成的操作；先根据上面的工具结果确认当前状态。";

const AssistantMessage: FC = () => {
  const aui = useAui();
  const interrupted = useAuiState((state) => state.message.metadata.custom?.interrupted === true);
  const latest = useAuiState((state) => state.thread.messages.at(-1)?.id === state.message.id);
  return (
    <MessagePrimitive.Root data-role="assistant" aria-live={latest ? "polite" : undefined} className="assistant-message min-w-0 px-2 text-sm">
      <div className="assistant-message-content flex flex-col wrap-break-word">
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") return <MarkdownText />;
            if (part.type === "reasoning") return <Reasoning {...part} />;
            if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
            return null;
          }}
        </MessagePrimitive.Parts>
        {interrupted && (
          <div className="interrupted-message" data-testid="interrupted-message">
            <span>回复已中断</span>
            {latest && <Button type="button" variant="outline" size="sm" data-testid="continue-interrupted" onClick={() => aui.thread.append({
              role: "user",
              content: [{ type: "text", text: CONTINUE_INTERRUPTED_TEXT }],
            })}>继续</Button>}
          </div>
        )}
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
};

const UserMessage: FC = () => (
  <MessagePrimitive.Root data-role="user" className="ml-auto max-w-[94%] text-sm leading-relaxed">
    <div className="rounded-xl border border-primary/40 bg-primary/15 px-3 py-2 wrap-break-word">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const MESSAGE_COMPONENTS: MessageComponents = { UserMessage, AssistantMessage };

export default Thread;
