import { createContext } from "react";

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
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly result?: unknown;
  readonly durationMs?: number;
  readonly timingIncomplete?: boolean;
  readonly interrupted?: boolean;
};

export function toolActivity(part: ToolActivityPart, phase: ActivityPhase = "settled"): { status: "running" | "error" | "complete"; label: string } {
  const name = part.toolName || "未知工具";
  const duration = typeof part.durationMs === "number" && Number.isFinite(part.durationMs) && part.durationMs >= 0
    ? ` · ${part.timingIncomplete ? "≥" : ""}${(part.timingIncomplete ? Math.floor(part.durationMs / 10) / 100 : part.durationMs / 1000).toFixed(2)} 秒` : "";
  const error = part.result && typeof part.result === "object" && "error" in part.result ? part.result.error : undefined;
  const aborted = error && typeof error === "object" && "code" in error && (error.code === "aborted" || error.code === "interrupted");
  if (part.interrupted || aborted || (part.status.type === "running" || part.status.type === "requires-action") && phase === "cancelled") {
    return { status: "error", label: `${name} 已中断${duration}` };
  }
  if (part.status.type === "incomplete" || part.isError) return { status: "error", label: `${name} 失败${duration}` };
  if (part.status.type === "running" || part.status.type === "requires-action") {
    if (phase === "failed" || phase === "stopped") return { status: "error", label: `${name} 未完成${duration}` };
    return { status: "running", label: part.status.type === "requires-action" ? `${name} 等待操作` : `正在调用 ${name}` };
  }
  return { status: "complete", label: `${name} 已完成${duration}` };
}

type ProcessPart = {
  readonly type: string;
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly toolName?: string;
  readonly result?: unknown;
  readonly durationMs?: number;
  readonly timingIncomplete?: boolean;
  readonly interrupted?: boolean;
};

export function processGroupSummary(parts: readonly ProcessPart[], indices: readonly number[], interrupted = false, phase: ActivityPhase = "settled") {
  const grouped = indices.flatMap((index) => parts[index] ? [parts[index]!] : []);
  const tools = grouped.filter((part) => part.type === "tool-call");
  if (tools.length) {
    const latestTool = tools.at(-1)!;
    const latest = toolActivity({ ...latestTool, toolName: latestTool.toolName || "未知工具" }, interrupted && latestTool.status.type === "requires-action" ? "cancelled" : phase);
    const earlierFailure = tools.slice(0, -1).some((part) => part.status.type === "incomplete" || part.isError);
    return { status: earlierFailure && latest.status === "complete" ? "error" as const : latest.status,
      label: `${latest.label}${earlierFailure ? " · 此前有失败" : ""}` };
  }
  const latest = phase === "pending" ? grouped.at(-1)
    : phase === "settled" ? [...grouped].reverse().find((part) => part.status.type === "running" || part.status.type === "requires-action") : undefined;
  if (latest?.status.type === "requires-action" && !interrupted) return { status: "running" as const, label: "等待操作" };
  if (latest && (phase === "pending" || !latest.isError && latest.status.type === "running")) {
    if (latest.type === "reasoning") return { status: "running" as const, label: "正在思考" };
  }
  if (phase === "cancelled") return { status: "error" as const, label: "回复中断" };
  if (phase === "failed") return { status: "error" as const, label: "回复失败" };
  const failed = grouped.some((part) => part.status.type === "incomplete" || part.isError
    || interrupted && part.status.type === "requires-action");
  if (failed) return {
    status: "error" as const,
    label: "思考未完成",
  };
  if (phase === "stopped") return { status: "complete" as const, label: "回复未生成" };
  return {
    status: "complete" as const,
    label: "思考完成",
  };
}
