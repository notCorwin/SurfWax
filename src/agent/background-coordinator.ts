import type { RunIdentity } from "./coordinator";

/** Transient ownership only: durable run facts remain in the event log. */
export class BackgroundRunCoordinator {
  private generation = 0;
  private owner?: RunIdentity & { conversationId: string; windowId?: number; port: chrome.runtime.Port; cancelled: boolean };
  private operations = new Set<string>();
  maintenance = false;
  claim(port: chrome.runtime.Port, request: { runId: string; ownerId: string; conversationId: string; windowId?: number }): RunIdentity {
    if (this.maintenance) throw new Error("日志正在维护，请稍后重试。");
    if (this.owner) throw new Error("已有任务运行，请在原侧栏停止任务。");
    this.owner = { ...request, generation: ++this.generation, port, cancelled: false };
    this.operations.clear();
    return this.identity()!;
  }
  owns(port: chrome.runtime.Port): boolean { return this.owner?.port === port; }
  identity(): RunIdentity | undefined {
    const owner = this.owner;
    return owner ? { runId: owner.runId, ownerId: owner.ownerId, generation: owner.generation } : undefined;
  }
  validate(identity: RunIdentity | undefined, operationId?: string): void {
    const owner = this.owner;
    if (this.maintenance || !owner || owner.cancelled || !identity || identity.runId !== owner.runId || identity.ownerId !== owner.ownerId || identity.generation !== owner.generation) {
      throw new DOMException("运行已取消或所有权失效。", "AbortError");
    }
    if (operationId) {
      if (this.operations.has(operationId)) throw new Error("Operation already accepted");
      this.operations.add(operationId);
    }
  }
  cancelWindow(windowId: number): void { if (this.owner?.windowId === windowId) this.cancel(undefined, "sidepanel-closed"); }
  cancel(port?: chrome.runtime.Port, reason = "log-cleared"): void {
    if (!this.owner || port && this.owner.port !== port) return;
    this.owner.cancelled = true;
    try { this.owner.port.postMessage({ type: "abort", reason }); } catch { /* Owner disconnected. */ }
  }
  release(port: chrome.runtime.Port): { runId: string; conversationId: string; cancelled: boolean } | undefined {
    if (this.owner?.port !== port) return;
    const previous = this.owner;
    this.owner = undefined;
    this.operations.clear();
    return previous;
  }
}
