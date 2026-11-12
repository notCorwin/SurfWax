import { describe, expect, it, vi } from "vitest";
import { ConversationListProjection, EventLogger, fromLogValue } from "./logging";
import { IncrementalActiveContext } from "./agent/context-choice";
import { canAutoDispatchFollowup } from "./agent/followups";
import { runEvidence } from "./agent/goal-completion";
import { createMemoryEventStore } from "./memory-event-store";

describe("canonical event log", () => {
  it("preserves a manual title when a pending generated title arrives late", async () => {
    const logger = new EventLogger({ store: createMemoryEventStore() });
    await logger.append({ type: "conversation.created", conversationId: "c", content: null });
    await logger.append({ type: "conversation.title.updated", conversationId: "c", content: { title: "My title", source: "manual" } });
    await logger.append({ type: "model.title.finished", conversationId: "c", content: { title: "Generated" } });
    await logger.append({ type: "conversation.title.updated", conversationId: "c", content: { title: "Generated" } });
    const events = await logger.summaryEvents("c");
    const projection = new ConversationListProjection();
    expect(projection.reset(events)[0]?.title).toBe("My title");
    expect(projection.reset(events)[0]?.lastMessageAt).toBe(events[1]?.timestamp);
    projection.reset(events.slice(0, -1));
    const before = projection.snapshot()[0];
    projection.apply(events.at(-1)!);
    expect(projection.snapshot()[0]?.title).toBe("My title");
    expect(projection.snapshot()[0]?.lastMessageAt).toBe(before?.lastMessageAt);
    await logger.append({ type: "conversation.title.updated", conversationId: "c", content: { title: "Renamed", source: "manual" } });
    expect(projection.reset(await logger.summaryEvents("c"))[0]?.title).toBe("Renamed");
  });
  it("only dispatches queued messages after the latest run finishes successfully", async () => {
    const logger = new EventLogger({ store: createMemoryEventStore() });
    await logger.append({ type: "conversation.submitted", conversationId: "c", runId: "one", content: null });
    await logger.append({ type: "conversation.finished", conversationId: "c", runId: "one", content: null });
    expect(canAutoDispatchFollowup(await logger.followupEvents("c"))).toBe(true);
    await logger.append({ type: "conversation.submitted", conversationId: "c", runId: "two", content: null });
    expect(canAutoDispatchFollowup(await logger.followupEvents("c"))).toBe(false);
    await logger.append({ type: "conversation.finished", conversationId: "c", runId: "one", content: null });
    expect(canAutoDispatchFollowup(await logger.followupEvents("c"))).toBe(false);
    await logger.append({ type: "conversation.failed", conversationId: "c", runId: "two", content: null });
    expect(canAutoDispatchFollowup(await logger.followupEvents("c"))).toBe(false);
  });
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
  it("publishes complete message patches without post-commit reads and isolates notification errors", async () => {
    const memory = createMemoryEventStore();
    const get = vi.fn(async () => { throw new Error("unexpected read"); });
    const store = { ...memory, get };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = { addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => { throw new Error("private detail"); }, close: () => {} };
    const logger = new EventLogger({ store, channelFactory: () => channel });
    const published: unknown[] = [];
    logger.subscribe(event => { if (event.type === "conversation.message") published.push(fromLogValue(event.content, event.valueEncoding)); });
    const message = { id: "m", role: "user" as const, parts: [{ type: "text" as const, text: "first" }] };
    await logger.appendMessage("c", message);
    await logger.appendMessage("c", { ...message, parts: [{ type: "text", text: "second" }] });
    for (let i = 0; i < 50; i++) await logger.append({ type: "context.compaction.started", conversationId: "c" });
    expect(published).toEqual([message, { ...message, parts: [{ type: "text", text: "second" }] }]);
    expect((await memory.all()).filter(event => event.type === "conversation.message")[1]?.messagePatch).toBeDefined();
    expect(get).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private detail");
    warning.mockRestore();
  });

  it("serializes cross-writer clear after committed event publication", async () => {
    const memory = createMemoryEventStore();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let block = false;
    const firstStore = { ...memory, async appendMany(events: Parameters<typeof memory.appendMany>[0]) {
      if (block) { block = false; entered(); await gate; }
      return memory.appendMany(events);
    } };
    const old = new EventLogger({ store: firstStore });
    const clearer = new EventLogger({ store: { ...memory } });
    const order: string[] = [];
    old.subscribe(event => order.push(`old:${event.type}`));
    clearer.subscribe(event => order.push(`clear:${event.type}`));
    block = true;
    const pending = old.append({ type: "context.compaction.started", conversationId: "c" });
    await waiting;
    const clear = clearer.clear();
    release();
    await Promise.all([pending, clear]);
    expect(order).toEqual(["old:context.compaction.started", "clear:log.cleared"]);
    expect((await old.summaryEvents("c"))).toEqual([]);
  });

  it("ignores an old cross-context commit delivered after a clear", async () => {
    const store = createMemoryEventStore();
    let deliver!: (event: { data: unknown }) => void;
    const channel = { addEventListener: (_type: string, listener: typeof deliver) => { deliver = listener; }, removeEventListener: () => {}, postMessage: () => {}, close: () => {} };
    const logger = new EventLogger({ store, channelFactory: () => channel as unknown as BroadcastChannel });
    const commits = vi.fn(); logger.subscribeCommits(commits);
    deliver({ data: { writerId: "other", lastId: 10, types: ["log.cleared"], conversationIds: [], cleared: true } });
    deliver({ data: { writerId: "old", lastId: 9, types: ["context.compaction.started"], conversationIds: ["c"] } });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].cleared).toBe(true);
  });

  it("drops publication when maintenance changes generation during a commit", async () => {
    const memory = createMemoryEventStore();
    let release!: () => void, entered!: () => void, receive!: (message: any) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const store = { ...memory, async appendMany(events: Parameters<typeof memory.appendMany>[0]) { entered(); await gate; return memory.appendMany(events); } };
    const port = { onMessage: { addListener: (listener: typeof receive) => { receive = listener; } }, onDisconnect: { addListener: () => {} }, postMessage: () => {} } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store, writerPort: port });
    receive({ type: "writer-ready", generation: 1 });
    const listener = vi.fn(); const commit = vi.fn();
    logger.subscribe(listener); logger.subscribeCommits(commit);
    const pending = logger.append({ type: "context.compaction.started", conversationId: "c" });
    await waiting;
    receive({ type: "writer-ready", generation: 2, paused: true });
    release();
    expect(await pending).toBeDefined();
    expect(listener).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it("does not publish a commit after its logger is disposed", async () => {
    const memory = createMemoryEventStore();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const store = { ...memory, async appendMany(events: Parameters<typeof memory.appendMany>[0]) { entered(); await gate; return memory.appendMany(events); } };
    const logger = new EventLogger({ store });
    const listener = vi.fn(); logger.subscribe(listener);
    const pending = logger.append({ type: "context.compaction.started", conversationId: "c" });
    await waiting;
    const disposing = logger.dispose();
    release();
    expect(await pending).toBeDefined();
    await disposing;
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not report a receipt when the storage transaction fails", async () => {
    const memory = createMemoryEventStore();
    const store = { ...memory, async appendMany() { throw new Error("write failed"); } };
    const logger = new EventLogger({ store });
    await expect(logger.appendRunSubmission({ conversationId: "c", runId: "run", chatId: "c", messageId: "m",
      message: { id: "m", role: "user", parts: [{ type: "text", text: "hello" }] } })).rejects.toThrow("write failed");
    expect(await memory.all()).toEqual([]);
  });

  it("submits existing messages without duplicating them and dispatches a queued follow-up once", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    const message = { id: "m", role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] };
    await logger.appendMessage("c", message, { parentId: null });
    await logger.appendRunSubmission({ conversationId: "c", runId: "retry", chatId: "c", messageId: "m" });
    expect((await store.all()).filter(event => event.type === "conversation.message")).toHaveLength(1);
    await logger.append({ type: "conversation.followup.queued", conversationId: "c", content: { id: "f", text: "next" } });
    const followup = { conversationId: "c", runId: "next", chatId: "c", messageId: "n",
      message: { id: "n", role: "user" as const, parts: [{ type: "text" as const, text: "next" }] },
      parentId: "m", followup: { id: "f", mode: "followup" as const } };
    await logger.appendRunSubmission(followup);
    await expect(logger.appendRunSubmission({ ...followup, runId: "duplicate" })).rejects.toThrow();
    const events = await store.all();
    expect(events.filter(event => event.type === "conversation.followup.dispatched")).toHaveLength(1);
    expect(events.filter(event => event.type === "conversation.message")).toHaveLength(2);
    expect(events.filter(event => event.type === "conversation.submitted")).toHaveLength(2);
  });

  it("keeps a newer run active when recovery finishes an older run", async () => {
    const memory = createMemoryEventStore();
    let block = false;
    let reached!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = { ...memory, async all() {
      if (block) { block = false; reached(); await gate; }
      return memory.all();
    } };
    const owner = new EventLogger({ store });
    const recovery = new EventLogger({ store });
    await owner.append({ type: "conversation.created", conversationId: "c" });
    await owner.append({ type: "conversation.submitted", conversationId: "c", runId: "old" });
    await owner.append({ type: "tool.started", conversationId: "c", runId: "old", toolCallId: "tool" });
    const recovering = recovery.recoverDanglingRuns(async () => { block = true; return []; });
    await atBarrier;
    await owner.append({ type: "conversation.submitted", conversationId: "c", runId: "new" });
    release();
    await recovering;
    const events = await owner.summaryEvents("c");
    expect(events.some(event => event.type === "conversation.aborted" && event.runId === "old")).toBe(true);
    expect((await memory.all()).some(event => event.type === "tool.failed" && event.runId === "old")).toBe(true);
    const projection = new ConversationListProjection();
    for (const event of events) projection.apply(event);
    expect(projection.snapshot()[0]?.runStatus).toBe("running");
    expect(projection.reset(events)[0]?.runStatus).toBe("running");
    await owner.append({ type: "conversation.finished", conversationId: "c", runId: "new" });
    expect(projection.reset(await owner.summaryEvents("c"))[0]?.runStatus).toBe("idle");
  });

  it("handles legacy unknown run identities and creation resets consistently", async () => {
    const logger = new EventLogger({ store: createMemoryEventStore() });
    const emit = (type: string, runId?: string) => logger.append({ type, conversationId: "c", runId });
    const projection = new ConversationListProjection();
    const check = async (status: string) => {
      const events = await logger.summaryEvents("c");
      const incremental = new ConversationListProjection();
      for (const event of events) incremental.apply(event);
      expect(incremental.snapshot()[0]?.runStatus).toBe(status);
      expect(projection.reset(events)[0]?.runStatus).toBe(status);
    };
    await emit("conversation.created");
    await emit("conversation.failed", "orphan"); await check("interrupted");
    await emit("conversation.submitted");
    await emit("conversation.finished", "unrelated"); await check("running");
    await emit("conversation.finished"); await check("idle");
    await emit("conversation.submitted", "known");
    await emit("conversation.aborted"); await check("running");
    await emit("conversation.failed", "known"); await check("interrupted");
    await emit("conversation.created");
    await emit("conversation.finished", "orphan2"); await check("idle");
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
