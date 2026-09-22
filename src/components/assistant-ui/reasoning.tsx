"use client";

import type {
  ReasoningMessagePartComponent,
} from "@assistant-ui/react";
import { memo } from "react";
import { MarkdownText } from "./markdown-text";

const ReasoningImpl: ReasoningMessagePartComponent = ({ status }) => {
  const running = status.type === "running";
  return (
    <details
      className="thinking-item"
      data-testid="reasoning-item"
      open={running}
    >
      <summary>
        <span className={running ? "shimmer text-foreground/65" : undefined}>{running ? "正在思考" : "思考完成"}</span>
      </summary>
      <div className="thinking-body" aria-busy={running}>
        <MarkdownText />
      </div>
    </details>
  );
};

export const Reasoning = memo(ReasoningImpl);
