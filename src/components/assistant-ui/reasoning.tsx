"use client";

import type {
  ReasoningMessagePartComponent,
} from "@assistant-ui/react";
import { BrainIcon } from "lucide-react";
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
        <BrainIcon className="thinking-mark" aria-hidden="true" />
        <span className={running ? "shimmer text-foreground/65" : undefined}>{running ? "正在思考" : "已思考"}</span>
      </summary>
      <div className="thinking-body" aria-busy={running}>
        <MarkdownText />
      </div>
    </details>
  );
};

export const Reasoning = memo(ReasoningImpl);
