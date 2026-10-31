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
