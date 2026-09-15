"use client";

import { ComposerPrimitive, useAui, useAuiState, type AssistantState } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 128;
const composerText = (state: AssistantState) => state.composer.text;
const threadRunning = (state: AssistantState) => state.thread.isRunning;
const composerDisabled = (state: AssistantState) => state.thread.isDisabled || Boolean(state.composer.dictation?.inputDisabled);

export function LocalComposer() {
  const aui = useAui();
  const externalText = useAuiState(composerText);
  const isRunning = useAuiState(threadRunning);
  const isDisabled = useAuiState(composerDisabled);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const resizeFrame = useRef<number | null>(null);
  const [hasText, setHasText] = useState(() => Boolean(externalText.trim()));

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
    const input = inputRef.current;
    if (!input || input.value === externalText) return;
    input.value = externalText;
    setHasText(Boolean(externalText.trim()));
    resize();
  }, [externalText, resize]);

  useEffect(() => () => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
  }, []);

  const submit = useCallback(() => {
    const input = inputRef.current;
    const value = input?.value ?? "";
    if (!input || !value.trim() || isDisabled || isRunning) return;
    aui.composer.setText(value);
    aui.composer.send();
    input.value = "";
    setHasText(false);
    resize();
  }, [aui, isDisabled, isRunning, resize]);

  const keyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || composing.current || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      const start = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
      const end = event.currentTarget.selectionEnd ?? start;
      event.currentTarget.setRangeText("\n", start, end, "end");
      setHasText(Boolean(event.currentTarget.value.trim()));
      resize();
      return;
    }
    submit();
  }, [resize, submit]);

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    }}>
      <div className="flex w-full flex-col gap-2 rounded-xl border border-border/70 bg-muted/30 p-2 shadow-sm focus-within:border-ring">
        <textarea
          ref={inputRef}
          data-testid="composer-input"
          defaultValue={externalText}
          placeholder="描述要执行的浏览器任务…"
          className="min-h-12 max-h-32 w-full resize-none overflow-y-hidden bg-transparent px-2 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          rows={2}
          disabled={isDisabled}
          autoFocus
          enterKeyHint="send"
          aria-label="消息输入"
          onChange={(event) => {
            setHasText(Boolean(event.target.value.trim()));
            resize();
          }}
          onKeyDown={keyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <div className="flex justify-end">
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild>
              <Button type="button" size="icon-sm" className="rounded-full" aria-label="停止生成" title="停止生成">
                <SquareIcon aria-hidden="true" />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <Button type="button" size="icon-sm" className="rounded-full" disabled={!hasText || isDisabled} aria-label="发送消息" title="发送消息" onClick={submit}>
              <ArrowUpIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
