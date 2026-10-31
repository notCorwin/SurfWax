import { afterEach, describe, expect, it, vi } from "vitest";
import { observePageRefreshes } from "./refresh-observer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(inspect = vi.fn(async () => ({ snapshot: "loaded page" }))) {
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
  const executor = { boundTabId: 1, inspect, onBoundTabChanged: vi.fn(() => unsubscribe) };
  const controller = new AbortController();
  const observer = observePageRefreshes(executor as never, "conversation", controller.signal);
  return {
    observer, controller, inspect, onUpdated, onRemoved, unsubscribe,
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
    expect(h.inspect).toHaveBeenCalledWith({ tabId: 1, budget: Number.MAX_SAFE_INTEGER }, h.controller.signal,
      { conversationId: "conversation", runSignal: h.controller.signal });
    const [message] = await h.observer.drain();
    expect(message).toMatchObject({ role: "user", metadata: { custom: { pageRefresh: true } }, parts: [
      { type: "text", text: expect.stringContaining('"snapshot":"loaded page"') },
    ] });
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
    expect(JSON.stringify(messages[0])).toContain("The document changed while it was being captured.");
    expect(JSON.stringify(messages[0])).not.toContain("stale page");
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
