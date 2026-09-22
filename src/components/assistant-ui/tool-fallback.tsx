"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { getPartialJsonObjectMeta } from "assistant-stream/utils";

type ToolActivityPart = {
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly args: unknown;
};

export function toolActivity(part: ToolActivityPart): { status: "running" | "error" | "complete"; label: string } {
  const running = part.status.type === "running";
  const failed = part.status.type === "incomplete" || part.isError;
  return {
    status: running ? "running" : failed ? "error" : "complete",
    label: running
      ? getPartialJsonObjectMeta(part.args as Record<symbol, unknown>)?.state === "partial" ? "正在输入命令" : "正在执行命令"
      : failed ? "命令执行失败" : "命令执行完成",
  };
}

function format(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback: ToolCallMessagePartComponent = (part) => {
  const { status, label } = toolActivity(part);
  const running = status === "running";
  return (
    <details className="activity" data-status={status} open={status === "error"}>
      <summary>
        <span key={label} className={running ? "shimmer text-foreground/65" : undefined}>{label}</span>
      </summary>
      <div className="activity-content">
        <strong>输入</strong>
        <pre>{part.argsText || format(part.args)}</pre>
        {part.result !== undefined && <><strong>输出</strong><pre>{format(part.result)}</pre></>}
      </div>
    </details>
  );
};
