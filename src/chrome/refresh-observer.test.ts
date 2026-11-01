import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger, type ConversationMessage } from "../logging";
import { testEventStore } from "../test-event-store";
import { observePageRefreshes } from "./refresh-observer";
import { SNAPSHOT_DELIVERY_COMMIT } from "./snapshot-wire";
import { ChromeExecutor } from "./executor";
import { createProgramTools } from "./tool";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(inspect = vi.fn<() => Promise<unknown>>(async () => ({ snapshot: "loaded page" })), logger = new EventLogger({ store: testEventStore() })) {
  let updated: ((tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void) | undefined;
  let removed: ((tabId: number, info: chrome.tabs.OnRemovedInfo) => void) | undefined;
  const onUpdated = {
    addListener: vi.fn((listener: typeof updated) => { updated = listener; }),
    removeListener: vi.fn((listener: typeof updated) => { if (updated === listener) updated = undefined; }),
  };
  const onRemoved = {
    addListener: vi.fn((listener: typeof removed) => { removed = listener; }),
    removeListener: vi.fn((listener: typeof removed) => { if (removed === listener) removed = undefined; }),
  };
  vi.stubGlobal("chrome", { tabs: { onUpdated, onRemoved } });
  const unsubscribe = vi.fn();
  const inspected = vi.fn(async (...args: any[]) => {
    const value = await (inspect as (...args: any[]) => Promise<unknown>)(...args);
    if (value && typeof value === "object" && !Object.hasOwn(value, SNAPSHOT_DELIVERY_COMMIT))
      Object.defineProperty(value, SNAPSHOT_DELIVERY_COMMIT, { value: { begin: () => true, finish: () => {}, cancel: () => {} } });
    return value;
  });
  const executor = { boundTabId: 1, inspect: inspected, onBoundTabChanged: vi.fn(() => unsubscribe) };
  const controller = new AbortController();
  const observer = observePageRefreshes(executor as never, "conversation", controller.signal, "run", logger);
  return {
    observer, controller, inspect: inspected, logger, onUpdated, onRemoved, unsubscribe,
    update: (status: "loading" | "complete", tabId = 1) => updated?.(tabId, { status }, {} as chrome.tabs.Tab),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("observePageRefreshes", () => {
  it("captures the bound tab immediately after its load completes", async () => {
    const h = harness();
    h.update("loading");
    expect(h.inspect).not.toHaveBeenCalled();
    h.update("complete");
    expect(h.inspect).toHaveBeenCalledWith({ tabId: 1, budget: 12_000, deferDelivery: true }, h.controller.signal,
      { conversationId: "conversation", runId: "run", runSignal: h.controller.signal });
    const [message] = await h.observer.drain();
    expect(message).toMatchObject({ role: "user", metadata: { custom: { pageRefresh: true } }, parts: [
      { type: "text", text: expect.stringContaining('"snapshot":"loaded page"') },
    ] });
    h.observer.dispose();
  });

  it("preserves the cursor and makes bounded Unicode metadata exactly recoverable", async () => {
    const url = `https://example.com/${"海😀".repeat(2000)}`, title = "😀海".repeat(1000);
    const h = harness(vi.fn(async () => ({ tabId: 1, observationId: "observation", url,
      title, mode: "full", items: [{ id: "a", line: "visible" }], nextCursor: "cursor:1:0",
      lookahead: { nonAuthoritative: true, items: [{ index: 2, id: "c", line: "later", ref: "ref-c" }] },
      truncation: { truncated: true, budget: 12_000, used: 100 } })));
    h.update("loading");
    h.update("complete");
    h.update("complete");
    const [message] = await h.observer.drain();
    expect(h.inspect).toHaveBeenCalledOnce();
    const text = message!.parts[0]!.type === "text" ? message!.parts[0]!.text : "";
    expect(text).toContain("inspect_page using the same tabId and cursor");
    expect(text).toContain("Lookahead is a sparse, non-authoritative preview");
    const observation = JSON.parse(text.split("\n")[2]!);
    expect(observation).toMatchObject({ tabId: 1, observationId: "observation", nextCursor: "cursor:1:0",
      items: [{ id: "a", line: "visible" }], lookahead: { nonAuthoritative: true, items: [{ index: 2, id: "c", line: "later", ref: "ref-c" }] },
      metadataTruncated: ["url", "title"], truncation: { truncated: true } });
    expect(new TextEncoder().encode(observation.url).length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(observation.title).length).toBeLessThanOrEqual(2048);
    expect(observation.title).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(observation.metadataLengths).toEqual({ url: url.length, title: title.length });
    expect(observation.metadataOffsetUnit).toBe("UTF-16");
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger: h.logger });
    const tools = createProgramTools(executor, { logger: h.logger, conversationId: "conversation" }) as Record<string, any>;
    let readId = 0;
    for (const [field, original] of Object.entries({ url, title })) {
      const access = observation.metadataAccess[field];
      expect(access).toMatchObject({ artifactId: expect.any(Number), path: [field], offset: 0, limit: 1000 });
      let restored = "";
      for (let offset = 0; offset < original.length; offset += access.limit) {
        const output = await tools.read_artifact.execute({ ...access, offset }, { toolCallId: `read-${++readId}` });
        const roundtrip = JSON.parse(JSON.stringify(output));
        expect(roundtrip).toMatchObject({ ok: true, result: expect.any(String) });
        restored += roundtrip.result;
      }
      expect(restored).toBe(original);
      await expect(h.logger.result(access.artifactId, { path: access.path }, "different-conversation")).rejects.toThrow();
    }
    executor.dispose();
    h.observer.dispose();
  });

  it("commits only after the matching refresh is durably written in the same conversation and run", async () => {
    const lease = { begin: vi.fn(() => true), finish: vi.fn(), cancel: vi.fn() };
    const page = { tabId: 1, observationId: "obs", items: [], truncation: { baselineComplete: true } };
    Object.defineProperty(page, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
    const h = harness(vi.fn(async () => page));
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    expect(lease.begin).toHaveBeenCalledOnce();
    expect(lease.finish).not.toHaveBeenCalled();
    await h.logger.appendMessage("other", message as ConversationMessage, { runId: "run" });
    await h.logger.appendMessage("conversation", message as ConversationMessage, { runId: "other" });
    const forged = { ...message!, parts: [{ type: "text", text: "different" }] };
    await h.logger.appendMessage("conversation", forged as ConversationMessage, { runId: "run" });
    expect(lease.finish).not.toHaveBeenCalled();
    await h.logger.appendMessage("conversation", message as ConversationMessage, { runId: "run" });
    expect(lease.finish).toHaveBeenCalledOnce();
    h.observer.dispose();
    expect(lease.cancel).not.toHaveBeenCalled();
  });

  it.each(["dispose", "abort"] as const)("cancels an unpersisted refresh on %s", async (action) => {
    const lease = { begin: vi.fn(() => true), finish: vi.fn(), cancel: vi.fn() };
    const page = { tabId: 1, observationId: "obs", items: [] };
    Object.defineProperty(page, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
    const h = harness(vi.fn(async () => page));
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    if (action === "abort") h.controller.abort(); else h.observer.dispose();
    expect(lease.cancel).toHaveBeenCalledOnce();
    await h.logger.appendMessage("conversation", message as ConversationMessage, { runId: "run" });
    expect(lease.finish).not.toHaveBeenCalled();
    h.observer.dispose();
  });

  it("does not commit a refresh to the baseline when navigation precedes persistence", async () => {
    const lease = { begin: vi.fn(() => true), finish: vi.fn(), cancel: vi.fn() };
    const page = { tabId: 1, observationId: "obs", items: [] };
    Object.defineProperty(page, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
    const h = harness(vi.fn(async () => page));
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    h.update("loading");
    await h.logger.appendMessage("conversation", message as ConversationMessage, { runId: "run" });
    // The transport already owns this message after drain(): its historical
    // content can still be persisted even though it no longer describes the
    // current document. The lease must not certify it as a usable baseline.
    expect(await h.logger.messages("conversation")).toContainEqual(message);
    expect(lease.finish).not.toHaveBeenCalled();
    expect(lease.cancel).toHaveBeenCalledOnce();
    h.observer.dispose();
  });

  it("does not deliver a snapshot if its complete metadata could not be stored", async () => {
    const logger = new EventLogger({ store: testEventStore() });
    vi.spyOn(logger, "append").mockResolvedValueOnce(undefined);
    const lease = { begin: vi.fn(() => true), finish: vi.fn(), cancel: vi.fn() };
    const page = { tabId: 1, title: "海".repeat(2000), items: [{ id: "x", line: "secret-free page" }] };
    Object.defineProperty(page, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
    const h = harness(vi.fn(async () => page), logger);
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    expect(JSON.stringify(message)).toContain("Could not save the complete page metadata");
    expect(JSON.stringify(message)).not.toContain("secret-free page");
    expect(lease.begin).not.toHaveBeenCalled();
    expect(lease.cancel).toHaveBeenCalledOnce();
    h.observer.dispose();
  });

  it("keeps a long unavailable diagnostic recoverable without an unbounded refresh message", async () => {
    const diagnostic = "ERROR_" + "海😀".repeat(1600);
    const h = harness(vi.fn(async () => { throw new Error(diagnostic); }));
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    const text = message!.parts[0]!.type === "text" ? message!.parts[0]!.text : "";
    const observation = JSON.parse(text.split("\n")[2]!);
    expect(new TextEncoder().encode(observation.unavailable).length).toBeLessThanOrEqual(2048);
    expect(observation.metadataLengths.unavailable).toBe(diagnostic.length);
    const access = observation.metadataAccess.unavailable;
    let restored = "";
    for (let offset = 0; offset < diagnostic.length; offset += access.limit)
      restored += await h.logger.result(access.artifactId, { path: access.path, offset, limit: access.limit }, "conversation");
    expect(restored).toBe(diagnostic);
    h.observer.dispose();
  });

  it("does not let a refresh listener throw after a durable message write", async () => {
    const lease = { begin: vi.fn(() => true), finish: vi.fn(() => { throw new Error("unexpected"); }), cancel: vi.fn() };
    const page = { tabId: 1, observationId: "obs", items: [] };
    Object.defineProperty(page, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
    const h = harness(vi.fn(async () => page));
    h.update("loading"); h.update("complete");
    const [message] = await h.observer.drain();
    await expect(h.logger.appendMessage("conversation", message as ConversationMessage, { runId: "run" })).resolves.toBeUndefined();
    expect(lease.cancel).toHaveBeenCalledOnce();
    h.observer.dispose();
  });

  it("waits for both a load already underway and the resulting capture", async () => {
    const capture = deferred<{ snapshot: string }>();
    const h = harness(vi.fn(() => capture.promise));
    h.update("loading");
    const done = vi.fn();
    const draining = h.observer.drain().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    h.update("complete");
    await Promise.resolve();
    expect(h.inspect).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    capture.resolve({ snapshot: "finished" });
    await draining;
    expect(done).toHaveBeenCalledWith([expect.objectContaining({ parts: [expect.objectContaining({ text: expect.stringContaining('"snapshot":"finished"') })] })]);
    h.observer.dispose();
  });

  it("reports an unavailable snapshot when a newer load replaces the document during capture", async () => {
    const first = deferred<{ snapshot: string }>();
    const inspect = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ snapshot: "new page" });
    const h = harness(inspect);
    h.update("loading");
    h.update("complete");
    h.update("loading");
    h.update("complete");
    first.resolve({ snapshot: "stale page" });
    const messages = await h.observer.drain();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0])).toContain("The document changed before its snapshot could be delivered.");
    expect(JSON.stringify(messages[0])).not.toContain("stale page");
    expect(JSON.stringify(messages[1])).toContain("new page");
    h.observer.dispose();
  });

  it("does not deliver a completed capture after a newer navigation and retains the new snapshot", async () => {
    const inspect = vi.fn().mockResolvedValueOnce({ snapshot: "old page" }).mockResolvedValueOnce({ snapshot: "new page" });
    const h = harness(inspect);
    h.update("loading");
    h.update("complete");
    await Promise.resolve();
    h.update("loading");
    h.update("complete");
    const messages = await h.observer.drain();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0])).toContain("The document changed before its snapshot could be delivered.");
    expect(JSON.stringify(messages[0])).not.toContain("old page");
    expect(JSON.stringify(messages[1])).toContain("new page");
    h.observer.dispose();
  });

  it("cleans up its listeners on disposal and aborts a pending drain", async () => {
    const h = harness();
    h.update("loading");
    const draining = h.observer.drain();
    h.controller.abort();
    await expect(draining).rejects.toMatchObject({ name: "AbortError" });
    h.observer.dispose();
    expect(h.onUpdated.removeListener).toHaveBeenCalledOnce();
    expect(h.onRemoved.removeListener).toHaveBeenCalledOnce();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    h.update("complete");
    expect(h.inspect).not.toHaveBeenCalled();
  });
});
