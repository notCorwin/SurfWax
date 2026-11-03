import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/logging";
import { updateWaitingPhase } from "./waiting-status";

const event = (id: number, type: string, runId = "run", timestamp = "2026-01-01T00:00:00.000Z"): LogEvent =>
  ({ id, type, runId, conversationId: "conversation", timestamp, content: null });

describe("waiting status projection", () => {
  it("follows observed preparation, provider, results and terminal events", () => {
    let phase = updateWaitingPhase(undefined, event(1, "conversation.submitted"));
    expect(phase?.phase).toBe("starting");
    phase = updateWaitingPhase(phase, event(2, "model.context.preparing"));
    expect(phase?.phase).toBe("preparing");
    phase = updateWaitingPhase(phase, event(3, "context.compaction.started"));
    expect(phase?.phase).toBe("compacting");
    phase = updateWaitingPhase(phase, event(4, "model.request.started"));
    expect(phase?.phase).toBe("provider");
    // A generic HTTP event may belong to another request and is not evidence of streaming.
    expect(updateWaitingPhase(phase, event(5, "request.completed"))).toBe(phase);
    phase = updateWaitingPhase(phase, event(6, "model.response.received"));
    expect(phase?.phase).toBe("processing");
    phase = updateWaitingPhase(phase, event(7, "conversation.finished"));
    expect(phase?.phase).toBe("terminal");
    expect(updateWaitingPhase(phase, event(8, "model.response.received"))).toBe(phase);
  });

  it("keeps the phase clock on duplicate signals and rejects unrelated or stale events", () => {
    const initial = updateWaitingPhase(undefined, event(10, "model.request.started"));
    const repeated = updateWaitingPhase(initial, event(11, "model.request.started", "run", "2026-01-01T00:00:10.000Z"));
    expect(repeated?.startedAt).toBe(initial?.startedAt);
    expect(updateWaitingPhase(repeated, event(12, "model.response.received", "other"))).toBe(repeated);
    expect(updateWaitingPhase(repeated, event(9, "model.response.received"))).toBe(repeated);
    expect(updateWaitingPhase(repeated, event(13, "conversation.submitted", "other"))?.runId).toBe("other");
  });

  it("does not invent a clock for an invalid timestamp", () => {
    expect(updateWaitingPhase(undefined, event(1, "model.request.started", "run", "invalid"))?.startedAt).toBeUndefined();
  });
});

it("retains completed waits in chronological order when tool execution starts", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useWaitingActivity } = await import("./waiting-status");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let notify!: (entry: LogEvent) => void;
  const logger = { subscribe: (listener: typeof notify) => { notify = listener; return () => {}; } } as unknown as import("@/logging").EventLogger;
  let activities: ReturnType<typeof useWaitingActivity> = [];
  function Probe({ afterActivityId, toolsRunning = false, running = true }: { afterActivityId: string; toolsRunning?: boolean; running?: boolean }) {
    activities = useWaitingActivity({ logger, conversationId: "conversation", running, stopping: false, toolsRunning, afterActivityId });
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(() => root.render(createElement(Probe, { afterActivityId: "tool-1" })));
    await act(() => notify(event(1, "model.request.started")));
    await act(() => notify(event(2, "model.response.received", "run", "2026-01-01T00:00:01.000Z")));
    await act(() => root.render(createElement(Probe, { afterActivityId: "tool-2", toolsRunning: true })));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ afterId: "tool-1", label: "等待响应完成", endedAt: Date.parse("2026-01-01T00:00:01.000Z") });
    await act(() => notify(event(3, "model.request.started")));
    expect(activities.map((entry) => entry.afterId)).toEqual(["tool-1", "tool-2"]);
    await act(() => notify(event(4, "model.request.started", "other")));
    expect(activities).toHaveLength(2);
    await act(() => root.render(createElement(Probe, { afterActivityId: "next", running: false })));
    expect(activities).toHaveLength(0);
    await act(() => root.render(createElement(Probe, { afterActivityId: "next" })));
    await act(() => notify(event(5, "model.request.started", "next-run")));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.id).toContain("next-run");
    await act(() => notify(event(6, "model.request.retrying", "next-run")));
    expect(activities[0]?.label).toBe("等待响应失败");
    expect(activities[0]?.endedAt).toBeDefined();
    expect(activities.at(-1)?.label).toBe("正在重试推理请求");
    await act(() => notify(event(7, "model.request.started", "next-run")));
    expect(activities.filter((item) => item.endedAt === undefined)).toHaveLength(1);
    await act(() => notify(event(8, "model.response.received", "next-run")));
    await act(() => notify(event(9, "context.compaction.started", "next-run")));
    expect(activities.at(-1)?.label).toBe("正在压缩上下文");
  } finally { await act(() => root.unmount()); }
});
