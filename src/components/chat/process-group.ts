import { createContext } from "react";
import { toolAction } from "./tool-labels";

export type ActivityPhase = "pending" | "settled" | "cancelled" | "failed" | "stopped";
export const ActivityPhaseContext = createContext<ActivityPhase>("settled");

type SpeechMessage = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
  readonly status?: { readonly type: string; readonly reason?: string };
  readonly metadata?: { readonly custom?: { readonly interrupted?: boolean } };
};

function activityEvent(part: SpeechMessage["parts"][number]): boolean {
  return part.type === "reasoning" || part.type === "tool-call" || part.type === "text" && !!part.text?.trim();
}

export function turnActivityBoundary(messages: readonly SpeechMessage[], messageId: string): number {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return -1;
  let end = index + 1;
  while (end < messages.length && messages[end]?.role !== "user") end++;
  if (messages.slice(index + 1, end).some((message) => message.role === "assistant" && message.parts.some(activityEvent))) return Infinity;
  const parts = messages[index]!.parts;
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) if (activityEvent(parts[partIndex]!)) return partIndex;
  return -1;
}

export function turnActivityPhase(messages: readonly SpeechMessage[], messageId: string, running: boolean): ActivityPhase {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return "stopped";
  let end = index + 1;
  while (end < messages.length && messages[end]?.role !== "user") end++;
  if (running && end === messages.length) return "pending";
  const turn = messages.slice(index, end).filter((message) => message.role === "assistant");
  const status = turn.at(-1)?.status;
  if (turn.some((message) => message.metadata?.custom?.interrupted) || status?.type === "requires-action"
    || status?.type === "incomplete" && status.reason === "cancelled") return "cancelled";
  return status?.type === "incomplete" ? "failed" : "stopped";
}

export function activityPhaseAt(boundary: number, partIndex: number, turnPhase: ActivityPhase, status?: string): ActivityPhase {
  if (turnPhase !== "pending" && turnPhase !== "settled" && (status === "running" || status === "requires-action")) return turnPhase;
  return boundary > partIndex ? "settled" : turnPhase;
}

type ToolActivityPart = {
  readonly toolName: string;
  readonly args?: unknown;
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly result?: unknown;
  readonly durationMs?: number;
  readonly startedAtMs?: number;
  readonly timingIncomplete?: boolean;
  readonly interrupted?: boolean;
};

export function toolActivity(part: ToolActivityPart, phase: ActivityPhase = "settled", now = Date.now()): { status: "running" | "error" | "complete"; label: string } {
  const name = toolAction({ toolName: part.toolName, args: part.args });
  const active = part.status.type === "running" || part.status.type === "requires-action";
  const elapsed = typeof part.durationMs === "number" && Number.isFinite(part.durationMs) && part.durationMs >= 0 ? part.durationMs
    : active && (phase === "pending" || phase === "settled") && typeof part.startedAtMs === "number" && Number.isFinite(part.startedAtMs) ? Math.max(0, now - part.startedAtMs) : undefined;
  const duration = elapsed === undefined ? "" : ` · ${part.timingIncomplete ? "≥" : ""}${(part.timingIncomplete ? Math.floor(elapsed / 10) / 100 : elapsed / 1000).toFixed(2)} 秒`;
  const error = part.result && typeof part.result === "object" && "error" in part.result ? part.result.error : undefined;
  const aborted = error && typeof error === "object" && "code" in error && (error.code === "aborted" || error.code === "interrupted");
  if (part.interrupted || aborted || (part.status.type === "running" || part.status.type === "requires-action") && phase === "cancelled") {
    return { status: "error", label: `${name} · 已中断${duration}` };
  }
  if (part.status.type === "incomplete" || part.isError) return { status: "error", label: `${name} · 未完成${duration}` };
  if (part.status.type === "running" || part.status.type === "requires-action") {
    if (phase === "failed" || phase === "stopped") return { status: "error", label: `${name} · 未完成${duration}` };
    return { status: "running", label: `${name}${duration}` };
  }
  return { status: "complete", label: `${name}${duration}` };
}
