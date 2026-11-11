import { describe, expect, it } from "vitest";
import { EventLogger, fromLogValue } from "./logging";
import { IncrementalActiveContext } from "./agent/context-choice";
import { runEvidence } from "./agent/goal-completion";
import { createMemoryEventStore } from "./memory-event-store";

describe("canonical event log", () => {
  it("keeps action attempts out of model context while replaying evidence across cursors and clears", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    const context = new IncrementalActiveContext(logger, "c");
    const initial = await context.read();
    await logger.append({ type: "automation.action.attempt", conversationId: "c", runId: "run", toolCallId: "click",
      content: { reason: "actionable", candidateCount: 1, candidates: [{ role: "button", name: "Submit", ref: "b" }] } });
    expect(await context.read()).toBe(initial);
    expect(await runEvidence(logger, "c", "run")).toEqual([]);
    await logger.append({ type: "tool.finished", conversationId: "c", runId: "run", toolCallId: "click",
      content: { toolName: "click" }, input: { target: { id: "b" } }, output: { ok: true } });
    const evidence = await runEvidence(logger, "c", "run");
    expect(evidence[0]?.receipt?.observedTargets).toMatchObject([{ role: "button", name: "Submit", ref: "b" }]);
    expect(await runEvidence(new EventLogger({ store }), "c", "run")).toEqual(evidence);
    expect((await context.read()).events.map(event => event.type)).toEqual(["tool.finished"]);
    await new EventLogger({ store }).clear();
    expect(await runEvidence(logger, "c", "run")).toEqual([]);
    expect((await context.read()).events).toEqual([]);
    await expect(logger.evidenceProjectionEvents("c", -2)).rejects.toThrow("cursor");
  });
  it("atomically links a durable job result and respects state and clear epochs", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    const state = await logger.append({
      type: "browser.job.state",
      conversationId: "c",
      content: { jobId: "j", state: "running" },
    });
    const epoch = await logger.canonicalEpoch();
    const input = {
      artifact: {
        type: "tool.result.data",
        conversationId: "c",
        output: { result: [1, 2, 3] },
      },
      terminal: {
        type: "browser.job.state",
        conversationId: "c",
        content: { jobId: "j", state: "completed" },
      },
      link: "resultArtifactId" as const,
      expectedEpoch: epoch,
      expectedJobStateId: state!.id,
    };
    const pair = await logger.appendArtifactAnd(input);
    expect(pair).toBeDefined();
    expect(
      fromLogValue(pair!.terminal.content, pair!.terminal.valueEncoding),
    ).toEqual({
      jobId: "j",
      state: "completed",
      resultArtifactId: pair!.artifact.id,
    });
    expect(
      await logger.result(pair!.artifact.id, { path: ["result", 1] }, "c"),
    ).toBe(2);
    const count = (await store.all()).length;
    expect(await logger.appendArtifactAnd(input)).toBeUndefined();
    expect((await store.all()).length).toBe(count);
    await logger.clear();
    expect(await logger.appendArtifactAnd(input)).toBeUndefined();
    await expect(logger.result(pair!.artifact.id, {}, "c")).rejects.toThrow(
      "unavailable",
    );
  });
  it("serializes terminal writes from independent owners and recovery writers", async () => {
    const store = createMemoryEventStore();
    const owner = new EventLogger({ store });
    const recovery = new EventLogger({ store });
    await owner.append({
      type: "conversation.submitted",
      runId: "run",
      conversationId: "one",
    });
    for (const id of ["a", "b"])
      await owner.append({
        type: "tool.started",
        runId: "run",
        conversationId: "one",
        toolCallId: id,
        content: { callId: "call" },
      });
    await Promise.all([
      owner.closePendingTools("run", "one", "pagehide"),
      recovery.recoverDanglingRuns(),
    ]);
    await owner.append({
      type: "conversation.aborted",
      runId: "run",
      conversationId: "one",
      abort: { reason: "pagehide" },
    });
    const terminals = (await store.all()).filter((event) =>
      ["tool.finished", "tool.failed"].includes(event.type),
    );
    expect(terminals.map((event) => event.toolCallId).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(
      (await store.all()).filter((event) =>
        [
          "conversation.finished",
          "conversation.failed",
          "conversation.aborted",
        ].includes(event.type),
      ),
    ).toHaveLength(1);
  });

  it("closes pending tools with their original phase IDs and remains idempotent after recovery", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    logger.setRunPhase("run", 0);
    await logger.append({
      type: "tool.started",
      runId: "run",
      conversationId: "one",
      toolCallId: "call",
      content: { callId: "phase0" },
    });
    logger.setRunPhase("run", 1);
    await logger.append({
      type: "tool.started",
      runId: "run",
      conversationId: "one",
      toolCallId: "call",
      content: { callId: "phase1" },
    });
    await logger.closePendingTools("run", "one", "request-failed");
    await logger.closePendingTools("run", "one", "request-failed");
    const failed = (await store.all()).filter(
      (event) => event.type === "tool.failed",
    );
    expect(failed.map((event) => event.toolCallId)).toEqual(["call", "1:call"]);
    expect(failed).toHaveLength(2);
  });

  it("does not accept late events after a session is stopped for clearing", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    logger.telemetry({ type: "sidepanel.closed", content: null });
    logger.stop();
    logger.telemetry({ type: "userscript.snapshot", content: { count: 1 } });
    await logger.flush();
    await logger.clear();
    expect((await store.all()).map(({ type }) => type)).toEqual([
      "sidepanel.closed",
      "log.cleared",
    ]);
  });
});
