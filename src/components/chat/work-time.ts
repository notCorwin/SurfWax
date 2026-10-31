import type { LogEvent } from "../../logging";

/** Match terminal runs by identity even if an interrupted terminal has no message ID. */
export function completedWork(events: readonly LogEvent[]): Map<string, number | null> {
  const started = new Map<string, number>();
  const completed = new Map<string, number | null>();
  for (const event of events) {
    if (!event.runId) continue;
    if (event.type === "conversation.submitted") started.set(event.runId, Date.parse(event.timestamp));
    if (!["conversation.finished", "conversation.failed", "conversation.aborted"].includes(event.type)) continue;
    // Recovery writes a null-content abort after reconnecting; that timestamp
    // does not establish when the work actually stopped.
    if (event.type === "conversation.aborted" && event.content == null) { completed.set(event.runId, null); continue; }
    const start = started.get(event.runId);
    const end = Date.parse(event.timestamp);
    if (start !== undefined && Number.isFinite(start) && Number.isFinite(end)) {
      completed.set(event.runId, Math.max(0, Math.floor((end - start) / 1000)));
    }
  }
  return completed;
}

export function workLabel(seconds: number): string {
  const units = [["年", 365 * 24 * 60 * 60], ["天", 24 * 60 * 60], ["小时", 60 * 60], ["分钟", 60], ["秒", 1]] as const;
  const first = units.findIndex(([, size]) => seconds >= size);
  if (first < 0) return "工作了 0 秒";
  const [name, size] = units[first]!;
  const leading = `${Math.floor(seconds / size)} ${first === 3 ? "分" : name}`;
  if (first === units.length - 1) return `工作了 ${leading}`;
  const [nextName, nextSize] = units[first + 1]!;
  return `工作了 ${leading} ${Math.floor((seconds % size) / nextSize)} ${nextName}`;
}
