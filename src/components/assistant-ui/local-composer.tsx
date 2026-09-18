"use client";

import { ComposerPrimitive, useAui, useAuiState, type AssistantState } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reasoningSettingsFor, type ReasoningEffort } from "@/agent/reasoning";
import type { ModelConfig } from "@/types";

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 128;
const composerText = (state: AssistantState) => state.composer.text;
const threadRunning = (state: AssistantState) => state.thread.isRunning;
const composerDisabled = (state: AssistantState) => state.thread.isDisabled || Boolean(state.composer.dictation?.inputDisabled);
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};

export function LocalComposer({ config, blocked, draft, onDraftChange }: { config: ModelConfig; blocked?: boolean; draft?: string; onDraftChange: (value: string) => void }) {
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
