"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { WrenchIcon } from "lucide-react";

function format(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback: ToolCallMessagePartComponent = (part) => {
  const running = part.status.type === "running";
  const failed = part.status.type === "incomplete" || part.isError;
  const status = running ? "running" : failed ? "error" : "complete";
  return (
    <details className="activity" data-status={status} open={running || failed}>
      <summary>
        <WrenchIcon aria-hidden="true" />
        <span>{part.toolName}</span>
        <span>{status}</span>
      </summary>
      <div className="activity-content">
        <strong>输入</strong>
        <pre>{part.argsText || format(part.args)}</pre>
        {part.result !== undefined && <><strong>输出</strong><pre>{format(part.result)}</pre></>}
      </div>
    </details>
  );
};
