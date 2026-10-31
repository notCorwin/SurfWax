import { describe, expect, it } from "vitest";
import { toLogValue } from "../logging";
import { completedProgramOperations, toolLifecycleEvidence } from "../../e2e/evaluation/tool-lifecycle";

const event = (type: string, toolCallId: string, runId = "run", conversationId = "conversation") => ({ type, toolCallId, runId, conversationId });
const tool = (toolCallId: string, type = "dynamic-tool") => ({ type, toolCallId, state: "input-available", toolName: "click", input: {} });
const message = (id: number, parts: unknown[], runId = "run", conversationId = "conversation", messageId = "assistant") => ({
  id, type: "conversation.message", conversationId, runId, valueEncoding: 5,
  content: toLogValue({ id: messageId, role: "assistant", parts }, undefined, 5),
});

describe("evaluation tool lifecycle evidence", () => {
  it("accepts one result per declared tool, including failures and rejected invalid input", () => {
    expect(toolLifecycleEvidence([message(1, [tool("one"), tool("two"), tool("invalid")]), event("tool.started", "one"), event("tool.finished", "one"), event("tool.started", "two"), event("tool.failed", "two"), event("tool.failed", "invalid")])).toMatchObject({ complete: true, declaredCalls: 3, unstartedFailures: 1 });
  });

  it("rejects a declared call that never started and never produced a terminal, even when another tool succeeded", () => {
    expect(toolLifecycleEvidence([message(1, [tool("one"), tool("lost")]), event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: false, declaredCalls: 2, missingDeclaredTerminals: 1 });
  });

  it("rejects missing, duplicate and orphan successful results", () => {
    const snapshot = message(1, [tool("one")]);
    expect(toolLifecycleEvidence([snapshot, event("tool.started", "one")])).toMatchObject({ complete: false, missingTerminals: 1, missingDeclaredTerminals: 1 });
    expect(toolLifecycleEvidence([snapshot, event("tool.started", "one"), event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: false, duplicateStarts: 1 });
    expect(toolLifecycleEvidence([snapshot, event("tool.started", "one"), event("tool.finished", "one"), event("tool.failed", "one")])).toMatchObject({ complete: false, duplicateTerminals: 1 });
    expect(toolLifecycleEvidence([snapshot, event("tool.started", "one"), event("tool.finished", "one"), event("tool.finished", "orphan")])).toMatchObject({ complete: false, orphanFinished: 1 });
    expect(toolLifecycleEvidence([snapshot, event("tool.started", "one"), event("tool.finished", "one"), event("tool.failed", "invalid"), event("tool.failed", "invalid")])).toMatchObject({ complete: false, duplicateTerminals: 1 });
    expect(toolLifecycleEvidence([snapshot, event("tool.failed", "one"), event("tool.started", "one")])).toMatchObject({ complete: false, startAfterTerminal: 1 });
  });

  it("uses only the newest snapshot of each message, regardless of input ordering", () => {
    const old = message(10, [tool("one"), tool("stale")]);
    const latest = message(11, [tool("one")]);
    expect(toolLifecycleEvidence([latest, old, event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: true, declaredCalls: 1, missingDeclaredTerminals: 0 });
    expect(toolLifecycleEvidence([message(1, [tool("one")]), message(2, [tool("one"), tool("one")]), event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: false, duplicateDeclaredCalls: 1 });
    // A stale snapshot's payload need not be decoded to identify the latest one.
    const staleCorrupt = { id: 3, type: "conversation.message", conversationId: "conversation", runId: "run", valueEncoding: 5,
      content: { id: "assistant", role: "assistant", parts: { $type: "escaped-object", entries: "invalid" } } };
    expect(toolLifecycleEvidence([staleCorrupt, message(4, [tool("one")]), event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: true, invalidMessages: 0 });
    expect(toolLifecycleEvidence([message(4, [tool("one")]), { ...staleCorrupt, id: 5 }, event("tool.started", "one"), event("tool.finished", "one")])).toMatchObject({ complete: null, invalidMessages: 1 });
  });

  it("decodes canonical escaped objects and tracks phase-qualified IDs and distinct runs", () => {
    const escaped = { id: 1, type: "conversation.message", conversationId: "conversation", runId: "a", valueEncoding: 5,
      content: toLogValue({ $type: "object-graph", id: "assistant", role: "assistant", parts: [tool("id"), tool("1:id")] }, undefined, 5) };
    expect(toolLifecycleEvidence([escaped, event("tool.started", "id", "a"), event("tool.finished", "id", "a"), event("tool.started", "1:id", "a"), event("tool.finished", "1:id", "a"),
      message(2, [tool("id", "tool-click")], "b"), event("tool.started", "id", "b"), event("tool.finished", "id", "b")])).toMatchObject({ complete: true, declaredCalls: 3 });
    expect(toolLifecycleEvidence([message(1, [tool("id")], "a", "one"), event("tool.started", "id", "a", "one"), event("tool.finished", "id", "a", "two")])).toMatchObject({ complete: false, missingDeclaredTerminals: 1 });
  });

  it("reports unknown when assistant snapshots are missing, malformed or undecodable", () => {
    const executed = [event("tool.started", "one"), event("tool.finished", "one")];
    expect(toolLifecycleEvidence(executed)).toMatchObject({ complete: null, missingAssistantRuns: 1, unreferencedStarts: 1 });
    const corrupt = { id: 1, type: "conversation.message", conversationId: "conversation", runId: "run", valueEncoding: 5, content: { $type: "escaped-object", entries: "invalid" } };
    expect(toolLifecycleEvidence([corrupt, ...executed])).toMatchObject({ complete: null, invalidMessages: 1 });
    expect(toolLifecycleEvidence([message(1, [], "other"), ...executed])).toMatchObject({ complete: null, missingAssistantRuns: 1 });
    expect(toolLifecycleEvidence([message(1, []), ...executed])).toMatchObject({ complete: null, unreferencedStarts: 1 });
    expect(toolLifecycleEvidence([{ type: "tool.started", toolCallId: "id" }])).toMatchObject({ complete: false, invalidIdentities: 1 });
    expect(toolLifecycleEvidence([event("tool.failed", "invalid")])).toMatchObject({ complete: false });
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
