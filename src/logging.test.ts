import { describe, expect, it } from "vitest";
import { EventLogger, MemoryLogStore, rebuildConversation } from "./logging";

describe("canonical event log", () => {
  it("keeps complete content and explicit model/tool fields", async () => {
    const store = new MemoryLogStore();
    const logger = new EventLogger({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logger.record({
      category: "tool",
      type: "tool.finished",
      toolCallId: "call-1",
      input: { operation: "call", path: "tabs.query" },
      output: { title: "page", body: "sk-live-example" },
      content: { scriptCode: "document.body.dataset.ready = 'yes';", circular },
    });
    logger.record({
      category: "model",
      type: "model.finished",
      content: { text: "done" },
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
      providerMetadata: { provider: "test" },
    });
    await logger.flush();

    const events = await store.all();
    expect(events[0]).toMatchObject({
      id: 1,
      type: "tool.finished",
      timestamp: "2026-01-01T00:00:00.000Z",
      toolCallId: "call-1",
      input: { operation: "call", path: "tabs.query" },
      output: { body: "sk-live-example" },
      content: { scriptCode: "document.body.dataset.ready = 'yes';" },
    });
    expect(JSON.stringify(events)).toContain("sk-live-example");
    expect(events[1]).toMatchObject({
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
      providerMetadata: { provider: "test" },
    });
  });

  it("rebuilds the active conversation from append-only message and context events", async () => {
    const store = new MemoryLogStore();
    const logger = new EventLogger({ store });
    await logger.appendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "old" }] });
    await logger.appendMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "old answer" }] });
    await logger.appendContext(["u1", "a1"]);
    await logger.appendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "edited" }] });
    await logger.appendContext(["u1"]);
    await logger.appendMessage({ id: "a2", role: "assistant", parts: [{ type: "text", text: "new answer" }] });

    expect(await logger.messages()).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "edited" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "new answer" }] },
    ]);
    expect(rebuildConversation(await store.all())).toHaveLength(2);
  });

  it("restores optional UI message fields after log serialization", async () => {
    const store = new MemoryLogStore();
    const logger = new EventLogger({ store });
    await logger.appendMessage({
      id: "assistant-1",
      role: "assistant",
      metadata: undefined,
      parts: [{ type: "text", text: "done", providerMetadata: undefined }],
    });

    expect(await logger.messages()).toEqual([{
      id: "assistant-1",
      role: "assistant",
      metadata: undefined,
      parts: [{ type: "text", text: "done", providerMetadata: undefined }],
    }]);
  });
});
