import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { ErrorNotice } from "@/components/ui/error-notice";
import { useRuntimeView, type MessageView } from "@/sidepanel/runtime-view";

export function AssistantTurnActions({ assistants, running, locked, command }: {
  assistants: readonly MessageView[];
  running: boolean;
  locked: boolean;
  command: (action: () => void | Promise<unknown>) => void;
}) {
  const runtime = useRuntimeView();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<unknown>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  if (!assistants.length || running || locked) return null;

  const text = assistants.flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(undefined);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) { setCopyError(error); }
  };
  const userBranches = [...new Map(assistants.flatMap((message) => message.userBranch ? [[message.userBranch.id, message.userBranch] as const] : [])).values()];
  return <>
    {copyError !== undefined && <ErrorNotice summary="复制失败。" error={copyError} />}
    <MessageFooter className="flex-wrap gap-1 px-0 justify-start">
      <Button type="button" variant="ghost" size="icon-xs" disabled={!text} aria-label={copied ? "已复制" : "复制消息"} title="复制消息" onClick={() => void copy()}><CopyIcon aria-hidden="true" /></Button>
      <Button type="button" variant="ghost" size="icon-xs" data-testid="replay-message-button" aria-label="重新生成回复" title="重新生成回复"
        onClick={() => command(() => runtime.thread.getMessageById(assistants[0]!.id).reload())}><RotateCcwIcon aria-hidden="true" /></Button>
      {assistants.filter((message) => message.branchCount > 1).map((message) => <div key={message.id} className="flex items-center gap-0.5 tabular-nums" aria-label="回复分支">
        <Button type="button" variant="ghost" size="icon-xs" disabled={message.branchNumber <= 1} aria-label="上一个分支" title="上一个分支" onClick={() => command(() => runtime.thread.getMessageById(message.id).switchToBranch({ position: "previous" }))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <span className="min-w-8 text-center">{message.branchNumber} / {message.branchCount}</span>
        <Button type="button" variant="ghost" size="icon-xs" disabled={message.branchNumber >= message.branchCount} aria-label="下一个分支" title="下一个分支" onClick={() => command(() => runtime.thread.getMessageById(message.id).switchToBranch({ position: "next" }))}><ChevronRightIcon aria-hidden="true" /></Button>
      </div>)}
      {userBranches.map((branch) => <div key={branch.id} className="flex items-center gap-0.5 tabular-nums" aria-label="用户消息版本">
        <Button type="button" variant="ghost" size="icon-xs" disabled={branch.number <= 1} aria-label="上一个消息版本" title="上一个消息版本" onClick={() => command(() => runtime.thread.getMessageById(branch.id).switchToBranch({ position: "previous" }))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <span className="min-w-8 text-center">{branch.number} / {branch.count}</span>
        <Button type="button" variant="ghost" size="icon-xs" disabled={branch.number >= branch.count} aria-label="下一个消息版本" title="下一个消息版本" onClick={() => command(() => runtime.thread.getMessageById(branch.id).switchToBranch({ position: "next" }))}><ChevronRightIcon aria-hidden="true" /></Button>
      </div>)}
    </MessageFooter>
  </>;
}
