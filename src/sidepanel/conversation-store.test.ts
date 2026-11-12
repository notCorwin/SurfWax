import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { errorDetails } from "../components/ui/error-notice";
import { createChatTransport } from "../agent/transport";
import { ConversationStore } from "./conversation-store";

afterEach(() => vi.unstubAllGlobals());

describe("conversation command persistence", () => {
  it("keeps the visible state and draft when maintenance rejects commands, and recovers after failure", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "c", content: { title: "Original" } });
    await logger.appendMessage("c", { id: "a", role: "user", parts: [{ type: "text", text: "A" }] }, { parentId: null });
    await logger.appendMessage("c", { id: "b", role: "user", parts: [{ type: "text", text: "B" }] }, { parentId: null });
    const panel = new ConversationStore(logger, () => { throw new Error("unexpected transport"); }, "c");
    await panel.threads.switchToThread("c");
    await panel.threads.reload();
    logger.stop();
    const failedClearStore = { ...store, async appendMany(events: Parameters<typeof store.appendMany>[0]) {
      if (events.some(event => event.type === "log.cleared")) throw new Error("storage failure");
      return store.appendMany(events);
    } };
    await expect(new EventLogger({ store: failedClearStore }).clear()).rejects.toThrow("storage failure");
    const renameError = await panel.threads.item({ id: "c" }).rename("Changed").catch(error => error);
    expect(errorDetails(renameError)).toBe("日志正在维护，请稍后重试。");
    await expect(panel.threads.item({ id: "c" }).delete()).rejects.toThrow("日志正在维护");
    await expect(panel.threads.restore("c")).rejects.toThrow("日志正在维护");
    await expect(panel.thread.getMessageById("b").switchToBranch({ position: "previous" })).rejects.toThrow("日志正在维护");
    expect(panel.getState().thread.messages.map(message => message.id)).toEqual(["b"]);
    expect(panel.getState().threadListItem.id).toBe("c");
    panel.composer.setText("draft");
    await panel.composer.send();
    expect(panel.getState().composer.text).toBe("draft");
    expect((await logger.summaryEvents("c")).map(event => event.type)).toEqual(["conversation.created", "conversation.selected"]);
    logger.resume();
    await panel.threads.item({ id: "c" }).rename("Changed");
    await panel.thread.getMessageById("b").switchToBranch({ position: "previous" });
    await panel.threads.reload();
    expect(panel.getState().threads.threadItems[0]?.title).toBe("Changed");
    expect(panel.getState().thread.messages.map(message => message.id)).toEqual(["a"]);
    await panel.threads.item({ id: "c" }).delete();
    await panel.threads.reload();
    expect(panel.getState().threads.threadItems).toEqual([]);
    await panel.threads.restore("c");
    await panel.threads.reload();
    expect(panel.getState().threads.threadItems[0]?.title).toBe("Changed");
  });

  it("retains a draft if the run submission cannot be committed", async () => {
    const memory = createMemoryEventStore();
    let logger!: EventLogger;
    let stopOnMessage = false;
    const store = { ...memory, async appendMany(events: Parameters<typeof memory.appendMany>[0]) {
      const saved = await memory.appendMany(events);
      if (stopOnMessage && events.some(event => event.type === "conversation.message")) logger.stop();
      return saved;
    } };
    logger = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "c" });
    const agent = vi.fn(() => { throw new Error("model should not start"); });
    const panel = new ConversationStore(logger, id => createChatTransport(agent, logger, id), "c");
    await panel.threads.switchToThread("c");
    panel.composer.setText("keep this draft");
    stopOnMessage = true;
    await panel.composer.send();
    expect(panel.getState().composer.text).toBe("keep this draft");
    expect(panel.getState().thread.error).toBeDefined();
    expect(agent).not.toHaveBeenCalled();
    expect((await memory.all()).some(event => event.type === "conversation.submitted")).toBe(false);
  });

  it("rejects a command delayed across a successful clear", async () => {
    const store = createMemoryEventStore();
    const logger = new EventLogger({ store });
    const clearer = new EventLogger({ store });
    await logger.append({ type: "conversation.created", conversationId: "c", content: { title: "Original" } });
    const panel = new ConversationStore(logger, () => { throw new Error("unexpected transport"); }, "c");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal("chrome", { runtime: { sendMessage: async () => { entered(); await gate; return {}; } } });
    const rename = panel.threads.item({ id: "c" }).rename("Late");
    await waiting;
    await clearer.clear();
    release();
    await expect(rename).rejects.toThrow("日志正在维护");
    expect(await logger.summaryEvents("c")).toEqual([]);
  });
});
