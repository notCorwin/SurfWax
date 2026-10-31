import { describe, expect, it, vi } from "vitest";
import { RefreshTracker } from "./refresh-tracker";

function harness(signal?: AbortSignal, onRefresh?: ConstructorParameters<typeof RefreshTracker>[4]) {
  let listener: ((tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void) | undefined;
  let removed: ((tabId: number, info: chrome.tabs.OnRemovedInfo) => void) | undefined;
  const updates = {
    addListener: vi.fn((callback: typeof listener) => { listener = callback; }),
    removeListener: vi.fn((callback: typeof listener) => { if (listener === callback) listener = undefined; }),
  };
  const removals = {
    addListener: vi.fn((callback: typeof removed) => { removed = callback; }),
    removeListener: vi.fn((callback: typeof removed) => { if (removed === callback) removed = undefined; }),
  };
  let target: number | undefined = 1;
  const tracker = new RefreshTracker(updates, () => target, signal, removals, onRefresh);
  return {
    tracker, updates, removals,
    select: (tabId: number | undefined) => { target = tabId; tracker.targetChanged(); },
    update: (tabId: number, change: chrome.tabs.OnUpdatedInfo) => listener?.(tabId, change, {} as chrome.tabs.Tab),
    remove: (tabId: number) => removed?.(tabId, {} as chrome.tabs.OnRemovedInfo),
  };
}

describe("RefreshTracker", () => {
  it("retains a load completed while the initial tab binding is being resolved", () => {
    const notify = vi.fn();
    const h = harness(undefined, notify);
    h.select(undefined);
    h.update(1, { status: "loading" });
    h.update(1, { status: "complete" });
    h.update(2, { status: "loading" });
    h.update(2, { status: "complete" });
    h.select(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(h.tracker.drain()).toEqual([{ tabId: 1, generation: 1 }]);
  });
  it("enqueues only completed loads of the bound tab", () => {
    const h = harness();
    h.update(1, { title: "Changed" });
    h.update(1, { status: "complete" });
    h.update(2, { status: "loading" });
    h.update(2, { status: "complete" });
    h.update(1, { status: "loading" });
    expect(h.tracker.drain()).toEqual([]);
    h.update(1, { status: "complete" });
    h.update(1, { status: "complete" });
    const [refresh] = h.tracker.drain();
    expect(refresh).toEqual({ tabId: 1, generation: 1 });
    expect(h.tracker.isCurrent(refresh!)).toBe(true);
    expect(h.tracker.drain()).toEqual([]);
  });

  it("invalidates a completed document as soon as a subsequent load starts", () => {
    const h = harness();
    h.update(1, { status: "loading" });
    h.update(1, { status: "complete" });
    const first = h.tracker.drain()[0]!;
    h.update(1, { status: "loading" });
    expect(h.tracker.isCurrent(first)).toBe(false);
    h.update(1, { status: "loading" });
    h.update(1, { status: "complete" });
    const second = h.tracker.drain()[0]!;
    expect(second).toEqual({ tabId: 1, generation: 3 });
    expect(h.tracker.isCurrent(second)).toBe(true);
  });

  it("does not associate an old load with a newly selected tab", () => {
    const h = harness();
    h.update(1, { status: "loading" });
    h.select(2);
    h.update(1, { status: "complete" });
    h.update(2, { status: "loading" });
    h.update(2, { status: "complete" });
    const second = h.tracker.drain()[0]!;
    expect(second.tabId).toBe(2);
    h.select(1);
    expect(h.tracker.isCurrent(second)).toBe(false);
    h.update(1, { status: "complete" });
    expect(h.tracker.drain()).toEqual([]);
  });

  it("removes its listener and discards pending refreshes on cancellation", () => {
    const controller = new AbortController();
    const h = harness(controller.signal);
    h.update(1, { status: "loading" });
    h.update(1, { status: "complete" });
    controller.abort();
    h.tracker.dispose();
    expect(h.tracker.drain()).toEqual([]);
    expect(h.updates.removeListener).toHaveBeenCalledTimes(1);
    expect(h.removals.removeListener).toHaveBeenCalledTimes(1);
    const stopped = harness(controller.signal);
    expect(stopped.updates.addListener).not.toHaveBeenCalled();
  });

  it("notifies on completion and waits for an in-progress load", async () => {
    const notify = vi.fn();
    const h = harness(undefined, notify);
    h.update(1, { status: "loading" });
    const settled = vi.fn();
    const waiting = h.tracker.waitForSettled().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    h.update(1, { status: "complete" });
    expect(notify).toHaveBeenCalledWith({ tabId: 1, generation: 1 });
    await waiting;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("unblocks when the bound tab changes, closes, or the run is cancelled", async () => {
    const controller = new AbortController();
    const h = harness(controller.signal);
    h.update(1, { status: "loading" });
    const changed = h.tracker.waitForSettled();
    h.select(2);
    await expect(changed).resolves.toBeUndefined();
    h.update(2, { status: "loading" });
    const closed = h.tracker.waitForSettled();
    h.remove(2);
    await expect(closed).resolves.toBeUndefined();
    h.update(2, { status: "loading" });
    const aborted = h.tracker.waitForSettled();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });
});
