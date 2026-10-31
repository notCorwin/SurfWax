import { useEffect, useRef, useState } from "react";
import type { EventLogger, LogEvent } from "@/logging";

type Phase = "starting" | "preparing" | "compacting" | "provider" | "retrying" | "processing" | "finishing" | "terminal";
export type WaitingPhase = { runId: string; phase: Phase; startedAt?: number; eventId: number };

/** Derive only states supported by lifecycle events; a model call is not proof of thinking. */
export function updateWaitingPhase(previous: WaitingPhase | undefined, event: LogEvent): WaitingPhase | undefined {
  if (!event.runId) return previous;
  if (previous && event.id <= previous.eventId) return previous;
  if (previous?.phase === "terminal" && (event.runId === previous.runId || event.type !== "conversation.submitted")) return previous;
  if (previous && previous.runId !== event.runId && event.type !== "conversation.submitted") return previous;
  let phase: Phase | undefined;
  switch (event.type) {
    case "conversation.submitted": phase = "starting"; break;
    case "model.context.preparing": phase = "preparing"; break;
    case "context.compaction.started": phase = "compacting"; break;
    case "context.compacted": phase = "preparing"; break;
    case "model.request.started": phase = "provider"; break;
    case "model.request.retrying": phase = "retrying"; break;
    case "model.response.received":
    case "context.compaction.aborted":
    case "context.compaction.failed":
    case "tool.finished":
    case "tool.failed": phase = "processing"; break;
    case "model.finished": phase = "finishing"; break;
    case "conversation.finished":
    case "conversation.failed":
    case "conversation.aborted": phase = "terminal"; break;
  }
  if (!phase) return previous;
  // Repeated events describing the same phase must not reset its clock.
  const timestamp = Date.parse(event.timestamp);
  return { runId: event.runId, phase, eventId: event.id,
    startedAt: previous?.runId === event.runId && previous.phase === phase ? previous.startedAt : Number.isFinite(timestamp) ? timestamp : undefined };
}

const labels: Record<Exclude<Phase, "terminal">, string> = {
  starting: "正在准备本次工作", preparing: "正在准备上下文", compacting: "正在压缩上下文", provider: "正在等待推理提供商响应",
  retrying: "正在重试推理请求", processing: "正在处理结果", finishing: "正在完成回复",
};

export function WaitingStatus({ logger, conversationId, running, stopping, stoppingAt, toolsRunning }: {
  logger: EventLogger; conversationId: string; running: boolean; stopping: boolean; stoppingAt?: number; toolsRunning: boolean;
}) {
  const [phase, setPhase] = useState<WaitingPhase>();
  const [now, setNow] = useState(() => Date.now());
  const active = useRef(running);
  active.current = running;
  useEffect(() => {
    setPhase(undefined);
    return logger.subscribe((event) => {
      if (event.conversationId === conversationId && active.current) setPhase((previous) => updateWaitingPhase(previous, event));
    });
  }, [logger, conversationId]);
  useEffect(() => {
    if (!running) setPhase(undefined);
  }, [running, conversationId]);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, [running]);
  if (!running || (!stopping && (toolsRunning || phase?.phase === "terminal"))) return null;
  const label = stopping ? "正在停止" : phase ? labels[phase.phase as Exclude<Phase, "terminal">] : "正在处理";
  const startedAt = stopping ? stoppingAt : phase?.startedAt;
  const elapsed = startedAt === undefined ? "" : ` · ${(Math.max(0, now - startedAt) / 1000).toFixed(2)} 秒`;
  return <p role="status" className="conversation-notice px-2" data-testid="waiting-status">{label}<span aria-live="off">{elapsed}</span></p>;
}
