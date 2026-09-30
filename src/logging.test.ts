import { describe, expect, it, vi } from "vitest";
import { EventLogger, rebuildConversation, upgradeEventStore, type LogEvent } from "./logging";

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
    await logger.closePendingTools("run", "one", "stream-disconnected");
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
    await logger.closePendingTools("run", "one", "stream-disconnected");
    await logger.closePendingTools("run", "one", "stream-disconnected");
    const failed = (await store.all()).filter((event) => event.type === "tool.failed");
    expect(failed.map((event) => event.toolCallId)).toEqual(["call", "1:call"]);
    expect(failed).toHaveLength(2);
  });

  it("upgrades the existing event store without deleting legacy records", () => {
    const legacyRecords = [{ id: 1, type: "legacy" }];
    const createIndex = vi.fn();
    const store = { indexNames: { contains: () => false }, createIndex };
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      deleteObjectStore: vi.fn(() => { legacyRecords.length = 0; }),
    };
    const transaction = { objectStore: vi.fn(() => store) };

    upgradeEventStore(db as unknown as IDBDatabase, transaction as unknown as IDBTransaction);

    expect(transaction.objectStore).toHaveBeenCalledWith("events");
    expect(createIndex).toHaveBeenCalledWith("conversationId", "conversationId");
    expect(createIndex).toHaveBeenCalledWith("type", "type");
    expect(createIndex).toHaveBeenCalledWith("conversationType", ["conversationId", "type"]);
    expect(createIndex).toHaveBeenCalledWith("runType", ["runId", "type"]);
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

  it("does not accept late events after a session is stopped for clearing", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    logger.record({ type: "sidepanel.closed", content: null });
    logger.stop();
    logger.record({ type: "userscript.snapshot", content: { count: 1 } });
    await logger.flush();
    await logger.clear();
    expect(await store.all()).toEqual([]);
  });

  it("batches fire-and-forget events without dropping or reordering them", async () => {
    const batches: number[] = [];
    const store = memoryStore((size) => batches.push(size));
    const logger = new EventLogger({ store });

    for (let index = 0; index < 100; index += 1) {
      logger.record({ type: "conversation.stream.chunk", content: { index } });
    }
    await logger.flush();

    expect(batches).toEqual([100]);
    expect((await store.all()).map((event) => event.content)).toEqual(
      Array.from({ length: 100 }, (_, index) => ({ index })),
    );
  });

  it("skips completed stream chunks during restore but retains interrupted replay data", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await logger.appendMessage("one", { id: "u1", role: "user", parts: [] });
    logger.record({ type: "conversation.stream.chunk", conversationId: "one", runId: "done", content: { delta: "complete" } });
    await logger.append({ type: "conversation.finished", conversationId: "one", runId: "done" });

    expect(await logger.restorationEvents("one")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "conversation.stream.chunk" })]),
    );

    logger.record({ type: "conversation.stream.chunk", conversationId: "one", runId: "stopped", content: { delta: "partial" } });
    await logger.append({ type: "conversation.aborted", conversationId: "one", runId: "stopped" });
    expect(await logger.restorationEvents("one")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "conversation.stream.chunk", runId: "stopped" })]),
    );
  });

  it("physically deletes only one conversation and retains an unscoped audit event", async () => {
    const store = memoryStore();
    const logger = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "one", content: { title: "One" } });
    await logger.appendMessage("one", { id: "u1", role: "user", parts: [] });
    await logger.append({ type: "tool.result.data", conversationId: "one", content: { filename: "temporary.txt" }, output: { base64: "eA==" } });
    await logger.append({ type: "conversation.created", conversationId: "two", content: { title: "Two" } });
    await logger.appendMessage("two", { id: "u2", role: "user", parts: [] });

    await logger.deleteConversation("one");

    expect(await logger.conversation("one")).toEqual([]);
    expect((await logger.all()).some((event) => event.type === "tool.result.data")).toBe(false);
    expect(await logger.messages("two")).toMatchObject([{ id: "u2" }]);
    const audit = (await logger.all()).find((event) => event.type === "conversation.deleted");
    expect(audit).toMatchObject({ content: { conversationId: "one" } });
    expect(audit).not.toHaveProperty("conversationId");
  });
});

describe("run recovery", () => {
  it.each([["screenshot", "screen.png", "image/png"], ["pdf", "page.pdf", "application/pdf"]])("keeps the persisted %s artifact accessible after its owner closes during download authorization", async (toolName, filename, mimeType) => {
    const logger = new EventLogger({ store: memoryStore() });
    const runId = "download-run";
    const toolCallId = "1:capture";
    await logger.appendMessage("one", { id: "user", role: "user", parts: [{ type: "text", text: "Capture and save" }] });
    await logger.append({ type: "conversation.submitted", conversationId: "one", runId, content: { messageId: "user" } });
    logger.record({ type: "conversation.stream.chunk", conversationId: "one", runId, content: { type: "start", messageId: "assistant" } });
    logger.record({ type: "conversation.stream.chunk", conversationId: "one", runId,
      content: { type: "tool-input-available", toolCallId, toolName, dynamic: true, input: { filename, save: true } } });
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

  it("freezes canonical tool IDs before another stream phase begins", () => {
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
