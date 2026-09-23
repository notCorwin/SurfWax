"use client";

import type {
  ReasoningMessagePartComponent,
} from "@assistant-ui/react";
import { memo, useContext } from "react";
import { MarkdownText } from "./markdown-text";
import { ActivityPhaseContext } from "./process-group";

const ReasoningImpl: ReasoningMessagePartComponent = ({ status }) => {
  const phase = useContext(ActivityPhaseContext);
  const running = status.type === "running" && phase !== "stopped" || status.type === "complete" && phase === "pending";
  const label = status.type === "running" && phase !== "stopped" ? "正在思考"
    : status.type === "incomplete" || status.type === "running" && phase === "stopped" ? "思考未完成"
    : phase === "pending" ? "正在准备回复" : phase === "stopped" ? "回复未生成" : "思考完成";
  return (
    <details
      className="thinking-item"
      data-testid="reasoning-item"
      open={status.type === "running" && phase !== "stopped"}
    >
      <summary>
        <span className={running ? "shimmer text-foreground/65" : undefined}>{label}</span>
      </summary>
      <div className="thinking-body" aria-busy={status.type === "running" && phase !== "stopped"}>
        <MarkdownText />
      </div>
    </details>
  );
};

export const Reasoning = memo(ReasoningImpl);
