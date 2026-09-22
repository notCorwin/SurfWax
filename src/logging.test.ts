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
