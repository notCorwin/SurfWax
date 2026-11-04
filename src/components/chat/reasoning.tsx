"use client";

import { memo, useContext } from "react";
import { ActivityRow } from "./activity-row";
import { ActivityPhaseContext, type ActivityPhase } from "./process-group";

export function reasoningActivity(status: { type: string }, phase: ActivityPhase) {
  const running = status.type === "running" && (phase === "pending" || phase === "settled");
  const label = phase === "cancelled" ? "回复中断" : phase === "failed" ? "回复失败" : phase === "stopped" ? "回复未生成"
    : running ? "正在思考" : status.type === "incomplete" ? "思考未完成" : "思考完成";
  const failed = status.type === "incomplete" || phase === "cancelled" || phase === "failed" || phase === "stopped";
  return { label, status: failed ? "error" as const : running ? "running" as const : "complete" as const };
}

const ReasoningImpl = ({ status, responseTimeMs }: { status: { type: string }; responseTimeMs?: number }) => {
  const activity = reasoningActivity(status, useContext(ActivityPhaseContext));
  return <ActivityRow status={activity.status} testId="reasoning-item">{activity.label}{typeof responseTimeMs === "number" && Number.isFinite(responseTimeMs) && responseTimeMs >= 0
    ? <span title="模型响应总耗时，包含推理、生成和网络等待。">{` · ${(responseTimeMs / 1000).toFixed(2)} 秒`}</span> : null}</ActivityRow>;
};

export const Reasoning = memo(ReasoningImpl);
