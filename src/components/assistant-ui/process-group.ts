import { toolActivity } from "./tool-fallback";

type ProcessPart = {
  readonly type: string;
  readonly status: { readonly type: string };
  readonly isError?: boolean;
  readonly args?: unknown;
};

export function processGroupSummary(parts: readonly ProcessPart[], indices: readonly number[], interrupted = false) {
  const grouped = indices.flatMap((index) => parts[index] ? [parts[index]!] : []);
  const tools = grouped.filter((part) => part.type === "tool-call");
  const active = [...grouped].reverse().find((part) => part.status.type === "running" || part.status.type === "requires-action");
  if (active?.status.type === "requires-action" && !interrupted) return { status: "running" as const, label: "等待操作" };
  if (active?.status.type === "running" && active.type === "reasoning") return { status: "running" as const, label: "正在思考" };
  if (active?.status.type === "running" && active.type === "tool-call") {
    const activity = toolActivity({ status: active.status, isError: active.isError, args: active.args });
    return { status: "running" as const, label: activity.label };
  }
  const failed = grouped.some((part) => part.status.type === "incomplete" || part.isError
    || interrupted && part.status.type === "requires-action");
  if (failed) return {
    status: "error" as const,
    label: tools.length ? `${tools.length} 次命令中有失败` : "思考未完成",
  };
  return {
    status: "complete" as const,
    label: tools.length ? `${grouped.some((part) => part.type === "reasoning") ? "已思考并" : "已"}执行 ${tools.length} 次命令` : "思考完成",
  };
}
