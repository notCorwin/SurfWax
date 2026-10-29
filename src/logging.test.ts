import { describe, expect, it, vi } from "vitest";
import { EventLogger, fromLogValue, rebuildConversation, stringifyLogSafe, toLogValue, upgradeEventStore, type LogEvent } from "./logging";

function memoryStore(onBatch?: (size: number) => void) {
  const events: LogEvent[] = [];
  let nextId = 1;
  const append = async (event: Omit<LogEvent, "id">) => {
    const stored = { ...event, id: nextId++ };
    events.push(stored);
    return stored;
  };
  return {
    append,
    async appendMany(batch: readonly Omit<LogEvent, "id">[]) {
      onBatch?.(batch.length);
      return Promise.all(batch.map(append));
    },
    async all() { return [...events]; },
    async latestByType(type: string) { return [...events].reverse().find((event) => event.type === type); },
    async byTypes(types: readonly string[], conversationId?: string) {
      return events.filter((event) => types.includes(event.type) && (!conversationId || event.conversationId === conversationId));
    },
    async byRunTypes(runIds: readonly string[], types: readonly string[]) {
      return events.filter((event) => event.runId && runIds.includes(event.runId) && types.includes(event.type));
    },
    async conversation(conversationId: string) { return events.filter((event) => event.conversationId === conversationId); },
    async deleteConversation(conversationId: string) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]!.conversationId === conversationId) events.splice(index, 1);
      }
    },
    async clear() { events.length = 0; },
  };
}

describe("canonical event log", () => {
  it("does not restore a started tool after another logger clears its snapshot", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call", content: { toolName: "click" } });
    const original = (first as any).artifactForCall.bind(first);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(first as any, "artifactForCall").mockImplementation(async (...args: any[]) => { reached(); await gate; return original(...args); });
    const recovering = first.closePendingTools("run", "c", "interrupted");
    await ready;
    await second.clear();
    release();
    await recovering;
    expect(await second.conversation("c")).toEqual([]);
    expect((await store.all()).map((event) => event.type)).toEqual(["tool.started", "log.cleared"]);
  });

  it("does not restore pending message tool calls after their epoch is cleared", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.appendMessage("c", { id: "a", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "click", toolCallId: "call", state: "input-available", input: {} }] }, { runId: "run" });
    const original = first.appendIfEpoch.bind(first);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(first, "appendIfEpoch").mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
    const recovering = first.closePendingTools("run", "c", "interrupted");
    await ready;
    await second.clear();
    release();
    await recovering;
    expect(await second.conversation("c")).toEqual([]);
    expect((await store.all()).map((event) => event.type)).toEqual(["conversation.message", "log.cleared"]);
  });

  it("stops restoring remaining tools if clear happens between terminal results", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    for (const toolCallId of ["one", "two"]) await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId });
    const original = first.appendIfEpoch.bind(first);
    let reached!: () => void, release!: () => void, calls = 0;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(first, "appendIfEpoch").mockImplementation(async (...args) => { if (++calls === 2) { reached(); await gate; } return original(...args); });
    const recovering = first.closePendingTools("run", "c", "interrupted");
    await ready;
    await second.clear();
    release();
    await recovering;
    const events = await store.all();
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.started", "tool.failed", "log.cleared"]);
    expect(await second.conversation("c")).toEqual([]);
  });

  it("does not resurrect a dangling run when clear occurs while checking its owner", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "conversation.submitted", conversationId: "c", runId: "run" });
    await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call" });
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recovering = first.recoverDanglingRuns(async () => { reached(); await gate; return []; });
    await ready;
    await second.clear();
    release();
    await recovering;
    expect((await store.all()).map((event) => event.type)).toEqual(["conversation.submitted", "tool.started", "log.cleared"]);
  });

  it("serializes a conditional terminal append with cross-logger clear", async () => {
    const base = memoryStore();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = { ...base, async appendMany(batch: readonly Omit<LogEvent, "id">[]) {
      if (batch.some((event) => event.type === "tool.failed")) { reached(); await gate; }
      return base.appendMany(batch);
    } };
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call" });
    const recovering = first.closePendingTools("run", "c", "interrupted");
    await ready;
    let cleared = false;
    const clearing = second.clear().then(() => { cleared = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleared).toBe(false);
    release();
    await Promise.all([recovering, clearing]);
    expect((await store.all()).map((event) => event.type)).toEqual(["tool.started", "tool.failed", "log.cleared"]);
    expect(await second.conversation("c")).toEqual([]);
  });

  it("does not deduplicate a new terminal against an old one before the clear marker", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await logger.append({ type: "tool.failed", conversationId: "c", runId: "run", toolCallId: "call", output: "old" });
    await logger.clear();
    await logger.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call" });
    await logger.closePendingTools("run", "c", "interrupted");
    expect((await logger.conversation("c")).map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
  });
  it("invalidates every canonical projection when a different logger clears the store", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "conversation.created", conversationId: "c", content: { title: "old" } });
    await first.appendMessage("c", { id: "old-message", role: "user", parts: [{ type: "text", text: "old" }] });
    await first.append({ type: "conversation.submitted", conversationId: "c", runId: "run" });
    await first.append({ type: "conversation.failed", conversationId: "c", runId: "run" });
    await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call" });
    const artifact = await first.append({ type: "tool.result.data", conversationId: "c", runId: "run", toolCallId: "call", content: { filename: "old.txt" }, output: "old" });
    expect(await first.summaryEvents("c")).not.toEqual([]);
    expect((await first.repository("c")).messages).toHaveLength(1);
    expect(await first.result(artifact!.id, {}, "c")).toBe("old");
    await second.clear();
    expect(await first.summaryEvents("c")).toEqual([]);
    expect((await first.repository("c")).messages).toEqual([]);
    expect(await first.conversation("c")).toEqual([]);
    expect(await first.restorationEvents("c")).toEqual([]);
    expect(await first.toolArtifact("c", { runId: "run", toolCallId: "call" })).toBeUndefined();
    await expect(first.result(artifact!.id, {}, "c")).rejects.toThrow("unavailable");
  });

  it.each(["eventsByTypes", "conversation", "result", "restorationEvents", "toolArtifact"] as const)("retries %s when clear commits during its store read", async (kind) => {
    const base = memoryStore();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false, armed = false;
    const delayOnce = async <T>(value: T): Promise<T> => {
      if (!blocked) { blocked = true; reached(); await gate; }
      return value;
    };
    const store = {
      ...base,
      async byTypes(types: readonly string[], conversationId?: string) {
        const value = await base.byTypes(types, conversationId);
        return armed && kind === "eventsByTypes" && types.includes("conversation.created") ? delayOnce(value) : value;
      },
      async byRunTypes(runIds: readonly string[], types: readonly string[]) {
        const value = await base.byRunTypes(runIds, types);
        return armed && (kind === "restorationEvents" || kind === "toolArtifact") ? delayOnce(value) : value;
      },
      async conversation(conversationId: string) {
        const value = await base.conversation(conversationId);
        return armed && kind === "conversation" ? delayOnce(value) : value;
      },
      async get(id: number) {
        const value = (await base.all()).find((event) => event.id === id);
        return armed && kind === "result" ? delayOnce(value) : value;
      },
    };
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "conversation.created", conversationId: "c" });
    await first.append({ type: "conversation.submitted", conversationId: "c", runId: "run" });
    await first.append({ type: "conversation.failed", conversationId: "c", runId: "run" });
    await first.append({ type: "tool.started", conversationId: "c", runId: "run", toolCallId: "call" });
    const artifact = await first.append({ type: "tool.result.data", conversationId: "c", runId: "run", toolCallId: "call", content: { filename: "old.txt" }, output: "old" });
    armed = true;
    const reading = kind === "eventsByTypes" ? first.summaryEvents("c")
      : kind === "conversation" ? first.conversation("c")
      : kind === "result" ? first.result(artifact!.id, {}, "c")
      : kind === "restorationEvents" ? first.restorationEvents("c")
      : first.toolArtifact("c", { runId: "run", toolCallId: "call" });
    await ready;
    await second.clear();
    release();
    if (kind === "result") await expect(reading).rejects.toThrow("unavailable");
    else if (kind === "toolArtifact") await expect(reading).resolves.toBeUndefined();
    else await expect(reading).resolves.toEqual([]);
  });

  it("does not return a pre-clear artifact referenced by a post-clear tool call", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "c", content: { filename: "old.txt" }, output: "old" });
    await logger.clear();
    await logger.append({ type: "tool.started", conversationId: "c", runId: "new", toolCallId: "call" });
    await logger.append({ type: "browser.artifact.used", conversationId: "c", runId: "new", toolCallId: "call", content: { artifactId: artifact!.id } });
    expect(await logger.toolArtifact("c", { runId: "new", toolCallId: "call" })).toBeUndefined();
  });
  it("refuses job-state writes and clearing in an extension without Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("chrome", { runtime: { id: "extension" } });
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await expect(logger.append({ type: "browser.job.state", conversationId: "c", content: { jobId: "j", state: "running" } })).rejects.toThrow("Web Locks are required");
    await expect(new EventLogger({ store }).clear()).rejects.toThrow("Web Locks are required");
    expect(await store.all()).toEqual([]);
  });
  it("invalidates job snapshots when another logger clears the shared store", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    const saved = await first.append({ type: "browser.job.state", conversationId: "c", content: { jobId: "j", state: "running" } });
    const before = await first.jobEventsSince("c", -1);
    expect(before.events).toHaveLength(1);
    await second.clear();
    const after = await first.jobEventsSince("c", -1);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.events).toEqual([]);
    expect(await first.jobEventsByIds("c", [saved!.id], before.epoch)).toBeNull();
  });
  it("returns diagnostic snapshots and their canonical epoch consistently across another writer's clear", async () => {
    const store = memoryStore();
    const first = new EventLogger({ store });
    const second = new EventLogger({ store });
    await first.append({ type: "browser.diagnostic", conversationId: "c", content: { revision: 1 } });
    const before = await first.diagnosticEventsSnapshot("c");
    expect(before.value).toHaveLength(1);
    expect(await first.canonicalEpoch()).toBe(before.epoch);
    await second.clear();
    const after = await first.diagnosticEventsSnapshot("c");
    expect(after.value).toEqual([]);
    expect(after.epoch).not.toBe(before.epoch);
    expect(await first.canonicalEpoch()).toBe(after.epoch);
  });
  it("settles the writer handshake and refuses queued writes when background initialization fails", async () => {
    const store = memoryStore();
    const onError = vi.fn();
    let receive!: (message: any) => void;
    const port = { onMessage: { addListener(listener: (message: any) => void) { receive = listener; } },
      onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store, writerPort: port, onError });
    const first = logger.append({ type: "conversation.created", conversationId: "pending" });
    const flushing = logger.flush();
    receive({ type: "writer-error", error: "后台初始化失败，请重新加载扩展后重试：IndexedDB unavailable" });
    await expect(flushing).resolves.toBeUndefined();
    await expect(first).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "后台初始化失败，请重新加载扩展后重试：IndexedDB unavailable" }));
    expect(await logger.append({ type: "conversation.submitted", runId: "new" })).toBeUndefined();
    expect(await store.all()).toEqual([]);
  });
  it("reports a disconnected writer so the UI can reload before accepting another task", async () => {
    const store = memoryStore();
    const onError = vi.fn();
    let disconnect!: () => void;
    let receive!: (message: any) => void;
    const port = { onMessage: { addListener(listener: (message: any) => void) { receive = listener; } },
      onDisconnect: { addListener(listener: () => void) { disconnect = listener; } }, postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store, writerPort: port, onError });
    receive({ type: "writer-ready", paused: false, generation: 0 });
    disconnect();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "后台日志连接已断开，请重新加载侧栏。" }));
    expect(await logger.append({ type: "conversation.submitted", conversationId: "one", runId: "new" })).toBeUndefined();
    expect(await store.all()).toEqual([]);
  });
  it("serializes terminal writes from independent owners and recovery writers", async () => {
    const store = memoryStore();
    const owner = new EventLogger({ store });
    const recovery = new EventLogger({ store });
    await owner.append({ type: "conversation.submitted", runId: "run", conversationId: "one" });
    for (const id of ["a", "b"]) await owner.append({ type: "tool.started", runId: "run", conversationId: "one", toolCallId: id, content: { callId: "call" } });
    await Promise.all([owner.closePendingTools("run", "one", "pagehide"), recovery.recoverDanglingRuns()]);
    await owner.append({ type: "conversation.aborted", runId: "run", conversationId: "one", abort: { reason: "pagehide" } });
    const terminals = (await store.all()).filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    expect(terminals.map((event) => event.toolCallId).sort()).toEqual(["a", "b"]);
    expect((await store.all()).filter((event) => ["conversation.finished", "conversation.failed", "conversation.aborted"].includes(event.type))).toHaveLength(1);
  });

  it("keeps the first durable terminal and distinguishes separate model calls", async () => {
    const store = memoryStore();
    const owner = new EventLogger({ store });
    const recovery = new EventLogger({ store });
    const observed = vi.fn();
    recovery.subscribe(observed);
    const first = await owner.append({ type: "tool.finished", runId: "run", toolCallId: "tool", content: { callId: "a" }, output: { ok: true } });
    const duplicate = await recovery.append({ type: "tool.failed", runId: "run", toolCallId: "tool", content: { callId: "a" }, error: "late callback" });
    await recovery.append({ type: "tool.failed", runId: "run", toolCallId: "tool", content: { callId: "b" }, error: "different call" });
    expect(duplicate).toEqual(first);
    expect(observed).toHaveBeenCalledOnce();
    expect((await store.all()).map((event) => event.type)).toEqual(["tool.finished", "tool.failed"]);
  });

  it("keeps late SDK callbacks in their original run phase after recovery and lease release", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    logger.beginRun("one", "run");
    logger.setRunPhase("run", 0);
    await logger.append({ type: "tool.started", conversationId: "one", toolCallId: "tool", content: { callId: "old" } });
    await logger.closePendingTools("run", "one", "request-failed");
    logger.setRunPhase("run", 1);
    await logger.append({ type: "tool.started", conversationId: "one", toolCallId: "tool", content: { callId: "new" } });
    await logger.closePendingTools("run", "one", "user-stopped");
    logger.endRun("one", "run");
    logger.beginRun("one", "next-run");
    logger.setRunPhase("next-run", 0);
    await logger.append({ type: "tool.finished", conversationId: "one", toolCallId: "tool", content: { callId: "old" }, output: { ok: true } });
    await logger.append({ type: "tool.finished", conversationId: "one", toolCallId: "tool", content: { callId: "new" }, output: { ok: true } });
    const terminals = (await store.all()).filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    expect(terminals.map((event) => [event.runId, event.toolCallId, event.type])).toEqual([["run", "tool", "tool.failed"], ["run", "1:tool", "tool.failed"]]);
  });
  it("keeps the first accepted write when a new writer joins a later maintenance generation", async () => {
    const store = memoryStore();
    let receive!: (message: any) => void;
    const port = { onMessage: { addListener(listener: (message: any) => void) { receive = listener; } },
      onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store, writerPort: port });
    const first = logger.append({ type: "conversation.created", conversationId: "new" });
    receive({ type: "writer-ready", paused: false, generation: 4 });
    expect((await first)?.type).toBe("conversation.created");
    expect(await store.all()).toHaveLength(1);
  });

  it("discards pre-handshake writes from a writer joining while the log is being cleared", async () => {
    const store = memoryStore();
    let receive!: (message: any) => void;
    const port = { onMessage: { addListener(listener: (message: any) => void) { receive = listener; } },
      onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store, writerPort: port });
    const first = logger.append({ type: "conversation.created", conversationId: "late" });
    receive({ type: "writer-ready", paused: true, generation: 4 });
    expect(await first).toBeUndefined();
    expect(await store.all()).toHaveLength(0);
    expect(await logger.append({ type: "late.callback" })).toBeUndefined();
  });

  it("closes pending tools with their original phase IDs and remains idempotent after recovery", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    logger.setRunPhase("run", 0);
    await logger.append({ type: "tool.started", runId: "run", conversationId: "one", toolCallId: "call", content: { callId: "phase0" } });
    logger.setRunPhase("run", 1);
    await logger.append({ type: "tool.started", runId: "run", conversationId: "one", toolCallId: "call", content: { callId: "phase1" } });
    await logger.closePendingTools("run", "one", "request-failed");
    await logger.closePendingTools("run", "one", "request-failed");
    const failed = (await store.all()).filter((event) => event.type === "tool.failed");
    expect(failed.map((event) => event.toolCallId)).toEqual(["call", "1:call"]);
    expect(failed).toHaveLength(2);
  });

  it("upgrades the existing event store without deleting legacy records", () => {
    const legacyRecords = [{ id: 1, type: "legacy" }];
    const createIndex = vi.fn();
    const deleteIndex = vi.fn();
    const existing = new Set(["typeId", "conversationTypeId", "runTypeId", "conversationIdId"]);
    const store = { indexNames: { contains: (name: string) => existing.has(name) }, createIndex, deleteIndex };
    const db = {
      objectStoreNames: { contains: (name: string) => name === "events" },
      createObjectStore: vi.fn(),
      deleteObjectStore: vi.fn(() => { legacyRecords.length = 0; }),
    };
    const transaction = { objectStore: vi.fn(() => store) };

    upgradeEventStore(db as unknown as IDBDatabase, transaction as unknown as IDBTransaction);

    expect(transaction.objectStore).toHaveBeenCalledWith("events");
    expect(db.createObjectStore).toHaveBeenCalledWith("diagnosticCaptureIndex");
    expect(createIndex).toHaveBeenCalledWith("conversationId", "conversationId");
    expect(createIndex).toHaveBeenCalledWith("type", "type");
    expect(createIndex).toHaveBeenCalledWith("conversationType", ["conversationId", "type"]);
    expect(createIndex).toHaveBeenCalledWith("runType", ["runId", "type"]);
    expect(deleteIndex.mock.calls.map(([name]) => name)).toEqual(["typeId", "conversationTypeId", "runTypeId", "conversationIdId"]);
    expect(db.deleteObjectStore).not.toHaveBeenCalled();
    expect(legacyRecords).toHaveLength(1);
  });

  it("writes required fields in order without redacting content", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await logger.append({
      type: "tool.finished",
      toolCallId: "call-1",
      input: { code: "return document.body.innerText" },
      output: { body: "sk-live-example" },
      content: { circular },
    });
    await logger.append({
      type: "model.finished",
      content: { text: "done" },
      stopReason: "stop",
      usage: { inputTokens: 1 },
      providerMetadata: { provider: "test" },
    });

    expect(await store.all()).toMatchObject([
      {
        id: 1,
        type: "tool.finished",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolCallId: "call-1",
        input: { code: "return document.body.innerText" },
        output: { body: "sk-live-example" },
      },
      { id: 2, stopReason: "stop", usage: { inputTokens: 1 }, providerMetadata: { provider: "test" } },
    ]);
    expect(JSON.stringify(await store.all())).toContain("sk-live-example");
  });

  it("keeps tool result IDs within their conversation", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    const result = await logger.append({ type: "tool.result.data", conversationId: "first", content: null, output: { value: "private" } });
    await expect(logger.result(result!.id, {}, "first")).resolves.toEqual({ value: "private" });
    await expect(logger.result(result!.id, {}, "second")).rejects.toThrow("unavailable");
    await expect(logger.result(result!.id, {}, "")).rejects.toThrow("unavailable");
  });

  it("distinguishes missing paths from stored null and undefined without traversing prototypes", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    const value = Object.fromEntries([["rows", ["zero", null, undefined]], ["nothing", undefined], ["__proto__", "literal"]]);
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", output: value });
    const id = event!.id;
    await expect(logger.result(id, { path: ["rows", 0] }, "c")).resolves.toBe("zero");
    await expect(logger.result(id, { path: ["rows", 1] }, "c")).resolves.toBeNull();
    await expect(logger.result(id, { path: ["rows", 2] }, "c")).resolves.toBeUndefined();
    await expect(logger.result(id, { path: ["nothing"] }, "c")).resolves.toBeUndefined();
    await expect(logger.result(id, { path: ["__proto__"] }, "c")).resolves.toBe("literal");
    await expect(logger.result(id, { path: ["rows"], offset: 3, limit: 2 }, "c")).resolves.toEqual([]);
    await expect(logger.result(id, { path: ["rows", 0], offset: 2, limit: 2 }, "c")).resolves.toBe("ro");
    for (const path of [["missing"], ["rows", 3], ["rows", "map"], ["constructor"], ["rows", 1, "x"], ["nothing", "x"]])
      await expect(logger.result(id, { path }, "c")).rejects.toMatchObject({ code: "result-path-not-found" });
  });

  it("preserves reserved-looking user objects in every new event field and leaves old events untouched", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    const tags = ["undefined", "number", "bigint", "symbol", "function", "circular-reference", "error", "date", "array-buffer", "typed-array", "map", "set", "escaped-object", "sparse-array"];
    const input = { markers: tags.map(($type) => ({ $type, value: null })),
      nested: { $type: "escaped-object", entries: [["$type", "undefined"], ["value", null]] }, actualUndefined: undefined };
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", content: input, input, output: input,
      error: input, retry: input, abort: input, usage: input, stopReason: input, providerMetadata: input });
    expect(event!.valueEncoding).toBe(3);
    for (const field of ["content", "input", "output", "error", "retry", "abort", "usage", "stopReason", "providerMetadata"] as const)
      expect(fromLogValue(event![field], event!.valueEncoding)).toEqual(input);
    await expect(logger.result(event!.id, {}, "c")).resolves.toEqual(input);
    const legacyLiteral = { $type: "escaped-object", entries: [["value", 1]] };
    const legacy = await store.append({ type: "tool.result.data", timestamp: new Date().toISOString(), conversationId: "c", content: null, output: legacyLiteral });
    await expect(logger.result(legacy.id, {}, "c")).resolves.toEqual(legacyLiteral);
    expect((await store.all()).find((item) => item.id === legacy.id)).toEqual(legacy);
  });

  it("round-trips V2 special numbers and bigint without confusing literal tagged objects", async () => {
    const store = memoryStore(); const logger = new EventLogger({ store });
    const value = { nan: NaN, positive: Infinity, negative: -Infinity, zero: -0, bigint: 123n,
      literalNumber: { $type: "number", value: "NaN" }, literalBigint: { $type: "bigint", value: "123" } };
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", output: value });
    const decoded = await logger.result(event!.id, {}, "c") as typeof value;
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(decoded.positive).toBe(Infinity); expect(decoded.negative).toBe(-Infinity);
    expect(Object.is(decoded.zero, -0)).toBe(true); expect(decoded.bigint).toBe(123n);
    expect(decoded.literalNumber).toEqual(value.literalNumber); expect(decoded.literalBigint).toEqual(value.literalBigint);
    const old = { $type: "number", value: "NaN" };
    const legacy = await store.append({ type: "tool.result.data", timestamp: "old", conversationId: "c", content: null, output: old });
    await expect(logger.result(legacy.id, {}, "c")).resolves.toEqual(old);
  });

  it("stores huge sparse arrays proportional to their entries without confusing literal V2 or V3 objects", async () => {
    const literal = { $type: "sparse-array", length: 9, entries: [[2, "value"]] };
    expect(fromLogValue(literal, 2)).toEqual(literal);
    expect(fromLogValue(toLogValue(literal, undefined, 3), 3)).toEqual(literal);
    const rows = new Array(1_000_000_000);
    rows[3] = undefined; rows[8] = NaN; rows[999_999_999] = 123n;
    const logger = new EventLogger({ store: memoryStore() });
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", output: { rows, literal } });
    expect(event!.valueEncoding).toBe(3);
    expect(JSON.stringify(event!.output).length).toBeLessThan(500);
    const selected = await logger.result(event!.id, { path: ["rows"], offset: 2, limit: 8 }, "c") as unknown[];
    expect(selected.length).toBe(8);
    expect(Object.hasOwn(selected, 0)).toBe(false);
    expect(Object.hasOwn(selected, 1)).toBe(true); expect(selected[1]).toBeUndefined();
    expect(Number.isNaN(selected[6])).toBe(true);
    await expect(logger.result(event!.id, { path: ["rows", 999_999_999] }, "c")).resolves.toBe(123n);
    await expect(logger.result(event!.id, { path: ["literal"] }, "c")).resolves.toEqual(literal);
    const suffix = await logger.result(event!.id, { path: ["rows"], offset: 2 }, "c") as unknown[];
    expect(suffix.length).toBe(999_999_998);
    expect(Object.hasOwn(suffix, 0)).toBe(false);
    expect(Object.hasOwn(suffix, 1)).toBe(true); expect(suffix[1]).toBeUndefined();
    expect(Number.isNaN(suffix[6])).toBe(true); expect(suffix[999_999_997]).toBe(123n);
    const limited = await logger.result(event!.id, { path: ["rows"], offset: 2, limit: 900_000_000 }, "c") as unknown[];
    expect(limited.length).toBe(900_000_000); expect(Object.hasOwn(limited, 1)).toBe(true);
    expect(Number.isNaN(limited[6])).toBe(true); expect(Object.hasOwn(limited, limited.length - 1)).toBe(false);
  });

  it("serializes ordinary JSON unchanged and makes special values explicit for UI and compaction", () => {
    const ordinary = { x: 1, tag: { $type: "bigint", value: "123" } };
    expect(stringifyLogSafe(ordinary)).toBe(JSON.stringify(ordinary));
    const value = { n: 123n, z: -0, literal: { $type: "bigint", value: "123" } };
    const serialized = stringifyLogSafe(value)!;
    expect(serialized).toMatch(/^\[Surf Wax log value encoding v2\]\n/);
    const recovered = fromLogValue(JSON.parse(serialized.split("\n").slice(1).join("\n")), 2) as typeof value;
    expect(recovered.n).toBe(123n); expect(Object.is(recovered.z, -0)).toBe(true); expect(recovered.literal).toEqual(value.literal);
  });

  it("replays a new conversation message containing reserved-looking data", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    const message = { id: "message", role: "user" as const, $type: "undefined", value: null,
      parts: [{ type: "data", data: { $type: "undefined", value: null } }] };
    await logger.appendMessage("c", message);
    await expect(logger.messages("c")).resolves.toEqual([message]);
  });

  it("preserves explicitly undefined event fields separately from absent fields", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    const explicit = await logger.append({ type: "tool.result.data", conversationId: "c", content: undefined, output: undefined });
    const absent = await logger.append({ type: "tool.result.data", conversationId: "c" });
    expect(explicit!.content).toEqual({ $type: "undefined", value: null });
    expect(explicit!.output).toEqual({ $type: "undefined", value: null });
    expect(fromLogValue(explicit!.content, explicit!.valueEncoding)).toBeUndefined();
    expect(fromLogValue(explicit!.output, explicit!.valueEncoding)).toBeUndefined();
    expect(absent!.content).toBeNull();
    expect(Object.hasOwn(absent!, "output")).toBe(false);
  });

  it("rebuilds messages only from the append-only conversation events and clears them", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await logger.appendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] });
    await logger.append({ type: "request.completed", content: { status: 200 } });
    await logger.appendMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "two" }], metadata: undefined });

    expect(rebuildConversation(await store.all())).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "one" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "two" }], metadata: undefined },
    ]);
    await logger.clear();
    expect(await logger.messages()).toEqual([]);
  });

  it("checks the latest indexed clear marker around each canonical read", async () => {
    const base = memoryStore();
    const latestByType = vi.fn(base.latestByType);
    const store = { ...base, latestByType };
    const logger = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "one" });
    await logger.summaryEvents();
    await logger.summaryEvents("one");
    await logger.restorationEvents("one");
    expect(latestByType).toHaveBeenCalledTimes(6);
    await logger.clear();
    await logger.summaryEvents();
    expect(latestByType).toHaveBeenCalledTimes(8);
  });

  it("does not accept late events after a session is stopped for clearing", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    logger.record({ type: "sidepanel.closed", content: null });
    logger.stop();
    logger.record({ type: "userscript.snapshot", content: { count: 1 } });
    await logger.flush();
    await logger.clear();
    expect((await store.all()).map(({ type }) => type)).toEqual(["sidepanel.closed", "log.cleared"]);
  });

  it("batches fire-and-forget events without dropping or reordering them", async () => {
    const batches: number[] = [];
    const store = memoryStore((size) => batches.push(size));
    const logger = new EventLogger({ store });

    for (let index = 0; index < 100; index += 1) {
      logger.telemetry({ type: "model.diagnostic", content: { index } });
    }
    await logger.flush();

    expect(batches).toEqual([100]);
    expect((await store.all()).map((event) => event.content)).toEqual(
      Array.from({ length: 100 }, (_, index) => ({ index })),
    );
  });

  it("restores complete messages and interrupted tool facts", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    await logger.appendMessage("one", { id: "u1", role: "user", parts: [] });
    await logger.appendMessage("one", { id: "a1", role: "assistant", parts: [{ type: "text", text: "Complete reply" }] }, { runId: "done", parentId: "u1" });
    await logger.append({ type: "conversation.finished", conversationId: "one", runId: "done" });
    await logger.append({ type: "tool.started", conversationId: "one", runId: "stopped", toolCallId: "pending", input: {} });
    await logger.append({ type: "conversation.aborted", conversationId: "one", runId: "stopped" });
    expect(await logger.restorationEvents("one")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "conversation.message", content: expect.objectContaining({ id: "a1" }) }),
      expect.objectContaining({ type: "tool.started", runId: "stopped", toolCallId: "pending" }),
    ]));
  });

  it("records a result for each accepted tool when cancellation precedes execution", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    await logger.appendMessage("one", { id: "assistant", role: "assistant", parts: [
      { type: "dynamic-tool", toolCallId: "waiting", toolName: "run", state: "input-available", input: { code: "return 1" } },
    ] }, { runId: "run", parentId: "user" });
    await logger.closePendingTools("run", "one", "Stopped");
    await logger.closePendingTools("run", "one", "Stopped");
    expect((await logger.all()).filter((event) => event.type === "tool.failed")).toMatchObject([
      { toolCallId: "waiting", output: { ok: false, error: { effectUnknown: false } } },
    ]);
  });

  it("hides and restores one conversation using append-only tombstones", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "one", content: { title: "One" } });
    await logger.appendMessage("one", { id: "u1", role: "user", parts: [] });
    await logger.append({ type: "tool.result.data", conversationId: "one", content: { filename: "temporary.txt" }, output: { base64: "eA==" } });
    await logger.append({ type: "conversation.created", conversationId: "two", content: { title: "Two" } });
    await logger.appendMessage("two", { id: "u2", role: "user", parts: [] });

    await logger.deleteConversation("one");

    expect(await logger.conversation("one")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool.result.data" })]));
    expect((await logger.all()).some((event) => event.type === "tool.result.data")).toBe(true);
    expect(await logger.messages("two")).toMatchObject([{ id: "u2" }]);
    const audit = (await logger.all()).find((event) => event.type === "conversation.deleted");
    expect(audit).toMatchObject({ conversationId: "one", content: null });
    await logger.restoreConversation("one");
    expect((await logger.summaryEvents()).map((event) => event.type)).toContain("conversation.restored");
  });
});

describe("run recovery", () => {
  it.each([["screenshot", "screen.png", "image/png"], ["pdf", "page.pdf", "application/pdf"]])("keeps the persisted %s artifact accessible after its owner closes during download authorization", async (toolName, filename, mimeType) => {
    const logger = new EventLogger({ store: memoryStore() });
    const runId = "download-run";
    const toolCallId = "1:capture";
    await logger.appendMessage("one", { id: "user", role: "user", parts: [{ type: "text", text: "Capture and save" }] });
    await logger.append({ type: "conversation.submitted", conversationId: "one", runId, content: { messageId: "user" } });
    await logger.appendMessage("one", { id: "assistant", role: "assistant", parts: [
      { type: "dynamic-tool", toolCallId, toolName, state: "input-available", input: { filename, save: true } },
    ] }, { runId, parentId: "user" });
    await logger.append({ type: "tool.started", conversationId: "one", runId, toolCallId, toolCallIdCanonical: true,
      content: { callId: "sdk", toolName }, input: { filename, save: true } });
    const data = { filename, mimeType, base64: "eA==" };
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "one", runId, toolCallId, toolCallIdCanonical: true,
      content: { filename, mimeType, byteLength: 1 }, output: data });
    await logger.append({ type: "tool.result.data", conversationId: "one", runId, toolCallId: "other", content: { filename: "other.png", mimeType: "image/png", byteLength: 1 }, output: { base64: "eQ==" } });
    await logger.recoverDanglingRuns([], "owner-disconnected");
    await logger.recoverDanglingRuns([], "owner-disconnected");
    const terminals = (await logger.all()).filter((event) => event.type === "tool.failed" && event.toolCallId === toolCallId);
    expect(terminals).toHaveLength(1);
    const expectedArtifact = { id: artifact!.id, filename, mimeType, byteLength: 1 };
    expect(terminals[0]!.output).toMatchObject({ ok: false, error: { code: "interrupted", effectUnknown: true }, artifact: expectedArtifact });
    expect(terminals[0]!.output).not.toHaveProperty("artifact.saved");
    const { restoreConversationRepository } = await import("./conversations");
    const restored = await restoreConversationRepository(await logger.restorationEvents("one"));
    expect(restored.messages.at(-1)!.message.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId, state: "output-available", output: expect.objectContaining({ artifact: expectedArtifact }) }),
    ]));
    await expect(logger.result(artifact!.id, {}, "one")).resolves.toEqual(data);
    expect((await logger.all()).find((event) => event.id === artifact!.id)?.output).toEqual(data);
    expect(JSON.stringify(terminals[0]!.output)).not.toContain(data.base64);
  });
  it.each(["one", "other"])("recovers an artifact-save reference only within its own conversation (%s)", async (artifactConversation) => {
    const store = memoryStore();
    const logger = new EventLogger({ store: { ...store, get: async (id) => (await store.all()).find((event) => event.id === id) } });
    const data = { filename: "prior.pdf", mimeType: "application/pdf", base64: "eA==" };
    const artifact = await logger.append({ type: "tool.result.data", conversationId: artifactConversation, runId: "prior-run", toolCallId: "prior-tool",
      content: { filename: data.filename, mimeType: data.mimeType, byteLength: 1 }, output: data });
    await logger.append({ type: "conversation.submitted", conversationId: "one", runId: "save-run" });
    await logger.append({ type: "tool.started", conversationId: "one", runId: "save-run", toolCallId: "save-existing",
      content: { callId: "sdk", toolName: "artifact-save" }, input: { id: artifact!.id } });
    await logger.recoverDanglingRuns([], "owner-disconnected");
    const result = (await logger.all()).find((event) => event.type === "tool.failed" && event.toolCallId === "save-existing")!.output;
    if (artifactConversation === "one") {
      expect(result).toMatchObject({ artifact: { id: artifact!.id, filename: data.filename, mimeType: data.mimeType, byteLength: 1 } });
      expect(result).not.toHaveProperty("artifact.saved");
      await expect(logger.result(artifact!.id, {}, "one")).resolves.toEqual(data);
    } else expect(result).not.toHaveProperty("artifact");
    expect(JSON.stringify(result)).not.toContain(data.base64);
    expect((await logger.all()).filter((event) => event.type === "tool.result.data")).toHaveLength(1);
  });
  it("restores persisted act progress after its owner disappears", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    const steps = [{ type: "click", target: { ref: "e1" } }, { type: "fill", target: { ref: "e2" }, value: "waiting" }, { type: "click", target: { ref: "e3" } }];
    await logger.append({ type: "conversation.submitted", conversationId: "one", runId: "lost" });
    await logger.append({ type: "tool.started", conversationId: "one", runId: "lost", toolCallId: "batch", input: { steps }, content: { callId: "sdk", toolName: "act" } });
    await logger.append({ type: "tool.progress", conversationId: "one", runId: "lost", toolCallId: "batch", content: { nextIndex: 1, steps }, output: { completed: [{ index: 0, step: steps[0], result: { performed: true } }], elapsedMs: 25 } });
    await logger.recoverDanglingRuns();
    await logger.recoverDanglingRuns();
    const results = (await logger.all()).filter((event) => event.type === "tool.failed");
    expect(results).toHaveLength(1);
    expect(results[0].output).toMatchObject({ ok: false, completed: [{ index: 0, result: { performed: true } }], failed: { index: 1, step: steps[1] }, notRun: [steps[2]], elapsedMs: 25 });
  });

  it("freezes canonical tool IDs before another request attempt begins", () => {
    const logger = new EventLogger({ store: memoryStore() });
    logger.beginRun("one", "run"); logger.setRunPhase("run", 1);
    const identity = logger.toolIdentity("one", "call");
    logger.setRunPhase("run", 2);
    expect(identity).toEqual({ runId: "run", toolCallId: "1:call", toolCallIdCanonical: true });
  });

  it("rechecks the live owner under the recovery lock and preserves worker restart reasons", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    await logger.append({ type: "conversation.submitted", conversationId: "one", runId: "active" });
    await logger.append({ type: "conversation.submitted", conversationId: "two", runId: "orphan" });
    await logger.append({ type: "tool.started", conversationId: "two", runId: "orphan", toolCallId: "pending", content: { toolName: "click" } });
    const owners = vi.fn(async () => ["active"]);
    await logger.recoverDanglingRuns(owners, "worker-restarted");
    expect(owners).toHaveBeenCalledTimes(2);
    const events = await logger.all();
    expect(events.filter((event) => event.runId === "active")).toHaveLength(1);
    expect(events.find((event) => event.type === "conversation.aborted")?.abort).toEqual({ reason: "worker-restarted" });
    expect(events.find((event) => event.type === "tool.failed")?.abort).toEqual({ reason: "worker-restarted" });
  });
  it("closes missing tools before the run and is idempotent while preserving active owners", async () => {
    const logger = new EventLogger({ store: memoryStore() });
    await logger.append({ type: "conversation.submitted", conversationId: "orphan", runId: "lost" });
    await logger.append({ type: "tool.started", conversationId: "orphan", runId: "lost", toolCallId: "pending", input: { target: "e1" }, content: { toolName: "click" } });
    await logger.append({ type: "tool.started", conversationId: "orphan", runId: "lost", toolCallId: "done", content: { toolName: "act" } });
    await logger.append({ type: "tool.failed", conversationId: "orphan", runId: "lost", toolCallId: "done", output: { ok: false, completed: [0], failed: 1, notRun: [2] } });
    await logger.append({ type: "conversation.submitted", conversationId: "active", runId: "alive" });
    await logger.recoverDanglingRuns(["alive"]); await logger.recoverDanglingRuns(["alive"]);
    const events = await logger.all();
    expect(events.filter((event) => event.type === "tool.failed" && event.toolCallId === "pending")).toHaveLength(1);
    const tool = events.find((event) => event.type === "tool.failed" && event.toolCallId === "pending")!;
    const run = events.find((event) => event.type === "conversation.aborted")!;
    expect(tool.id).toBeLessThan(run.id);
    expect(tool.output).toMatchObject({ error: { effectUnknown: true } });
    expect(events.filter((event) => event.runId === "alive")).toHaveLength(1);
    expect(events.find((event) => event.toolCallId === "done" && event.type === "tool.failed")?.output).toEqual({ ok: false, completed: [0], failed: 1, notRun: [2] });
  });
});
