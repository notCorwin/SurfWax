import { describe, expect, it } from "vitest";
import { deadlineEvidence } from "../../e2e/evaluation/deadline-evidence";

const event = (type: string, milliseconds: number, runId = "run") => ({ type, timestamp: new Date(milliseconds).toISOString(), runId, conversationId: "conversation" });
const started = 1_700_000_000_000, deadline = started + 1_000;

describe("evaluation deadline evidence", () => {
  it("uses the recorded terminal timestamp, including the exact deadline", () => {
    const submitted = event("conversation.submitted", started);
    expect(deadlineEvidence([submitted, event("conversation.finished", deadline)], started, deadline)).toMatchObject({ state: "on_time", terminal: "conversation.finished", logTerminalPresent: true });
    expect(deadlineEvidence([submitted, event("conversation.finished", deadline + 1)], started, deadline)).toMatchObject({ state: "late", terminal: "conversation.finished", logTerminalPresent: true });
  });
  it("does not confuse a different run's terminal with the active run", () => {
    expect(deadlineEvidence([event("conversation.submitted", started, "old"), event("conversation.finished", started + 1, "old"), event("conversation.submitted", started + 2, "new")], started, deadline)).toMatchObject({ state: "pending", logTerminalPresent: false });
  });
  it("keeps malformed, premature or conflicting terminal times unknown", () => {
    const submitted = event("conversation.submitted", started);
    expect(deadlineEvidence([submitted, { ...event("conversation.finished", started), timestamp: "invalid" }], started, deadline)).toMatchObject({ state: "unknown", logTerminalPresent: true });
    expect(deadlineEvidence([submitted, event("conversation.finished", started - 1)], started, deadline)).toMatchObject({ state: "unknown", logTerminalPresent: true });
    expect(deadlineEvidence([submitted, event("conversation.finished", started + 1), event("conversation.failed", started + 2)], started, deadline)).toMatchObject({ state: "unknown", logTerminalPresent: false });
    expect(deadlineEvidence([event("conversation.finished", started + 1)], started, deadline)).toMatchObject({ state: "unknown" });
  });
});
