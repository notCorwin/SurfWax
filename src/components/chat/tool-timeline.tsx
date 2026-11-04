import type { MessagePart, MessageView } from "@/sidepanel/conversation-store";
import { summarizeToolActions } from "./tool-labels";
import { ToolFallback } from "./tool-fallback";
import { WaitingActivityRow, type WaitingActivity } from "./waiting-status";
import { Reasoning, reasoningActivity } from "./reasoning";
import { useContext } from "react";
import { ActivityPhaseContext, toolActivity, toolWasInterrupted, type ActivityPhase } from "./process-group";

type ToolPart = Extract<MessagePart, { type: "tool-call" }>;
type ReasoningPart = Extract<MessagePart, { text: string }>;
type ActivityEntry = { id: string; part: ToolPart | ReasoningPart };
export type ToolGroup = { activities: ActivityEntry[]; waiting?: WaitingActivity[]; key: string; tools: ToolPart[]; reasoning: ReasoningPart[]; live: boolean; followedByText: boolean };
export type ToolTimeline = { starts: Map<string, ToolGroup> };
const partKey = (messageId: string, index: number) => JSON.stringify([messageId, index]);
const cached = new WeakMap<readonly MessageView[], { live?: ToolTimeline; settled?: ToolTimeline }>();

/** Group adjacent reasoning and tools across messages, splitting only at visible assistant text. */
export function projectToolTimeline(messages: readonly MessageView[], running: boolean): ToolTimeline {
  const existing = cached.get(messages);
  const previous = running ? existing?.live : existing?.settled;
  if (previous) return previous;
  const starts = new Map<string, ToolGroup>();
  const groups: ToolGroup[] = [];
  let current: ToolGroup | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") { current = undefined; continue; }
    message.parts.forEach((part, index) => {
      if (part.type === "text") {
        if (part.text.trim()) {
          if (current) current.followedByText = true;
          current = undefined;
        }
        return;
      }
      if (part.type === "reasoning" && !part.text.trim() && part.status.type !== "running") return;
      const key = partKey(message.id, index);
      if (!current) {
        current = { activities: [], key, tools: [], reasoning: [], live: false, followedByText: false };
        starts.set(key, current);
        groups.push(current);
      }
      current.activities.push({ id: part.type === "tool-call" ? part.toolCallId : `reasoning:${key}`, part });
      if (part.type === "tool-call") current.tools.push(part);
      else current.reasoning.push(part);
    });
  }
  if (running) for (const group of groups) {
    group.live = group === current || group.tools.some((tool) => tool.status.type === "running" || tool.status.type === "requires-action")
      || group.reasoning.some((part) => part.status.type === "running");
  }
  const timeline = { starts };
  cached.set(messages, { ...existing, [running ? "live" : "settled"]: timeline });
  return timeline;
}

export function toolGroupAt(timeline: ToolTimeline, messageId: string, index: number) {
  return timeline.starts.get(partKey(messageId, index));
}

/** A wall-clock span is valid only when every call has reliable start/end timestamps. */
export function toolGroupDuration(tools: readonly { startedAtMs?: number; finishedAtMs?: number; timingIncomplete?: boolean }[]): number | undefined {
  if (!tools.length) return undefined;
  let start = Infinity;
  let end = -Infinity;
  for (const tool of tools) {
    if (tool.timingIncomplete || typeof tool.startedAtMs !== "number" || !Number.isFinite(tool.startedAtMs)
      || typeof tool.finishedAtMs !== "number" || !Number.isFinite(tool.finishedAtMs) || tool.finishedAtMs < tool.startedAtMs) return undefined;
    start = Math.min(start, tool.startedAtMs);
    end = Math.max(end, tool.finishedAtMs);
  }
  return end - start;
}

function FailureSummary({ tools, phase }: { tools: readonly ToolPart[]; phase: ActivityPhase }) {
  let incomplete = 0, interrupted = 0;
  for (const part of tools) {
    if (toolActivity(part, phase).status !== "error") continue;
    if (toolWasInterrupted(part, phase)) interrupted++;
    else incomplete++;
  }
  if (!incomplete && !interrupted) return null;
  return <div className="activity transcript-activity" data-status="error" data-testid="tool-failure-summary">
    <span>{[incomplete && `${incomplete} 项未完成`, interrupted && `${interrupted} 项已中断`].filter(Boolean).join("，")}</span>
  </div>;
}

export function withWaitingActivity(timeline: ToolTimeline, waiting: WaitingActivity[]): { timeline: ToolTimeline; trailing?: ToolGroup } {
  const groups = [...timeline.starts.values()];
  const tail = groups.at(-1);
  const starts = new Map(timeline.starts);
  const owners = new Map<string, ToolGroup>();
  for (const group of groups) if (group !== tail) {
    for (const entry of group.activities) owners.set(entry.id, group);
  }
  const groupedWaits = new Map<ToolGroup, WaitingActivity[]>();
  const remaining: WaitingActivity[] = [];
  for (const item of waiting) {
    const owner = item.afterId ? owners.get(item.afterId) : undefined;
    if (!owner) { remaining.push(item); continue; }
    const items = groupedWaits.get(owner);
    if (items) items.push(item);
    else groupedWaits.set(owner, [item]);
  }
  for (const [owner, items] of groupedWaits) starts.set(owner.key, { ...owner, waiting: [...(owner.waiting ?? []), ...items] });
  if (tail?.live && !tail.followedByText) {
    starts.delete(tail.key);
    return { timeline: { starts }, trailing: { ...tail, waiting: remaining } };
  }
  const tailIds = new Set(tail?.activities.map((entry) => entry.id));
  const trailingWaits: WaitingActivity[] = [];
  const tailWaits: WaitingActivity[] = [];
  for (const item of remaining) (item.afterId && tailIds.has(item.afterId) ? tailWaits : trailingWaits).push(item);
  if (tail && tailWaits.length) starts.set(tail.key, { ...tail, waiting: tailWaits });
  return { timeline: { starts }, trailing: { key: "live-activity", activities: [], tools: [], reasoning: [], live: true, followedByText: false, waiting: trailingWaits } };
}

export function ToolGroupView({ group }: { group: ToolGroup }) {
  const phase = useContext(ActivityPhaseContext);
  const duration = toolGroupDuration([...group.tools, ...group.reasoning]);
  const toolSummary = summarizeToolActions(group.tools);
  const reasoningStatus = group.reasoning.some((part) => part.status.type === "running") ? "running"
    : group.reasoning.some((part) => part.status.type === "incomplete") ? "incomplete" : "complete";
  const responseTimes = new Map(group.reasoning.flatMap((part) => part.responseTimingId !== undefined && part.responseTimeMs !== undefined ? [[part.responseTimingId, part.responseTimeMs] as const] : []));
  const reasoningTime = group.reasoning.every((part) => part.responseTimeMs !== undefined) && responseTimes.size ? [...responseTimes.values()].reduce((sum, value) => sum + value, 0) : undefined;
  const reasoningPhase = reasoningStatus === "complete" || group.followedByText && reasoningStatus !== "running" ? "settled" : phase;
  const reasoningState = reasoningActivity({ type: reasoningStatus }, reasoningPhase);
  const summary = group.reasoning.length ? `${reasoningState.label}、${toolSummary}` : toolSummary;
  const activityIds = new Set(group.activities.map((entry) => entry.id));
  const waitsAfter = new Map<string | undefined, WaitingActivity[]>();
  for (const waiting of group.waiting ?? []) {
    const anchor = waiting.afterId && activityIds.has(waiting.afterId) ? waiting.afterId : undefined;
    const items = waitsAfter.get(anchor);
    if (items) items.push(waiting);
    else waitsAfter.set(anchor, [waiting]);
  }
  const waitingEntries = (anchor?: string) => (waitsAfter.get(anchor) ?? []).map((activity) => ({
    id: activity.id, content: <WaitingActivityRow activity={activity} />,
  }));
  const entries = waitingEntries();
  for (const { id, part } of group.activities) {
    entries.push({ id, content: part.type === "tool-call" ? <ToolFallback {...part} />
      : <ActivityPhaseContext.Provider value={part.status.type === "complete" || group.followedByText ? "settled" : reasoningPhase}><Reasoning status={part.status} responseTimeMs={part.responseTimeMs} /></ActivityPhaseContext.Provider> });
    entries.push(...waitingEntries(id));
  }
  return <div className="transcript-activity-list flex flex-col">
    {group.live ? <div data-testid="live-tool-calls" className="transcript-activity-list flex flex-col">
      <div data-testid="live-tool-viewport" className="transcript-activity-list flex flex-col">
        {entries.map((entry) => <div data-tool-id={entry.id} key={entry.id}>{entry.content}</div>)}
      </div>
    </div> : <>
      {group.reasoning.length > 0 && group.tools.length === 0 && <ActivityPhaseContext.Provider value={reasoningPhase}>
        <Reasoning status={{ type: reasoningStatus }} responseTimeMs={reasoningTime} />
      </ActivityPhaseContext.Provider>}
      {group.tools.length > 0 && <><div data-testid="tool-group-summary" className="activity transcript-activity" data-status={group.reasoning.length ? reasoningState.status : "complete"}>
        <span className="truncate" title={summary}>{summary}</span>{duration === undefined ? null : <span className="shrink-0" title="本组思考和工具操作从开始到结束的总耗时。">{` · ${(duration / 1000).toFixed(2)} 秒`}</span>}
      </div><FailureSummary tools={group.tools} phase={phase} /></>}
    </>}
  </div>;
}
