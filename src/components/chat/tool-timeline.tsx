import type { MessagePart, MessageView } from "@/sidepanel/conversation-store";
import { summarizeToolActions } from "./tool-labels";
import { ToolFallback } from "./tool-fallback";

type ToolPart = Extract<MessagePart, { type: "tool-call" }>;
export type ToolGroup = { key: string; tools: ToolPart[]; live: boolean };
export type ToolTimeline = { starts: Map<string, ToolGroup> };
const partKey = (messageId: string, index: number) => JSON.stringify([messageId, index]);
const cached = new WeakMap<readonly MessageView[], { live?: ToolTimeline; settled?: ToolTimeline }>();

/** Preserve the part order, including tool sequences that cross assistant message boundaries. */
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
      if (part.type !== "tool-call") {
        // Empty streaming placeholders are not visible content and must not split a sequence.
        if (part.text.trim()) current = undefined;
        return;
      }
      const key = partKey(message.id, index);
      if (!current) {
        current = { key, tools: [], live: false };
        starts.set(key, current);
        groups.push(current);
      }
      current.tools.push(part);
    });
  }
  if (running) for (const group of groups) {
    group.live = group === current || group.tools.some((tool) => tool.status.type === "running" || tool.status.type === "requires-action");
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

export function ToolGroupView({ group }: { group: ToolGroup }) {
  if (group.live) return <div data-testid="live-tool-calls" className="flex flex-col">
    {group.tools.slice(-3).map((part) => <ToolFallback key={part.toolCallId} {...part} autoExpandError={false} />)}
  </div>;
  const duration = toolGroupDuration(group.tools);
  const summary = summarizeToolActions(group.tools);
  return <div data-testid="tool-group-summary" className="thinking-item flex min-w-0 px-2">
    <span className="truncate" title={summary}>{summary}</span>{duration === undefined ? null : <span className="shrink-0">{` · ${(duration / 1000).toFixed(2)} 秒`}</span>}
  </div>;
}
