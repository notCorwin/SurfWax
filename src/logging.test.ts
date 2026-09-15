import { describe, expect, it } from "vitest";
import { EventLogger, rebuildConversation, type LogEvent } from "./logging";

function memoryStore() {
  const events: LogEvent[] = [];
  return {
    async append(event: Omit<LogEvent, "id">) {
      const stored = { ...event, id: events.length + 1 };
      events.push(stored);
      return stored;
    },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  };
}

describe("canonical event log", () => {
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
});
