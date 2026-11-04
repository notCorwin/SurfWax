"use client";

import { memo, useContext } from "react";
import { ActivityRow } from "./activity-row";
import { ActivityPhaseContext, toolActivity } from "./process-group";
import { useActivityClock } from "./use-activity-clock";
export const ToolFallback = memo(function ToolFallback(part: { toolName: string; status: { type: string }; args: unknown; result?: unknown; isError?: boolean; durationMs?: number; startedAtMs?: number; timingIncomplete?: boolean; interrupted?: boolean }) {
  const phase = useContext(ActivityPhaseContext);
  const active = toolActivity(part, phase).status === "running" && part.durationMs === undefined;
  const { now, ref } = useActivityClock<HTMLDivElement>(active, part.startedAtMs);
  const { status, label } = toolActivity(part, phase, now);
  return <ActivityRow ref={ref} status={status}>{label}</ActivityRow>;
}, (before, after) => before.toolName === after.toolName && before.status.type === after.status.type && before.args === after.args
  && before.result === after.result && before.isError === after.isError && before.durationMs === after.durationMs && before.startedAtMs === after.startedAtMs && before.timingIncomplete === after.timingIncomplete && before.interrupted === after.interrupted);
