"use client";

import { memo, useContext, useEffect, useState } from "react";
import { ActivityRow } from "./activity-row";
import { ActivityPhaseContext, toolActivity } from "./process-group";
export const ToolFallback = memo(function ToolFallback(part: { toolName: string; status: { type: string }; args: unknown; result?: unknown; isError?: boolean; durationMs?: number; startedAtMs?: number; timingIncomplete?: boolean; interrupted?: boolean }) {
  const phase = useContext(ActivityPhaseContext);
  const [now, setNow] = useState(Date.now);
  const { status, label } = toolActivity(part, phase, now);
  const running = status === "running";
  useEffect(() => {
    if (!running || part.startedAtMs === undefined || part.durationMs !== undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [running, part.startedAtMs, part.durationMs]);
  return <ActivityRow status={status}>{label}</ActivityRow>;
}, (before, after) => before.toolName === after.toolName && before.status.type === after.status.type && before.args === after.args
  && before.result === after.result && before.isError === after.isError && before.durationMs === after.durationMs && before.startedAtMs === after.startedAtMs && before.timingIncomplete === after.timingIncomplete && before.interrupted === after.interrupted);
