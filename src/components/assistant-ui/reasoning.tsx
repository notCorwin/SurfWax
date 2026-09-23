"use client";

import type {
  ReasoningMessagePartComponent,
} from "@assistant-ui/react";
import { memo, useContext } from "react";
import { MarkdownText } from "./markdown-text";
import { ActivityPhaseContext } from "./process-group";

const ReasoningImpl: ReasoningMessagePartComponent = ({ status }) => {
  const phase = useContext(ActivityPhaseContext);
  const running = phase === "pending" || phase === "settled" && status.type === "running";
  const label = phase === "cancelled" ? "回复中断" : phase === "failed" ? "回复失败" : phase === "stopped" ? "回复未生成"
    : running ? "正在思考" : status.type === "incomplete" ? "思考未完成" : "思考完成";
  return (
    <details
      className="thinking-item"
      data-testid="reasoning-item"
      open={status.type === "running" && phase !== "cancelled" && phase !== "failed" && phase !== "stopped"}
    >
      <summary>
        <span className={running ? "shimmer text-foreground/65" : undefined}>{label}</span>
      </summary>
      <div className="thinking-body" aria-busy={status.type === "running" && phase !== "cancelled" && phase !== "failed" && phase !== "stopped"}>
        <MarkdownText />
      </div>
    </details>
  );
};

export const Reasoning = memo(ReasoningImpl);
