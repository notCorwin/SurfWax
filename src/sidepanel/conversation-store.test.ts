import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { errorDetails } from "../components/ui/error-notice";
import { createChatTransport } from "../agent/transport";
import { ensureConversationPrompt } from "../agent/prompt";
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

  it("commits a draft and submission atomically across failed maintenance and retry", async () => {
    const memory = createMemoryEventStore();
    let receive!: (message: any) => void;
    const port = { onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      onDisconnect: { addListener: () => {} }, postMessage: () => {} } as unknown as chrome.runtime.Port;
    const logger = new EventLogger({ store: memory, writerPort: port });
    receive({ type: "writer-ready", generation: 1 });
    await logger.append({ type: "conversation.created", conversationId: "c" });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    await ensureConversationPrompt(logger, "c");
    let block = false;
    vi.stubGlobal("navigator", { locks: { request: async (name: string, options: unknown, callback?: (lock: object) => Promise<unknown>) => {
      const action = callback ?? options as (lock: object) => Promise<unknown>;
      if (name === "surf-wax:job-state-log" && block) { block = false; entered(); await gate; }
      return action({});
    } } });
    const inputs: unknown[] = [];
    const agent = vi.fn(() => ({ generate: async ({ messages }: { messages: unknown }) => { inputs.push(messages); } }));
    const panel = new ConversationStore(logger, id => createChatTransport(agent as never, logger, id), "c");
    await panel.threads.switchToThread("c");
    await logger.flush();
    block = true;
    panel.composer.setText("keep this draft");
    const first = panel.composer.send();
    await waiting;
    receive({ type: "writer-ready", generation: 2, paused: true });
    receive({ type: "clear-failed" });
    release();
    await first;
    expect(panel.getState().composer.text).toBe("keep this draft");
    expect((await memory.all()).filter(event => ["conversation.message", "conversation.submitted"].includes(event.type))).toEqual([]);
    expect(inputs).toEqual([]);
    await panel.composer.send();
    const events = await memory.all();
    expect(events.filter(event => event.type === "conversation.message")).toHaveLength(1);
    expect(events.filter(event => event.type === "conversation.submitted")).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(inputs[0]).match(/keep this draft/g)).toHaveLength(1);
    expect(panel.getState().composer.text).toBe("");
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
