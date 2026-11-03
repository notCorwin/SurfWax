import type { MessagePart, MessageView } from "@/sidepanel/conversation-store";
import { summarizeToolActions } from "./tool-labels";
import { ToolFallback } from "./tool-fallback";
import { Reasoning } from "./reasoning";
import { useContext, useLayoutEffect, useRef } from "react";
import { ActivityPhaseContext, toolActivity, toolWasInterrupted, type ActivityPhase } from "./process-group";

type ToolPart = Extract<MessagePart, { type: "tool-call" }>;
type ReasoningPart = Extract<MessagePart, { text: string }>;
export type ToolGroup = { key: string; tools: ToolPart[]; reasoning: ReasoningPart[]; live: boolean; followedByText: boolean };
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
        current = { key, tools: [], reasoning: [], live: false, followedByText: false };
        starts.set(key, current);
        groups.push(current);
      }
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
export function toolGroupDuration(tools: readonly ToolPart[]): number | undefined {
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

type PreviousRow = { id: string; top: number; height: number; clone: HTMLElement; offset: number; startedAt: number };
const ROLL_DURATION = 200;
const visualTop = (row: PreviousRow, now: number) => row.top + row.offset * Math.max(0, 1 - (now - row.startedAt) / ROLL_DURATION);

function LiveTools({ tools }: { tools: readonly ToolPart[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const previous = useRef<PreviousRow[]>([]);
  const previousIds = useRef<string | undefined>(undefined);
  const ids = JSON.stringify(tools.map((tool) => tool.toolCallId));
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(":scope > [data-tool-id]"));
    const old = previous.current;
    const oldById = new Map(old.map((row) => [row.id, row]));
    const currentRows = rows.filter((row) => !row.hasAttribute("aria-hidden"));
    const now = performance.now();
    const changed = previousIds.current !== undefined && previousIds.current !== ids;
    previousIds.current = ids;
    if (!changed) {
      previous.current = currentRows.map((row) => {
        const before = oldById.get(row.dataset.toolId!);
        return { id: row.dataset.toolId!, top: row.offsetTop, height: row.offsetHeight,
          clone: row.cloneNode(true) as HTMLElement, offset: before?.offset ?? 0, startedAt: before?.startedAt ?? now };
      });
      return;
    }
    const motionAllowed = typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const offsets = new Map<string, number>();
    for (const row of currentRows) row.getAnimations?.().forEach((effect) => effect.cancel());
    if (old.length && motionAllowed && typeof root.animate === "function") {
      const animation = { duration: ROLL_DURATION, easing: "linear" };
      const step = old.length > 1 ? old[1]!.top - old[0]!.top : old[0]!.height;
      const idsNow = new Set(tools.map((tool) => tool.toolCallId));
      for (const row of old) if (!idsNow.has(row.id)) {
        const ghosts = root.querySelectorAll<HTMLElement>(":scope > [data-tool-id][aria-hidden]");
        if (ghosts.length >= 3) ghosts[0]?.remove();
        const clone = row.clone;
        clone.setAttribute("aria-hidden", "true");
        Object.assign(clone.style, { position: "absolute", top: `${visualTop(row, now)}px`, left: "0", width: "100%", pointerEvents: "none" });
        root.appendChild(clone);
        const effect = clone.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-step}px)` }], animation);
        effect.onfinish = () => clone.remove();
        effect.oncancel = () => clone.remove();
      }
      for (const row of currentRows) {
        const before = oldById.get(row.dataset.toolId!);
        const offset = before ? visualTop(before, now) - row.offsetTop : visualTop(old[old.length - 1]!, now) + step - row.offsetTop;
        offsets.set(row.dataset.toolId!, offset);
        if (offset) row.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], animation);
      }
    }
    previous.current = currentRows.map((row) => ({ id: row.dataset.toolId!, top: row.offsetTop, height: row.offsetHeight,
      clone: row.cloneNode(true) as HTMLElement, offset: offsets.get(row.dataset.toolId!) ?? 0, startedAt: now }));
  });
  return <div ref={viewport} className="live-tool-viewport" data-testid="live-tool-viewport">
    {tools.map((part) => <div data-tool-id={part.toolCallId} key={part.toolCallId}><ToolFallback {...part} /></div>)}
  </div>;
}

export function ToolGroupView({ group }: { group: ToolGroup }) {
  const phase = useContext(ActivityPhaseContext);
  const duration = toolGroupDuration(group.tools);
  const summary = summarizeToolActions(group.tools);
  const reasoningStatus = group.reasoning.some((part) => part.status.type === "running") ? "running"
    : group.reasoning.some((part) => part.status.type === "incomplete") ? "incomplete" : "complete";
  const reasoningPhase = reasoningStatus === "complete" || group.followedByText && reasoningStatus !== "running" ? "settled" : phase;
  return <div className="transcript-activity-list flex flex-col">
    {group.reasoning.length > 0 && <ActivityPhaseContext.Provider value={reasoningPhase}>
      <Reasoning status={{ type: reasoningStatus }} text={group.reasoning.map((part) => part.text).filter(Boolean).join("\n\n")} />
    </ActivityPhaseContext.Provider>}
    {group.tools.length > 0 && (group.live ? <div data-testid="live-tool-calls" className="transcript-activity-list flex flex-col">
      <FailureSummary tools={group.tools.slice(0, -3)} phase={phase} />
      <LiveTools tools={group.tools.slice(-3)} />
    </div> : <><div data-testid="tool-group-summary" className="transcript-activity">
    <span className="truncate" title={summary}>{summary}</span>{duration === undefined ? null : <span className="shrink-0">{` · ${(duration / 1000).toFixed(2)} 秒`}</span>}
    </div><FailureSummary tools={group.tools} phase={phase} /></>)}
  </div>;
}
