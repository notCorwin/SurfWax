"use client";

import { memo, useContext, useState } from "react";
import { ActivityPhaseContext, toolActivity } from "./process-group";

function format(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback = memo(function ToolFallback(part: { status: { type: string }; args: unknown; argsText?: string; result?: unknown; isError?: boolean }) {
  const { status, label } = toolActivity(part, useContext(ActivityPhaseContext));
  const running = status === "running";
  const [expanded, setExpanded] = useState(status === "error");
  return (
    <details className="activity" data-status={status} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span key={label} className={running ? "shimmer text-foreground/65" : undefined}>{label}</span>
      </summary>
      {expanded && <div className="activity-content">
        <strong>输入</strong>
        <pre>{part.argsText || format(part.args)}</pre>
        {part.result !== undefined && <><strong>输出</strong><pre>{format(part.result)}</pre></>}
      </div>}
    </details>
  );
}, (before, after) => before.status.type === after.status.type && before.args === after.args
  && before.argsText === after.argsText && before.result === after.result && before.isError === after.isError);
