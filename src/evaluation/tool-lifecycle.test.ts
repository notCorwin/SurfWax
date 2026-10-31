import { describe, expect, it } from "vitest";
import { completedProgramOperations, toolLifecycleEvidence } from "../../e2e/evaluation/tool-lifecycle";

const event = (type: string, toolCallId: string, runId = "run", conversationId = "conversation") => ({ type, toolCallId, runId, conversationId });

describe("evaluation tool lifecycle evidence", () => {
  it("accepts one result per executed tool, including failures and rejected invalid input", () => {
    expect(toolLifecycleEvidence([event("tool.started", "one"), event("tool.finished", "one"), event("tool.started", "two"), event("tool.failed", "two"), event("tool.failed", "invalid")])).toMatchObject({ complete: true, unstartedFailures: 1 });
  });

  it("rejects missing, duplicate and orphan successful results", () => {
    expect(toolLifecycleEvidence([event("tool.started", "one")])).toMatchObject({ complete: false, missingTerminals: 1 });
    expect(toolLifecycleEvidence([event("tool.started", "one"), event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: false, duplicateStarts: 1 });
    expect(toolLifecycleEvidence([event("tool.started", "one"), event("tool.finished", "one"), event("tool.failed", "one")])).toMatchObject({ complete: false, duplicateTerminals: 1 });
    expect(toolLifecycleEvidence([event("tool.started", "one"), event("tool.finished", "one"), event("tool.finished", "orphan")])).toMatchObject({ complete: false, orphanFinished: 1 });
    expect(toolLifecycleEvidence([event("tool.started", "one"), event("tool.finished", "one"), event("tool.failed", "invalid"), event("tool.failed", "invalid")])).toMatchObject({ complete: false, duplicateTerminals: 1 });
    expect(toolLifecycleEvidence([event("tool.failed", "one"), event("tool.started", "one")])).toMatchObject({ complete: false, startAfterTerminal: 1 });
  });

  it("separates runs and conversations and requires an identifiable executed tool", () => {
    expect(toolLifecycleEvidence([event("tool.started", "id", "a"), event("tool.finished", "id", "a"), event("tool.started", "id", "b"), event("tool.finished", "id", "b")]).complete).toBe(true);
    expect(toolLifecycleEvidence([event("tool.started", "id", "a", "one"), event("tool.finished", "id", "a", "two")]).complete).toBe(false);
    expect(toolLifecycleEvidence([event("tool.failed", "invalid")]).complete).toBe(false);
    expect(toolLifecycleEvidence([{ type: "tool.started", toolCallId: "id" }])).toMatchObject({ complete: false, invalidIdentities: 1 });
  });

  it("reports completed program operations without including their inputs or unfinished intents", () => {
    const summary = completedProgramOperations([
      { type: "browser.job.progress", content: { operation: "event.setFiles", state: "dispatched-unknown", secret: "ignored" } },
      { type: "browser.job.progress", content: { operation: "event.setFiles", state: "completed", secret: "ignored" } },
      { type: "browser.job.progress", content: { operation: "event.setFiles", state: "completed" } },
      { type: "browser.job.progress", content: { operation: "page.click", state: "failed" } },
    ]);
    expect(summary).toEqual({ "event.setFiles": 2 });
    expect(JSON.stringify(summary)).not.toContain("ignored");
  });
});
