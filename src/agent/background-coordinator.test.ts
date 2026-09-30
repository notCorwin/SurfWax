import { describe, expect, it, vi } from "vitest";
import { BackgroundRunCoordinator } from "./background-coordinator";
const port = (documentId?: string) => ({ postMessage: vi.fn(), sender: { documentId } }) as unknown as chrome.runtime.Port;
describe("extension ownership", () => {
  it("rejects competition and does not release the owner on non-owner disconnect", () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port(); const other = port();
    const identity = coordinator.claim(owner, { runId: "run", ownerId: "owner", conversationId: "thread" });
    expect(() => coordinator.claim(other, { runId: "run2", ownerId: "owner2", conversationId: "thread2" })).toThrow("已有任务运行");
    expect(coordinator.release(other)).toBeUndefined(); coordinator.validate(identity, "operation");
    expect(() => coordinator.validate(identity, "operation")).toThrow("already accepted");
  });
  it("fences cancelled, stale-generation and maintenance operations", () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port();
    const old = coordinator.claim(owner, { runId: "run", ownerId: "owner", conversationId: "thread" });
    coordinator.cancel(owner); expect(() => coordinator.validate(old, "queued")).toThrow("取消");
    coordinator.release(owner);
    const next = coordinator.claim(owner, { runId: "next", ownerId: "owner", conversationId: "thread" });
    expect(() => coordinator.validate(old)).toThrow(); coordinator.validate(next);
    coordinator.maintenance = true; expect(() => coordinator.validate(next)).toThrow();
  });
  it("ignores a delayed window close while the new owner's document still exists", async () => {
    const coordinator = new BackgroundRunCoordinator(); const previous = port("closed-panel"); const owner = port("recovery-tab");
    coordinator.claim(previous, { runId: "old", ownerId: "old-owner", conversationId: "thread", windowId: 7 });
    coordinator.release(previous);
    const identity = coordinator.claim(owner, { runId: "next", ownerId: "next-owner", conversationId: "thread", windowId: 7 });
    const hasDocument = vi.fn(async () => true);
    await coordinator.cancelClosedWindow(7, hasDocument);
    expect(hasDocument).toHaveBeenCalledWith("recovery-tab");
    expect(owner.postMessage).not.toHaveBeenCalled();
    coordinator.validate(identity);
  });
  it("does not cancel a replacement owner when a previous document query completes", async () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port("panel");
    coordinator.claim(owner, { runId: "old", ownerId: "owner", conversationId: "thread", windowId: 7 });
    let resolve!: (open: boolean) => void;
    const close = coordinator.cancelClosedWindow(7, () => new Promise<boolean>(accept => { resolve = accept; }));
    coordinator.release(owner);
    const identity = coordinator.claim(owner, { runId: "next", ownerId: "owner", conversationId: "thread", windowId: 7 });
    resolve(false); await close;
    expect(owner.postMessage).not.toHaveBeenCalled();
    coordinator.validate(identity);
  });
  it("cancels the same owner only after confirming its document has disappeared", async () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port("closed-panel");
    const identity = coordinator.claim(owner, { runId: "run", ownerId: "owner", conversationId: "thread", windowId: 7 });
    await coordinator.cancelClosedWindow(7, async () => false);
    expect(owner.postMessage).toHaveBeenCalledOnce();
    expect(owner.postMessage).toHaveBeenCalledWith({ type: "abort", reason: "sidepanel-closed" });
    expect(() => coordinator.validate(identity)).toThrow("取消");
  });
  it("keeps the owner alive when its document cannot be checked", async () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port("panel");
    const identity = coordinator.claim(owner, { runId: "run", ownerId: "owner", conversationId: "thread", windowId: 7 });
    await coordinator.cancelClosedWindow(7, async () => { throw new Error("Context query failed"); });
    expect(owner.postMessage).not.toHaveBeenCalled();
    coordinator.validate(identity);
  });
  it("does not use a different window or an unknown owner document as a close signal", async () => {
    const coordinator = new BackgroundRunCoordinator(); const owner = port();
    const identity = coordinator.claim(owner, { runId: "run", ownerId: "owner", conversationId: "thread", windowId: 7 });
    const hasDocument = vi.fn(async () => false);
    await coordinator.cancelClosedWindow(8, hasDocument);
    await coordinator.cancelClosedWindow(7, hasDocument);
    expect(hasDocument).not.toHaveBeenCalled();
    expect(owner.postMessage).not.toHaveBeenCalled();
    coordinator.validate(identity);
  });
});
