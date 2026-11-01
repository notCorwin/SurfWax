"use client";
import { usePanelRuntime, usePanelState, type PanelState } from "@/sidepanel/runtime-view";

import { cn } from "cn";
import { ArrowUpIcon, ForwardIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { InputGroup, InputGroupTextarea, InputGroupAddon } from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { registerBackgroundRequest, waitForConversationRun } from "@/agent/coordinator";
import { modelMessages } from "@/agent/context-choice";
import { contextPressure } from "@/agent/compaction";
import { summarizeTokenUsage, type TokenUsageField, type TokenUsageSummary } from "@/agent/token-usage";
import { canAutoDispatchFollowup, FOLLOWUP_EVENT_TYPES, rebuildFollowups, type FollowupMessage } from "@/agent/followups";
import { contextUsedPercent, inputBudget, resolveModelLimit, type ModelLimit } from "@/agent/model-limits";
import { reasoningSettingsFor, type ReasoningEffort } from "@/agent/reasoning";
import { type ConversationMessage, type EventLogger } from "@/logging";
import type { ModelConfig } from "@/types";
import { useRuntimeView } from "@/sidepanel/runtime-view";
import { useRunState } from "@/sidepanel/useRunState";

const composerText = (state: PanelState) => state.composer.text;
const threadRunning = (state: PanelState) => state.thread.isRunning;
const composerDisabled = (state: PanelState) => state.thread.isDisabled || state.thread.isLoading;
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};
const CONTEXT_USAGE_EVENTS = new Set([
  "conversation.message",
  "conversation.branch.selected",
  "context.compacted",
  "context.checkpoint.applied",
  "context.estimate.calibrated",
  "context.prompt.updated",
]);
type ContextUsage = { state: "loading" | "unavailable" } | {
  state: "ready";
  estimated: number;
  budget: number;
  limit: ModelLimit;
  usedPercent: number;
};
const limitSourceLabel = (limit: ModelLimit) => limit.source === "manual" ? "手动设置" : limit.source === "models.dev" ? "Models.dev" : "默认值";
const usageLabel = (usage: ContextUsage) => usage.state === "ready"
  ? `估算输入占用约 ${usage.usedPercent}% · ${usage.estimated.toLocaleString("zh-CN")} / ${usage.budget.toLocaleString("zh-CN")} tokens · 上限来源：${limitSourceLabel(usage.limit)}`
  : usage.state === "loading" ? "正在估算上下文…" : "无法取得上下文窗口；可在设置中手动指定";

const formatTokenUsage = (field: TokenUsageField) => field.reported === 0
  ? field.missing ? "未提供" : "暂无调用"
  : `${field.missing ? "至少 " : ""}${field.total.toLocaleString("zh-CN")} tokens`;

const FOLLOWUP_LIFECYCLE_EVENTS = new Set<string>([
  ...FOLLOWUP_EVENT_TYPES,
  "conversation.submitted",
  "conversation.finished",
  "conversation.failed",
  "conversation.aborted",
]);

function useFollowups(logger: EventLogger, conversationId: string) {
  const [state, setState] = useState<{ ready: boolean; messages: FollowupMessage[]; autoDispatch: boolean }>({
    ready: false,
    messages: [],
    autoDispatch: false,
  });

  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = async () => {
      const current = ++version;
      const events = await logger.followupEvents(conversationId);
      if (!active || current !== version) return;
      setState({ ready: true, messages: rebuildFollowups(events), autoDispatch: canAutoDispatchFollowup(events) });
    };
    const unsubscribe = logger.subscribe((event) => {
      if (event.conversationId === conversationId && FOLLOWUP_LIFECYCLE_EVENTS.has(event.type)) void refresh();
    });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [conversationId, logger]);

  return state;
}

const ContextIndicator = memo(function ContextIndicator({ config, logger, conversationId }: { config: ModelConfig; logger: EventLogger; conversationId: string }) {
  const runtime = useRuntimeView();
  const [usage, setUsage] = useState<ContextUsage>({ state: "loading" });
  const latestUsage = useRef(usage);
  const indicator = useRef<HTMLSpanElement>(null);
  const detailsOpen = useRef(false);
  const publishUsage = useCallback((next: ContextUsage) => {
    latestUsage.current = next;
    // Keep the exact accessible estimate fresh without rebuilding a closed
    // Radix tooltip when its visible percentage has not changed.
    indicator.current?.setAttribute("aria-label", usageLabel(next));
    setUsage((previous) => !detailsOpen.current && previous.state === "ready" && next.state === "ready"
      && previous.usedPercent === next.usedPercent && previous.budget === next.budget && previous.limit === next.limit ? previous : next);
  }, []);
  const [tokens, setTokens] = useState<TokenUsageSummary>();

  useEffect(() => {
    let active = true;
    let version = 0;
    setTokens(undefined);
    const refresh = async () => {
      const current = ++version;
      const events = await logger.modelUsageEvents(conversationId);
      if (active && current === version) setTokens(summarizeTokenUsage(events));
    };
    const unsubscribe = logger.subscribe((event) => {
      if ((event.conversationId === conversationId && event.type === "model.step.finished") || event.type === "log.cleared") void refresh();
    });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [conversationId, logger]);

  useEffect(() => {
    let active = true;
    let version = 0;
    let frame: number | undefined;
    let calculating = false;
    let pending = false;
    const initialThread = runtime.getState();
    let messages = initialThread.messages;
    let loading = initialThread.isLoading;
    const controller = new AbortController();
    const unregisterRequest = registerBackgroundRequest(controller, conversationId);
    controller.signal.addEventListener("abort", unregisterRequest, { once: true });
    const limit = resolveModelLimit(config, { signal: controller.signal });
    let events: ReturnType<EventLogger["contextEvents"]> | undefined;
    let repository: ReturnType<EventLogger["repository"]> | undefined;
    publishUsage({ state: "loading" });

    const refresh = async () => {
      if (calculating) return;
      calculating = true;
      try {
        while (active && pending) {
          pending = false;
          const current = version;
          const currentMessages = messages;
          try {
            const [resolvedLimit, currentEvents, canonical] = await Promise.all([limit, events ??= logger.contextEvents(conversationId), repository ??= logger.repository(conversationId)]);
            if (!resolvedLimit) {
              if (active && current === version) publishUsage({ state: "unavailable" });
              continue;
            }
            const metadataById = new Map(canonical.messages.map((entry) => [entry.message.id, entry.message.metadata]));
            const ui = currentMessages.map(({ id, role, source, metadata }) => ({
              id,
              role,
              parts: [...source.parts],
              metadata: role === "user" ? metadataById.get(id) ?? metadata : metadata,
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
            const next: ContextUsage = pressure ? {
              state: "ready",
              estimated: pressure.estimated,
              budget: inputBudget(pressure.limit),
              limit: pressure.limit,
              usedPercent: contextUsedPercent(pressure.estimated, pressure.limit),
            } : { state: "unavailable" };
            publishUsage(next);
          } catch {
            if (active && current === version) publishUsage({ state: "unavailable" });
          }
        }
      } finally {
        calculating = false;
      }
    };

    const schedule = () => {
      // Invalidate any in-flight calculation as soon as the source changes,
      // including changes coalesced into the next animation frame.
      version += 1;
      const latest = runtime.getState();
      messages = latest.messages;
      loading = latest.isLoading;
      if (loading) { pending = false; return; }
      pending = true;
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        void refresh();
      });
    };
    const unsubscribeRuntime = runtime.thread.subscribe(schedule);
    const unsubscribe = logger.subscribe((event) => {
      if (event.type !== "log.cleared" && (event.conversationId !== conversationId || !CONTEXT_USAGE_EVENTS.has(event.type))) return;
      events = undefined;
      if (event.type === "conversation.message" || event.type === "log.cleared") repository = undefined;
      schedule();
    });
    if (!loading) schedule();
    return () => {
      active = false;
      controller.abort();
      unregisterRequest();
      if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribeRuntime();
      unsubscribe();
    };
  }, [runtime, config, conversationId, logger, publishUsage]);

  const label = usageLabel(latestUsage.current);
  const usedPercent = usage.state === "ready" ? usage.usedPercent : 0;
  const source = usage.state === "ready" ? limitSourceLabel(usage.limit) : undefined;

  return (
    <Tooltip onOpenChange={(open) => { detailsOpen.current = open; if (open) setUsage(latestUsage.current); }}>
      <TooltipTrigger asChild>
        <span
          ref={indicator}
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
            "flex size-7 shrink-0 items-center justify-center rounded-md",
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
              <p className="text-muted-foreground">估算输入占用</p>
              <p className={cn("text-xl font-semibold tracking-tight", (usage.state === "unavailable" || usage.state === "ready" && usage.usedPercent >= 80) && "text-destructive")}>
                {usage.state === "ready" ? `约 ${usage.usedPercent}%` : usage.state === "loading" ? "估算中" : "不可用"}
              </p>
            </div>
            {source && <Badge variant={usage.state === "ready" && usage.usedPercent >= 80 ? "destructive" : "secondary"}>上限：{source}</Badge>}
          </div>
          {usage.state === "ready" ? <>
            <Progress data-testid="context-detail-progress" aria-label="上下文用量详情" value={usage.usedPercent} className="h-1.5" />
            <p data-testid="context-estimate" className="tabular-nums">约 {usage.estimated.toLocaleString("zh-CN")} / {usage.budget.toLocaleString("zh-CN")} tokens</p>
            <p className="leading-relaxed text-muted-foreground">包含系统提示词、工具定义和当前对话；实际用量由模型返回。</p>
            <p className="text-muted-foreground">本会话模型步骤累计</p>
            <dl data-testid="context-token-usage" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">输入</dt>
              <dd data-testid="context-input" className="text-right font-medium tabular-nums">{tokens ? formatTokenUsage(tokens.input) : "读取中"}</dd>
              <dt className="text-muted-foreground">输出</dt>
              <dd data-testid="context-output" className="text-right font-medium tabular-nums">{tokens ? formatTokenUsage(tokens.output) : "读取中"}</dd>
              <dt className="text-muted-foreground">缓存命中</dt>
              <dd data-testid="context-cache-read" className="text-right font-medium tabular-nums">{tokens ? formatTokenUsage(tokens.cacheRead) : "读取中"}</dd>
            </dl>
          </> : <p className="leading-relaxed text-muted-foreground">
            {usage.state === "loading" ? "正在根据当前对话估算…" : "无法取得上下文窗口，可在设置中手动指定。"}
          </p>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

export const LocalComposer = memo(function LocalComposer({ config, logger, conversationId, blocked, draft, onDraftChange, goalMode, onGoalModeChange }: {
  config: ModelConfig;
  logger: EventLogger;
  conversationId: string;
  blocked?: boolean;
  draft?: string;
  onDraftChange: (value: string) => void;
  goalMode: boolean;
  onGoalModeChange: (value: boolean) => void;
}) {
  const settings = reasoningSettingsFor(config);
  const reasoning = useSyncExternalStore(settings.subscribe, settings.snapshot);
  const model = config.model;
  const runtimeCommands = usePanelRuntime();
  const externalText = usePanelState(composerText);
  const isRunning = usePanelState(threadRunning);
  const { locked } = useRunState();
  const isDisabled = usePanelState(composerDisabled);
  const followups = useFollowups(logger, conversationId);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const dispatching = useRef<string | undefined>(undefined);
  const [immediateId, setImmediateId] = useState<string>();
  const [resumeQueue, setResumeQueue] = useState(false);
  const [hasText, setHasText] = useState(() => Boolean((draft ?? externalText).trim()));
  const previousExternalText = useRef(externalText);

  useEffect(() => {
    if (previousExternalText.current === externalText) return;
    previousExternalText.current = externalText;
    const input = inputRef.current;
    if (!input || input.value === externalText) return;
    input.value = externalText;
    onDraftChange(externalText);
    setHasText(Boolean(externalText.trim()));
  }, [externalText, onDraftChange]);

  const clearInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    onDraftChange("");
    setHasText(false);
  }, [onDraftChange]);

  const dispatchFollowup = useCallback((message: FollowupMessage, mode: "followup" | "immediate") => {
    if (dispatching.current || blocked) return;
    dispatching.current = message.id;
    void waitForConversationRun(conversationId).then(() => runtimeCommands.thread.append({
      role: "user",
      content: [{ type: "text", text: message.text }],
      createdAt: new Date(),
      metadata: { custom: { followupId: message.id, followupMode: mode } },
    })).catch(() => { dispatching.current = undefined; });
  }, [runtimeCommands, blocked, conversationId]);

  useEffect(() => {
    if (!dispatching.current) return;
    if (!followups.messages.some(({ id }) => id === dispatching.current)) dispatching.current = undefined;
  }, [followups.messages]);

  useEffect(() => {
    if (isRunning || blocked || !immediateId) return;
    const message = followups.messages.find(({ id }) => id === immediateId);
    setImmediateId(undefined);
    if (message) dispatchFollowup(message, "immediate");
  }, [blocked, dispatchFollowup, followups.messages, immediateId, isRunning]);

  useEffect(() => {
    if (!followups.ready || isRunning || blocked || immediateId || dispatching.current || followups.messages.length === 0) return;
    if (!followups.autoDispatch && !resumeQueue) return;
    setResumeQueue(false);
    dispatchFollowup(followups.messages[0]!, "followup");
  }, [blocked, dispatchFollowup, followups, immediateId, isRunning, resumeQueue]);

  const submit = useCallback(() => {
    const input = inputRef.current;
    const value = input?.value ?? "";
    if (!input || !value.trim() || isDisabled || blocked) return;
    if (followups.ready && !isRunning && followups.messages.length === 0) {
      runtimeCommands.composer.setText(value);
      runtimeCommands.composer.send();
      clearInput();
      return;
    }
    const queued = {
      id: globalThis.crypto.randomUUID(),
      text: value,
      createdAt: new Date().toISOString(),
    };
    clearInput();
    void logger.append({
      type: "conversation.followup.queued",
      conversationId,
      content: queued,
    }).then(() => {
      if (!followups.ready || !isRunning) setResumeQueue(true);
    }).catch(() => undefined);
  }, [runtimeCommands, blocked, clearInput, conversationId, followups.messages.length, followups.ready, isDisabled, isRunning, logger]);

  const sendImmediately = useCallback((message: FollowupMessage) => {
    if (blocked || dispatching.current) return;
    if (isRunning) {
      setImmediateId(message.id);
      runtimeCommands.thread.cancelRun();
    } else {
      dispatchFollowup(message, "immediate");
    }
  }, [runtimeCommands, blocked, dispatchFollowup, isRunning]);

  const removeFollowup = useCallback((id: string) => {
    void logger.append({ type: "conversation.followup.removed", conversationId, content: { id } }).catch(() => undefined);
  }, [conversationId, logger]);

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
      return;
    }
    submit();
  }, [onDraftChange, submit]);

  return (
    <form className="relative flex w-full flex-col" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    }}>
      {followups.messages.length > 0 && <div className="mb-2 flex flex-col gap-1" role="list" aria-label="等待发送的消息" data-testid="followup-queue">
        {followups.messages.map((message, index) => <div key={message.id} role="listitem" data-testid="followup-item"
          className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-2 py-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate" title={message.text}>{message.text}</span>
          <Button type="button" variant="ghost" size="icon-xs" disabled={Boolean(immediateId) || Boolean(dispatching.current) || blocked}
            aria-label="立即发送" title="中断当前工作并立即发送" onClick={() => sendImmediately(message)}>
            <ForwardIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" disabled={immediateId === message.id || dispatching.current === message.id}
            aria-label="移除排队消息" title="移除" onClick={() => removeFollowup(message.id)}>
            <XIcon aria-hidden="true" />
          </Button>
        </div>)}
      </div>}
      <InputGroup className="composer-surface flex-col gap-1 rounded-2xl" aria-label="发送浏览器任务">
        <InputGroupTextarea
          ref={inputRef}
          data-testid="composer-input"
          defaultValue={draft ?? externalText}
          placeholder="描述要执行的浏览器任务…"
          className="min-h-20 max-h-40 w-full overflow-y-auto px-4 py-3"
          rows={2}
          disabled={isDisabled || blocked}
          autoFocus
          enterKeyHint="send"
          aria-label="消息输入"
          onChange={(event) => {
            onDraftChange(event.target.value);
            setHasText(Boolean(event.target.value.trim()));
          }}
          onKeyDown={keyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <InputGroupAddon align="block-end" className="min-w-0 justify-between gap-1 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span data-testid="composer-model" className="composer-model min-w-0 truncate px-2 text-xs text-muted-foreground" title={model}>
              {(model.split("/").at(-1) ?? model).split(/[-_\s]+/).filter(Boolean).map((part) =>
                /^(gpt|glm|api)$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
              ).join(" ")}
            </span>
            <Button type="button" variant="ghost" size="sm" role="switch" aria-label="目标模式" aria-checked={goalMode}
              data-testid="work-mode" disabled={locked || isRunning || blocked}
              title="目标模式要求模型调用完成工具才能结束工作" className="composer-select px-2"
              onClick={() => onGoalModeChange(!goalMode)}>
              {goalMode ? "目标模式" : "普通模式"}
            </Button>
            <Select value={reasoning.selected ?? undefined} disabled={!reasoning.ready || isRunning || !reasoning.choices.length}
              onValueChange={(value) => settings.select(value as ReasoningEffort)}>
              <SelectTrigger data-testid="reasoning-effort" size="sm" aria-label="思考强度"
                className="composer-select shrink-0 gap-1 px-2">
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
          <div className="flex shrink-0 items-center gap-1">
            {isRunning && <Button type="button" size="icon-sm" className="rounded-full" aria-label="停止生成" title="停止生成" onClick={() => runtimeCommands.thread.cancelRun()}><SquareIcon aria-hidden="true" /></Button>}
            {(!isRunning || hasText) && <Button type="button" size="icon-sm" className="rounded-full" disabled={!hasText || isDisabled || blocked}
              aria-label={isRunning || followups.messages.length > 0 ? "排队消息" : "发送消息"}
              title={isRunning || followups.messages.length > 0 ? "加入 Follow-up 队列" : "发送消息"} onClick={submit}><ArrowUpIcon aria-hidden="true" /></Button>}
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
});
