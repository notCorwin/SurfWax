import { createContext } from "react";
import { getPartialJsonObjectMeta } from "assistant-stream/utils";

export type ActivityPhase = "pending" | "spoken" | "cancelled" | "failed" | "stopped";
export const ActivityPhaseContext = createContext<ActivityPhase>("spoken");

type SpeechMessage = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
};

export function turnActivityPhase(
  messages: readonly SpeechMessage[], messageId: string, running: boolean,
  status?: { readonly type: string; readonly reason?: string }, interrupted = false,
): ActivityPhase {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return "stopped";
  let start = index;
  while (start > 0 && messages[start - 1]?.role !== "user") start--;
  let end = index + 1;
  while (end < messages.length && messages[end]?.role !== "user") end++;
  if (messages.slice(start, end).some((message) => message.role === "assistant"
    && message.parts.some((part) => part.type === "text" && part.text?.trim()))) return "spoken";
  if (running && end === messages.length) return "pending";
  if (interrupted || status?.type === "requires-action" || status?.type === "incomplete" && status.reason === "cancelled") return "cancelled";
  return status?.type === "incomplete" ? "failed" : "stopped";
}

type ToolActivityPart = {
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly args: unknown;
};

export function toolActivity(part: ToolActivityPart, phase: ActivityPhase = "spoken"): { status: "running" | "error" | "complete"; label: string } {
  if (phase === "pending" && part.status.type !== "requires-action") return {
    status: "running",
    label: part.status.type === "running" && getPartialJsonObjectMeta(part.args as Record<symbol, unknown>)?.state === "partial"
      ? "正在输入命令" : "正在执行命令",
  };
  if (part.status.type === "incomplete" || part.isError) return { status: "error", label: "命令执行失败" };
  if (phase === "cancelled") return { status: "error", label: "回复中断" };
  if (phase === "failed") return { status: "error", label: "回复失败" };
  if (phase === "stopped") return { status: "complete", label: "回复未生成" };
  if (part.status.type === "requires-action") return { status: "running", label: "等待操作" };
  if (part.status.type === "running") return {
    status: "running",
    label: part.status.type === "running" && getPartialJsonObjectMeta(part.args as Record<symbol, unknown>)?.state === "partial"
      ? "正在输入命令" : "正在执行命令",
  };
  return { status: "complete", label: "命令执行完成" };
}

type ProcessPart = {
  readonly type: string;
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly args?: unknown;
};

export function processGroupSummary(parts: readonly ProcessPart[], indices: readonly number[], interrupted = false, phase: ActivityPhase = "spoken") {
  const grouped = indices.flatMap((index) => parts[index] ? [parts[index]!] : []);
  const tools = grouped.filter((part) => part.type === "tool-call");
  const latest = phase === "pending" ? grouped.at(-1)
    : phase === "spoken" ? [...grouped].reverse().find((part) => part.status.type === "running" || part.status.type === "requires-action") : undefined;
  if (latest?.status.type === "requires-action" && !interrupted) return { status: "running" as const, label: "等待操作" };
  if (latest && (phase === "pending" || !latest.isError && latest.status.type === "running")) {
    if (latest.type === "reasoning") return { status: "running" as const, label: "正在思考" };
    if (latest.type === "tool-call") return toolActivity({ status: latest.status, isError: latest.isError, args: latest.args }, phase);
  }
  if (phase === "cancelled") return { status: "error" as const, label: "回复中断" };
  if (phase === "failed") return { status: "error" as const, label: "回复失败" };
  const failed = grouped.some((part) => part.status.type === "incomplete" || part.isError
    || interrupted && part.status.type === "requires-action");
  if (failed) return {
    status: "error" as const,
    label: tools.length ? `${tools.length} 次命令中有失败` : "思考未完成",
  };
  if (phase === "stopped") return { status: "complete" as const, label: "回复未生成" };
  return {
    status: "complete" as const,
    label: tools.length ? `${grouped.some((part) => part.type === "reasoning") ? "已思考并" : "已"}执行 ${tools.length} 次命令` : "思考完成",
  };
}
