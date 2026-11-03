"use client";

import { memo, useContext } from "react";
import { ActivityRow } from "./activity-row";
import { ActivityPhaseContext } from "./process-group";

const ReasoningImpl = ({ status }: { status: { type: string } }) => {
  const phase = useContext(ActivityPhaseContext);
  const running = status.type === "running" && (phase === "pending" || phase === "settled");
  const label = phase === "cancelled" ? "回复中断" : phase === "failed" ? "回复失败" : phase === "stopped" ? "回复未生成"
    : running ? "正在思考" : status.type === "incomplete" ? "思考未完成" : "思考完成";
  const failed = status.type === "incomplete" || phase === "cancelled" || phase === "failed" || phase === "stopped";
  return <ActivityRow status={failed ? "error" : running ? "running" : "complete"} testId="reasoning-item">{label}</ActivityRow>;
};

export const Reasoning = memo(ReasoningImpl);
