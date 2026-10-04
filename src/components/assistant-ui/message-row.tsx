import { useAui } from "@assistant-ui/react";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/ui/error-notice";
import { MarkdownText } from "./markdown-text";
import { ActivityPhaseContext, activityPhaseAt, processGroupSummary, turnActivityBoundary, turnActivityPhase } from "./process-group";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";

import { useRuntimeView, type MessageView } from "@/sidepanel/runtime-view";
export type { MessageView } from "@/sidepanel/runtime-view";
export type WorkView = { mode: "process" | "final"; finalMessageId: string };
export const CONTINUE_INTERRUPTED_TEXT = "继续上一次被中断的工作。不要重复已经完成的操作；先根据上面的工具结果确认当前状态。";
type RowProps = { message: MessageView; messages: readonly MessageView[]; running: boolean; locked: boolean;
  command: (action: () => void) => void; latest: boolean; work?: WorkView };
export const MessageRow = memo(function MessageRow({ message, messages, running, locked, command, latest, work }: RowProps) {
  const aui = useAui();
  const runtime = useRuntimeView();
  const client = () => runtime.thread.getMessageById(message.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const bubble = useRef<HTMLDivElement>(null);
  const [editSize, setEditSize] = useState({ width: 0, height: 0 });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<unknown>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(client().unstable_getCopyText()); setCopied(true); setCopyError(undefined);
      clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) { setCopyError(error); }
  };
  const user = message.role === "user";
  const parts = message.parts;
  const boundary = turnActivityBoundary(messages, message.id);
  const phase = turnActivityPhase(messages, message.id, running);
  let answerStart = parts.length;
  if (message.id === work?.finalMessageId) while (answerStart > 0 && parts[answerStart - 1]?.type === "text") answerStart--;
  const shown = parts.map((part, index) => ({ part, index })).filter(({ index }) => {
    if (!work) return true;
    return work.mode === "final" ? index >= answerStart : message.id !== work.finalMessageId || index < answerStart;
  });
  const renderParts = () => {
    const output = [];
    for (let offset = 0; offset < shown.length;) {
      const entry = shown[offset]!;
      if (entry.part.type === "text") {
        output.push(user ? <p key={entry.index} className="whitespace-pre-wrap wrap-break-word">{entry.part.text}</p> : <MarkdownText key={entry.index} text={entry.part.text} running={entry.part.status.type === "running"} />); offset++; continue;
      }
      if (entry.part.type !== "reasoning" && entry.part.type !== "tool-call") { offset++; continue; }
      const indices: number[] = [];
      while (offset < shown.length && ["reasoning", "tool-call"].includes(shown[offset]!.part.type)) indices.push(shown[offset++]!.index);
      const groupPhase = activityPhaseAt(boundary, indices.at(-1) ?? -1, phase);
      const summary = processGroupSummary(parts, indices, message.metadata.custom?.interrupted === true
        || message.status?.type === "incomplete" || message.status?.type === "requires-action" && !running, groupPhase);
      output.push(<details key={entry.index} className="process-trace" data-testid="process-trace" data-status={summary.status}>
        <summary><span key={summary.label} className={summary.status === "running" ? "shimmer text-foreground/65" : undefined}>{summary.label}</span></summary>
        <div className="process-trace-content">{indices.map((index) => {
          const part = parts[index]!;
          return <ActivityPhaseContext.Provider key={index} value={activityPhaseAt(boundary, index, phase, part.status.type)}>
            {part.type === "reasoning" ? <Reasoning {...part} /> : part.type === "tool-call" ? <ToolFallback {...part} /> : null}
          </ActivityPhaseContext.Provider>;
        })}</div>
      </details>);
    }
    return output;
  };
  const actions = useMemo(() => work?.mode !== "process" && <MessageFooter className={`gap-1 px-0 ${user ? "justify-end" : "justify-start"}`}>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? "已复制" : "复制消息"} title="复制消息" onClick={() => void copy()}><CopyIcon aria-hidden="true" /></Button>
    {user && !editing && <Button type="button" variant="ghost" size="icon-xs" disabled={locked} data-testid="edit-message-button" aria-label="编辑消息" title="编辑消息"
      onClick={() => command(() => { const rect = bubble.current!.getBoundingClientRect(); setEditSize({ width: rect.width, height: rect.height }); setDraft(client().unstable_getCopyText()); setEditing(true); })}><PencilIcon aria-hidden="true" /></Button>}
    <Button type="button" variant="ghost" size="icon-xs" disabled={locked || editing} data-testid={user ? "retry-user-message-button" : "replay-message-button"}
      aria-label={user ? "重试消息" : "重新生成回复"} title={user ? "重试消息" : "重新生成回复"} onClick={() => command(() => {
        if (user) aui.thread.startRun({ parentId: message.id }); else client().reload();
      })}><RotateCcwIcon aria-hidden="true" /></Button>
    {message.branchCount > 1 && <div className="flex items-center gap-0.5 tabular-nums" aria-label="消息分支">
      <Button type="button" variant="ghost" size="icon-xs" disabled={locked || message.branchNumber <= 1} aria-label="上一个分支" title="上一个分支" onClick={() => command(() => client().switchToBranch({ position: "previous" }))}><ChevronLeftIcon aria-hidden="true" /></Button>
      <span className="min-w-8 text-center">{message.branchNumber} / {message.branchCount}</span>
      <Button type="button" variant="ghost" size="icon-xs" disabled={locked || message.branchNumber >= message.branchCount} aria-label="下一个分支" title="下一个分支" onClick={() => command(() => client().switchToBranch({ position: "next" }))}><ChevronRightIcon aria-hidden="true" /></Button>
    </div>}
  </MessageFooter>, [aui, runtime, user, message.id, message.branchCount, message.branchNumber, copied, editing, locked, command, work?.mode]);
  if (work && shown.length === 0) return null;
  return <Message data-role={message.role} align={user ? "end" : "start"} aria-live={latest && !user ? "polite" : undefined} className={user ? "user-message" : "assistant-message px-2"}>
    <MessageContent className={user ? "items-end" : "assistant-message-content"}>
      {user ? <form className="flex w-full min-w-0 flex-col items-end gap-1" onSubmit={(event) => event.preventDefault()}>
        <Bubble variant="muted" align="end" className="max-w-[94%]" style={editing ? { width: editSize.width } : undefined}><BubbleContent ref={bubble} data-testid="user-message-bubble" className={`border-border/70 ${editing ? "w-full" : ""}`}>
          {editing ? <Textarea autoFocus data-testid="edit-message-input" aria-label="编辑消息" value={draft} disabled={locked}
            style={{ height: Math.min(128, Math.max(22, editSize.height - 16)) }}
            onChange={(event) => { setDraft(event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(128, event.currentTarget.scrollHeight)}px`; }}
            className="max-h-32 min-h-0 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent" /> : renderParts()}
        </BubbleContent></Bubble>
        {editing && <div className="flex justify-end gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
          <Button type="button" size="sm" disabled={locked || !draft.trim()} onClick={() => command(() => {
            const composer = client().composer; composer.beginEdit(); composer.setText(draft); composer.send(); setEditing(false);
          })}>保存并重新生成</Button>
        </div>}
      </form> : renderParts()}
      {!user && message.metadata.custom?.interrupted === true && work?.mode !== "final" && <div className="interrupted-message" data-testid="interrupted-message">
        <span>回复已中断</span>{latest && <Button type="button" size="sm" variant="outline" disabled={locked} data-testid="continue-interrupted" onClick={() => command(() => aui.thread.append(CONTINUE_INTERRUPTED_TEXT))}>继续</Button>}
      </div>}
      {message.status?.type === "incomplete" && message.status.reason === "error" && work?.mode !== "process" && <ErrorNotice summary="模型请求失败。" error={message.status.error} />}
      {copyError !== undefined && <ErrorNotice summary="复制失败。" error={copyError} />}
      {actions}
    </MessageContent>
  </Message>;
}, (before, after) => before.message === after.message
  // A growing reply changes the turn array, but settled tool/user rows need
  // another render only when their derived activity state changes.
  && (before.messages === after.messages
    || turnActivityBoundary(before.messages, before.message.id) === turnActivityBoundary(after.messages, after.message.id)
      && turnActivityPhase(before.messages, before.message.id, before.running) === turnActivityPhase(after.messages, after.message.id, after.running))
  && before.running === after.running && before.locked === after.locked && before.command === after.command
  && before.latest === after.latest && before.work?.mode === after.work?.mode && before.work?.finalMessageId === after.work?.finalMessageId);
