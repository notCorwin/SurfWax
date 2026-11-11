import { useEffect, useRef, useState } from "react";
import { fromLogValue, type EventLogger, type LogEvent } from "@/logging";
import { classifyModelFailure, modelFailureMessages } from "@/model-error";
import { useActivityClock, useRetryCountdown } from "./use-activity-clock";

type Phase = "starting" | "preparing" | "compacting" | "provider" | "retrying" | "processing" | "finishing" | "terminal";
export type WaitingPhase = { runId: string; phase: Phase; startedAt?: number; eventId: number; retry?: { attempt: number; until: number; reason: string } };

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
    case "request.started":
    case "model.request.started": phase = "provider"; break;
    case "request.retry":
    case "model.request.retrying": phase = "retrying"; break;
    case "request.completed":
    case "request.failed":
    case "request.aborted":
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
  let retry: WaitingPhase["retry"];
  if (phase === "retrying") {
    const value = fromLogValue(event.retry, event.valueEncoding) as { attempt?: number; delayMs?: number; status?: number; reason?: string } | undefined;
    const content = fromLogValue(event.content, event.valueEncoding) as { status?: number; reason?: string } | undefined;
    const delayMs = value?.delayMs;
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) return { runId: event.runId, phase: "processing", eventId: event.id };
    const failure = classifyModelFailure(value?.status || content?.status ? { status: value?.status ?? content?.status }
      : fromLogValue(event.error, event.valueEncoding) ?? (content?.reason === "network" ? { name: "NetworkError" } : undefined));
    retry = { attempt: value?.attempt ?? 1, until: (Number.isFinite(timestamp) ? timestamp : Date.now()) + delayMs, reason: modelFailureMessages[value?.reason && Object.hasOwn(modelFailureMessages, value.reason) ? value.reason as keyof typeof modelFailureMessages : failure] };
  }
  return { runId: event.runId, phase, eventId: event.id, retry,
    startedAt: previous?.runId === event.runId && previous.phase === phase ? previous.startedAt : Number.isFinite(timestamp) ? timestamp : undefined };
}

const labels: Record<Exclude<Phase, "terminal">, string> = {
  starting: "正在准备本次工作", preparing: "正在准备上下文", compacting: "正在压缩上下文", provider: "正在等待推理提供商响应",
  retrying: "正在重试推理请求", processing: "正在处理结果", finishing: "正在完成回复",
};

export function useWaitingActivity({ logger, conversationId, running, stopping, stoppingAt, toolsRunning, afterActivityId }: {
  logger: EventLogger; conversationId: string; running: boolean; stopping: boolean; stoppingAt?: number; toolsRunning: boolean; afterActivityId?: string;
}) {
  const anchor = useRef(afterActivityId);
  anchor.current = afterActivityId;
  const [waits, setWaits] = useState<WaitingActivity[]>([]);
  const [phase, setPhase] = useState<WaitingPhase>();
  const latestPhase = useRef<WaitingPhase | undefined>(undefined);
  const active = useRef(running);
  active.current = running;
  useEffect(() => {
    setPhase(undefined);
    latestPhase.current = undefined;
    setWaits([]);
    return logger.subscribe((event) => {
      if (event.conversationId !== conversationId) return;
      if (!active.current && event.type !== "conversation.submitted" && !event.type.startsWith("conversation.")) return;
      const nextPhase = updateWaitingPhase(latestPhase.current, event);
      if (nextPhase === latestPhase.current) return;
      const previousPhase = latestPhase.current;
      latestPhase.current = nextPhase;
      setPhase(nextPhase);
      const parsedTime = Date.parse(event.timestamp);
      const eventTime = Number.isFinite(parsedTime) ? parsedTime : Date.now();
      if (event.type === "conversation.submitted") setWaits([]);
      if (event.type === "model.request.started" || event.type === "request.started" && previousPhase?.phase !== "provider") setWaits((previous) => [...previous.map((item) => item.endedAt === undefined ? { ...item, endedAt: eventTime, label: "等待响应结束" } : item), {
        id: `waiting:${event.runId}:${event.id}`, label: labels.provider, startedAt: Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : undefined, afterId: anchor.current,
      }]);
      if (event.type === "model.response.received" || event.type === "model.request.retrying" || event.type === "request.retry" || event.type === "conversation.aborted" || event.type === "conversation.failed") {
        const endedAt = eventTime;
        setWaits((previous) => previous.map((item) => item.endedAt === undefined ? { ...item, endedAt,
          label: event.type === "model.response.received" ? "等待响应完成" : (event.type === "model.request.retrying" || event.type === "request.retry") ? "等待响应失败" : "等待响应已中断" } : item));
      }
    });
  }, [logger, conversationId]);
  useEffect(() => {
    if (!running) { setPhase(undefined); setWaits([]); }
  }, [running, conversationId]);
  if (!running || phase?.phase === "terminal") return [];
  if (!stopping && (toolsRunning && !phase?.retry || phase?.phase === "provider")) return waits;
  const label = stopping ? "正在停止" : phase ? labels[phase.phase as Exclude<Phase, "terminal">] : "正在处理";
  const startedAt = stopping ? stoppingAt : phase?.startedAt;
  return [...waits, { id: `waiting:${phase?.runId ?? conversationId}:${stopping ? "stopping" : phase?.phase ?? "processing"}:${startedAt ?? "unknown"}`, label, startedAt, retry: stopping ? undefined : phase?.retry, afterId: afterActivityId }];
}

export type WaitingActivity = { id: string; label: string; startedAt?: number; endedAt?: number; retry?: WaitingPhase["retry"]; afterId?: string };

export function WaitingActivityRow({ activity }: { activity: WaitingActivity }) {
  const remaining = useRetryCountdown(activity.retry?.until);
  const { now, ref } = useActivityClock<HTMLParagraphElement>(activity.endedAt === undefined && !activity.retry, activity.startedAt);
  if (activity.retry) return <p role="status" className="transcript-activity transcript-waiting" data-testid="request-retry">{activity.retry.reason} 第 {activity.retry.attempt} 次自动重试：{remaining > 0 ? `${remaining} 秒后重试` : "即将重试"}；可停止生成。</p>;
  const elapsed = activity.startedAt === undefined ? "" : ` · ${(Math.max(0, (activity.endedAt ?? now) - activity.startedAt) / 1000).toFixed(2)} 秒`;
  return <p ref={ref} role="status" className={activity.endedAt === undefined ? "transcript-activity transcript-waiting" : "transcript-activity"} data-testid={activity.endedAt === undefined ? "waiting-status" : "waiting-completed"}>{activity.label}<span aria-live="off">{elapsed}</span></p>;
}
