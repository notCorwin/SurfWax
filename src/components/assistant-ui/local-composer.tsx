"use client";

import { ComposerPrimitive, useAui, useAuiState, type AssistantState } from "@assistant-ui/react";
import { cn } from "cn";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modelMessages } from "@/agent/context-choice";
import { contextPressure } from "@/agent/compaction";
import { contextUsedPercent, inputBudget, resolveModelLimit, type ModelLimit } from "@/agent/model-limits";
import { reasoningSettingsFor, type ReasoningEffort } from "@/agent/reasoning";
import type { ConversationMessage, EventLogger } from "@/logging";
import type { ModelConfig } from "@/types";

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 128;
const composerText = (state: AssistantState) => state.composer.text;
const threadRunning = (state: AssistantState) => state.thread.isRunning;
const composerDisabled = (state: AssistantState) => state.thread.isDisabled || Boolean(state.composer.dictation?.inputDisabled);
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};
const CONTEXT_USAGE_EVENTS = new Set([
  "conversation.message",
  "conversation.branch.selected",
  "context.compacted",
  "context.checkpoint.applied",
  "context.selection.applied",
  "context.estimate.calibrated",
]);
type ContextUsage = { state: "loading" | "unavailable" } | {
  state: "ready";
  estimated: number;
  budget: number;
  limit: ModelLimit;
  usedPercent: number;
};

function ContextIndicator({ config, logger, conversationId }: { config: ModelConfig; logger: EventLogger; conversationId: string }) {
  const aui = useAui();
  const [usage, setUsage] = useState<ContextUsage>({ state: "loading" });

  useEffect(() => {
    let active = true;
    let version = 0;
    let frame: number | undefined;
    let idle: number | undefined;
    let calculating = false;
    let pending = false;
    const initialThread = aui.thread.getState();
    let messages = initialThread.messages;
    let loading = initialThread.isLoading;
    const controller = new AbortController();
    const limit = resolveModelLimit(config, { signal: controller.signal });
    let events: ReturnType<EventLogger["contextEvents"]> | undefined;
    setUsage({ state: "loading" });

    const refresh = async () => {
      version += 1;
      pending = true;
      if (calculating) return;
      calculating = true;
      try {
        while (active && pending) {
          pending = false;
          const current = version;
          const currentMessages = messages;
          try {
            const [resolvedLimit, currentEvents] = await Promise.all([limit, events ??= logger.contextEvents(conversationId)]);
            if (!resolvedLimit) {
              if (active && current === version) setUsage({ state: "unavailable" });
              continue;
            }
            const ui = currentMessages.map(({ id, role, parts, metadata }) => ({
              id,
              role,
              parts: [...parts],
              metadata,
            })) as ConversationMessage[];
            const branchIds = ui.map(({ id }) => id);
            const raw = await modelMessages(ui);
            const pressure = await contextPressure({
              raw,
              branchIds,
              events: currentEvents,
              model: config,
              limit: resolvedLimit,
              signal: controller.signal,
            });
            if (!active || current !== version) continue;
            setUsage(pressure ? {
              state: "ready",
              estimated: pressure.estimated,
              budget: inputBudget(pressure.limit),
              limit: pressure.limit,
              usedPercent: contextUsedPercent(pressure.estimated, pressure.limit),
            } : { state: "unavailable" });
          } catch {
            if (active && current === version) setUsage({ state: "unavailable" });
          }
        }
      } finally {
        calculating = false;
      }
    };

    const schedule = (immediate = aui.thread.getState().isRunning) => {
      const run = () => void refresh();
      if (immediate) {
        if (idle !== undefined) cancelIdleCallback(idle);
        idle = undefined;
        if (frame === undefined) frame = requestAnimationFrame(() => {
          frame = undefined;
          run();
        });
        return;
      }
      if (idle !== undefined) cancelIdleCallback(idle);
      idle = requestIdleCallback(() => {
        idle = undefined;
        run();
      }, { timeout: 1_000 });
    };
    const unsubscribeRuntime = aui.subscribe(() => {
      const thread = aui.thread.getState();
      const changed = thread.messages !== messages;
      const loaded = loading && !thread.isLoading;
      messages = thread.messages;
      loading = thread.isLoading;
      if (loading || !changed && !loaded) return;
      schedule(thread.isRunning);
    });
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId !== conversationId || !CONTEXT_USAGE_EVENTS.has(event.type)) return;
      events = logger.contextEvents(conversationId);
      schedule();
    });
    if (!loading) schedule();
    return () => {
      active = false;
      controller.abort();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (idle !== undefined) cancelIdleCallback(idle);
      unsubscribeRuntime();
      unsubscribe();
    };
  }, [aui, config, conversationId, logger]);

  const label = usage.state === "ready"
    ? `上下文已使用约 ${usage.usedPercent}% · ${usage.estimated.toLocaleString("zh-CN")} / ${usage.budget.toLocaleString("zh-CN")} tokens · ${usage.limit.source === "manual" ? "手动设置" : "Models.dev"}`
    : usage.state === "loading" ? "正在估算上下文…" : "无法取得上下文窗口；可在设置中手动指定";
  const usedPercent = usage.state === "ready" ? usage.usedPercent : 0;
  const source = usage.state === "ready" ? usage.limit.source === "manual" ? "手动设置" : "Models.dev" : undefined;
  const remaining = usage.state === "ready" ? Math.max(0, usage.budget - usage.estimated) : 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="context-indicator"
          data-state={usage.state}
          data-used-percent={usage.state === "ready" ? usage.usedPercent : undefined}
          tabIndex={0}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usage.state === "ready" ? usage.usedPercent : undefined}
          aria-label={label}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring",
            usage.state === "ready" && usage.usedPercent < 80 ? "text-foreground" : "text-muted-foreground",
            usage.state === "ready" && usage.usedPercent >= 80 && "text-destructive",
          )}
        >
          <svg viewBox="0 0 20 20" className="size-3.5 -rotate-90" aria-hidden="true">
            <circle cx="10" cy="10" r="7" pathLength="100" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
            {usage.state === "ready" && <circle cx="10" cy="10" r="7" pathLength="100" fill="none" stroke="currentColor" strokeWidth="3"
              strokeLinecap="round" strokeDasharray="100" strokeDashoffset={100 - usedPercent} />}
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} collisionPadding={8} className="w-64 max-w-[calc(100vw-1rem)]">
        <div data-testid="context-detail" className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground">上下文用量</p>
              <p className={cn("text-xl font-semibold tracking-tight", (usage.state === "unavailable" || usage.state === "ready" && usage.usedPercent >= 80) && "text-destructive")}>
                {usage.state === "ready" ? `约 ${usage.usedPercent}%` : usage.state === "loading" ? "估算中" : "不可用"}
              </p>
            </div>
            {source && <Badge variant={usage.state === "ready" && usage.usedPercent >= 80 ? "destructive" : "secondary"}>{source}</Badge>}
          </div>
          {usage.state === "ready" ? <>
            <Progress data-testid="context-detail-progress" aria-label="上下文用量详情" value={usage.usedPercent} className="h-1.5" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">已用</dt>
              <dd data-testid="context-used" className="text-right font-medium tabular-nums">{usage.estimated.toLocaleString("zh-CN")} tokens</dd>
              <dt className="text-muted-foreground">剩余</dt>
              <dd data-testid="context-remaining" className="text-right font-medium tabular-nums">{remaining.toLocaleString("zh-CN")} tokens</dd>
              <dt className="text-muted-foreground">输入预算</dt>
              <dd className="text-right font-medium tabular-nums">{usage.budget.toLocaleString("zh-CN")} tokens</dd>
            </dl>
          </> : <p className="leading-relaxed text-muted-foreground">
            {usage.state === "loading" ? "正在根据当前对话估算…" : "无法取得上下文窗口，可在设置中手动指定。"}
          </p>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function LocalComposer({ config, logger, conversationId, blocked, draft, onDraftChange }: {
  config: ModelConfig;
  logger: EventLogger;
  conversationId: string;
  blocked?: boolean;
  draft?: string;
  onDraftChange: (value: string) => void;
}) {
  const settings = reasoningSettingsFor(config);
  const reasoning = useSyncExternalStore(settings.subscribe, settings.snapshot);
  const model = config.model;
  const aui = useAui();
  const externalText = useAuiState(composerText);
  const isRunning = useAuiState(threadRunning);
  const isDisabled = useAuiState(composerDisabled);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const resizeFrame = useRef<number | null>(null);
  const [hasText, setHasText] = useState(() => Boolean((draft ?? externalText).trim()));
  const previousExternalText = useRef(externalText);

  const resize = useCallback(() => {
    if (resizeFrame.current !== null) return;
    resizeFrame.current = requestAnimationFrame(() => {
      resizeFrame.current = null;
      const input = inputRef.current;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(Math.max(input.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
      input.style.overflowY = input.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    });
  }, []);

  useEffect(() => {
    if (previousExternalText.current === externalText) return;
    previousExternalText.current = externalText;
    const input = inputRef.current;
    if (!input || input.value === externalText) return;
    input.value = externalText;
    onDraftChange(externalText);
    setHasText(Boolean(externalText.trim()));
    resize();
  }, [externalText, onDraftChange, resize]);

  useEffect(() => () => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
  }, []);

  const submit = useCallback(() => {
    const input = inputRef.current;
    const value = input?.value ?? "";
    if (!input || !value.trim() || isDisabled || isRunning || blocked) return;
    aui.composer.setText(value);
    aui.composer.send();
    input.value = "";
    onDraftChange("");
    setHasText(false);
    resize();
  }, [aui, blocked, isDisabled, isRunning, onDraftChange, resize]);

  const keyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || composing.current || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      const start = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
      const end = event.currentTarget.selectionEnd ?? start;
      event.currentTarget.setRangeText("\n", start, end, "end");
      onDraftChange(event.currentTarget.value);
      setHasText(Boolean(event.currentTarget.value.trim()));
      resize();
      return;
    }
    submit();
  }, [onDraftChange, resize, submit]);

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    }}>
      <div className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/30 p-2 shadow-sm focus-within:border-ring">
        <textarea
          ref={inputRef}
          data-testid="composer-input"
          defaultValue={draft ?? externalText}
          placeholder="描述要执行的浏览器任务…"
          className="min-h-12 max-h-32 w-full resize-none overflow-y-hidden bg-transparent px-2 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          rows={2}
          disabled={isDisabled || blocked}
          autoFocus
          enterKeyHint="send"
          aria-label="消息输入"
          onChange={(event) => {
            onDraftChange(event.target.value);
            setHasText(Boolean(event.target.value.trim()));
            resize();
          }}
          onKeyDown={keyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <span data-testid="composer-model" className="min-w-0 truncate px-2 text-xs text-muted-foreground" title={model}>
              {(model.split("/").at(-1) ?? model).split(/[-_\s]+/).filter(Boolean).map((part) =>
                /^(gpt|glm|api)$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
              ).join(" ")}
            </span>
            <Select value={reasoning.selected ?? undefined} disabled={!reasoning.ready || isRunning || !reasoning.choices.length}
              onValueChange={(value) => settings.select(value as ReasoningEffort)}>
              <SelectTrigger data-testid="reasoning-effort" size="sm" aria-label="思考强度"
                className="h-7 max-w-24 gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectGroup>
                  {reasoning.choices.map((effort) => <SelectItem key={effort} value={effort}>{EFFORT_LABELS[effort]}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <ContextIndicator config={config} logger={logger} conversationId={conversationId} />
          </div>
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild>
              <Button type="button" size="icon-sm" className="rounded-full" aria-label="停止生成" title="停止生成">
                <SquareIcon aria-hidden="true" />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <Button type="button" size="icon-sm" className="rounded-full" disabled={!hasText || isDisabled || blocked} aria-label="发送消息" title="发送消息" onClick={submit}>
              <ArrowUpIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
