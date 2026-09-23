"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useContext } from "react";
import { ActivityPhaseContext, toolActivity } from "./process-group";

function format(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const ToolFallback: ToolCallMessagePartComponent = (part) => {
  const { status, label } = toolActivity(part, useContext(ActivityPhaseContext));
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
