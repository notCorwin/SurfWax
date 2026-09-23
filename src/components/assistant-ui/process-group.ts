import { createContext } from "react";
import { getPartialJsonObjectMeta } from "assistant-stream/utils";

export type ActivityPhase = "pending" | "spoken" | "stopped";
export const ActivityPhaseContext = createContext<ActivityPhase>("spoken");

type SpeechMessage = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
};

export function turnActivityPhase(messages: readonly SpeechMessage[], messageId: string, running: boolean): ActivityPhase {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return "stopped";
  let start = index;
  while (start > 0 && messages[start - 1]?.role !== "user") start--;
  let end = index + 1;
  while (end < messages.length && messages[end]?.role !== "user") end++;
  if (messages.slice(start, end).some((message) => message.role === "assistant"
    && message.parts.some((part) => part.type === "text" && part.text?.trim()))) return "spoken";
  return running && end === messages.length ? "pending" : "stopped";
}

type ToolActivityPart = {
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly args: unknown;
};

export function toolActivity(part: ToolActivityPart, phase: ActivityPhase = "spoken"): { status: "running" | "error" | "complete"; label: string } {
  const running = part.status.type === "running" && phase !== "stopped";
  const failed = part.status.type === "incomplete" || part.isError || part.status.type === "running" && phase === "stopped";
  return {
    status: running || !failed && phase === "pending" ? "running" : failed ? "error" : "complete",
    label: running
      ? getPartialJsonObjectMeta(part.args as Record<symbol, unknown>)?.state === "partial" ? "正在输入命令" : "正在执行命令"
      : failed ? "命令执行失败" : phase === "pending" ? "正在准备回复" : phase === "stopped" ? "回复未生成" : "命令执行完成",
  };
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
  const active = [...grouped].reverse().find((part) => part.status.type === "running" || part.status.type === "requires-action");
  if (phase !== "stopped" && active?.status.type === "requires-action" && !interrupted) return { status: "running" as const, label: "等待操作" };
  if (phase !== "stopped" && active?.status.type === "running" && active.type === "reasoning") return { status: "running" as const, label: "正在思考" };
  if (phase !== "stopped" && active?.status.type === "running" && active.type === "tool-call") {
    const activity = toolActivity({ status: active.status, isError: active.isError, args: active.args });
    return { status: "running" as const, label: activity.label };
  }
  const failed = grouped.some((part) => part.status.type === "incomplete" || part.isError
    || (interrupted || phase === "stopped") && (part.status.type === "requires-action" || part.status.type === "running"));
  if (failed) return {
    status: "error" as const,
    label: tools.length ? `${tools.length} 次命令中有失败` : "思考未完成",
  };
  if (phase !== "spoken") return { status: phase === "pending" ? "running" as const : "complete" as const,
    label: phase === "pending" ? "正在准备回复" : "回复未生成" };
  return {
    status: "complete" as const,
    label: tools.length ? `${grouped.some((part) => part.type === "reasoning") ? "已思考并" : "已"}执行 ${tools.length} 次命令` : "思考完成",
  };
}
