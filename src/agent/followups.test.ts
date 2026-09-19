import { describe, expect, it } from "vitest";
import { toLogValue, type LogEvent } from "../logging";
import { canAutoDispatchFollowup, rebuildFollowups } from "./followups";

const event = (id: number, type: string, content: unknown = null): LogEvent => ({
  id,
  type,
  timestamp: new Date(id * 1_000).toISOString(),
  content: toLogValue(content),
});

describe("follow-up event projection", () => {
  it("rebuilds FIFO pending messages and ignores duplicate terminal events", () => {
    expect(rebuildFollowups([
      event(1, "conversation.followup.queued", { id: "one", text: "first", createdAt: "2026-01-01T00:00:00Z" }),
      event(2, "conversation.followup.queued", { id: "two", text: "second", createdAt: "2026-01-01T00:00:01Z" }),
      event(3, "conversation.followup.dispatched", { id: "one", mode: "followup" }),
      event(4, "conversation.followup.dispatched", { id: "one", mode: "followup" }),
      event(5, "conversation.followup.queued", { id: "three", text: "third", createdAt: "2026-01-01T00:00:02Z" }),
      event(6, "conversation.followup.removed", { id: "three" }),
    ])).toEqual([{ id: "two", text: "second", createdAt: "2026-01-01T00:00:01Z" }]);
  });

  it("only auto-dispatches after a successfully finished run", () => {
    expect(canAutoDispatchFollowup([event(1, "conversation.finished")])).toBe(true);
    expect(canAutoDispatchFollowup([event(1, "conversation.finished"), event(2, "conversation.aborted")])).toBe(false);
    expect(canAutoDispatchFollowup([event(1, "conversation.failed")])).toBe(false);
    expect(canAutoDispatchFollowup([])).toBe(false);
  });
});
