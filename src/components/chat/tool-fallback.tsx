"use client";

import { memo, useContext, useState } from "react";
import { ActivityPhaseContext, toolActivity } from "./process-group";
import { stringifyLogSafe } from "../../logging";

function format(value: unknown): string {
  try {
    return stringifyLogSafe(value, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback = memo(function ToolFallback(part: { toolName: string; status: { type: string }; args: unknown; result?: unknown; isError?: boolean; durationMs?: number; timingIncomplete?: boolean; interrupted?: boolean; autoExpandError?: boolean }) {
  const { status, label } = toolActivity(part, useContext(ActivityPhaseContext));
  const running = status === "running";
  const [expanded, setExpanded] = useState(status === "error" && part.autoExpandError !== false);
  return (
    <details className="activity" data-status={status} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span key={label} className={running ? "shimmer text-foreground/65" : undefined}>{label}</span>
      </summary>
      {expanded && <div className="activity-content">
        <strong>输入</strong>
        <pre>{format(part.args)}</pre>
        {part.result !== undefined && <><strong>输出</strong><pre>{format(part.result)}</pre></>}
      </div>}
    </details>
  );
}, (before, after) => before.toolName === after.toolName && before.status.type === after.status.type && before.args === after.args
  && before.result === after.result && before.isError === after.isError && before.durationMs === after.durationMs && before.timingIncomplete === after.timingIncomplete && before.interrupted === after.interrupted && before.autoExpandError === after.autoExpandError);
