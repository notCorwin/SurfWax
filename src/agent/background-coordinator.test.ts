import { describe, expect, it, vi } from "vitest";
import { BackgroundRunCoordinator } from "./background-coordinator";
const port = () => ({ postMessage: vi.fn() }) as unknown as chrome.runtime.Port;
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
});
