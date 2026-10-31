"use client";

import { memo, useContext, useEffect, useState } from "react";
import { ActivityPhaseContext, toolActivity } from "./process-group";
import { stringifyLogSafe } from "../../logging";

function format(value: unknown): string {
  try {
    return stringifyLogSafe(value, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback = memo(function ToolFallback(part: { toolName: string; status: { type: string }; args: unknown; result?: unknown; isError?: boolean; durationMs?: number; startedAtMs?: number; timingIncomplete?: boolean; interrupted?: boolean; autoExpandError?: boolean }) {
  const phase = useContext(ActivityPhaseContext);
  const [now, setNow] = useState(Date.now);
  const { status, label } = toolActivity(part, phase, now);
  const running = status === "running";
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!running || part.startedAtMs === undefined || part.durationMs !== undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [running, part.startedAtMs, part.durationMs]);
  return (
    <details className="activity transcript-activity" data-status={status} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span aria-live="off">{label}</span>
      </summary>
      {expanded && <div className="activity-content">
        <strong>输入</strong>
        <pre>{format(part.args)}</pre>
        {part.result !== undefined && <><strong>输出</strong><pre>{format(part.result)}</pre></>}
      </div>}
    </details>
  );
}, (before, after) => before.toolName === after.toolName && before.status.type === after.status.type && before.args === after.args
  && before.result === after.result && before.isError === after.isError && before.durationMs === after.durationMs && before.startedAtMs === after.startedAtMs && before.timingIncomplete === after.timingIncomplete && before.interrupted === after.interrupted && before.autoExpandError === after.autoExpandError);
