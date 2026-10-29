import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";

type Node = { id: number; name: string; role: string; connected: boolean };
function harness() {
  const nodes = new Map<number, Node>([
    [1, { id: 1, name: "First", role: "button", connected: true }],
    [2, { id: 2, name: "Second", role: "button", connected: true }],
    [3, { id: 3, name: "Third", role: "button", connected: true }],
  ]);
  let order = [1, 2, 3];
  let next = 0;
  const arrays = new Map<string, number[]>();
  const groupArrays = new Map<string, string[]>();
  const arraysFor = (group: string, values: number[]) => {
    const id = `array:${++next}`;
    arrays.set(id, values); groupArrays.set(group, [...groupArrays.get(group) ?? [], id]);
    return id;
  };
  const command = vi.fn(async (_source: chrome.debugger.Debuggee, method: string, params: any = {}) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "root-node", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: order.map(id => `ax:${id}`) },
      ...order.map(id => nodes.get(id)!).filter(node => node.connected).map(node => ({ nodeId: `ax:${node.id}`, parentId: "root-node", backendDOMNodeId: node.id,
        role: { value: node.role }, name: { value: node.name }, properties: [{ name: "focusable", value: { value: true } }] })),
    ] };
    if (method === "Runtime.evaluate" && params.expression.includes("({url:")) return { result: { value: { url: "https://example.test/", title: "Test" } } };
    if (method === "Runtime.evaluate" && params.expression.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 50, scale: 1 } } };
    if (method === "Accessibility.queryAXTree") return { nodes: order.map(id => nodes.get(id)!).filter(node => node.connected).map(node => ({ backendDOMNodeId: node.id, role: { value: node.role }, name: { value: node.name } })) };
    if (method === "Runtime.evaluate" && params.expression.includes('"nodes"')) return { result: { objectId: arraysFor(params.objectGroup, order.filter(id => nodes.get(id)?.connected)) } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.length}") return { result: { value: arrays.get(params.objectId)?.length } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.slice(start,end)")) {
      const values = arrays.get(params.objectId)!;
      return { result: { objectId: arraysFor(params.objectGroup, values.slice(params.arguments[0].value, params.arguments[1].value)) } };
    }
    if (method === "Runtime.getProperties") return { result: (arrays.get(params.objectId) ?? []).map((id, index) => ({ name: String(index), value: { objectId: `node:${id}` } })) };
    if (method === "DOM.resolveNode") return { object: { objectId: `node:${params.backendNodeId}` } };
    if (method === "DOM.describeNode") return { node: { backendNodeId: Number(params.objectId.split(":")[1]) } };
    if (method === "Runtime.callFunctionOn" && params.objectId?.startsWith("node:")) {
      const node = nodes.get(Number(params.objectId.split(":")[1]));
      if (params.functionDeclaration === "function(){ return this.isConnected; }") return { result: { value: node?.connected ?? false } };
      if (params.functionDeclaration.includes("const el = this")) return { result: { value: { connected: node?.connected ?? false, role: node?.role, name: node?.name.slice(0, 160), text: node?.name.slice(0, 120), tag: "button", ...(node && node.name.length > 160 ? { nameTruncated: true } : {}), ...(node && node.name.length > 120 ? { textTruncated: true } : {}) } } };
      return { result: { value: node?.name } };
    }
    if (method === "Runtime.releaseObjectGroup") { for (const id of groupArrays.get(params.objectGroup) ?? []) arrays.delete(id); groupArrays.delete(params.objectGroup); return {}; }
    return {};
  });
  const runtime = new AutomationRuntime({ chromeApi: { tabs: { query: async () => [{ id: 3 }] } } as never, command,
    mark: vi.fn(async () => {}), detach: vi.fn(async () => {}) });
  const identity = (runId: string) => ({ conversationId: "conversation", logIdentity: { runId, toolCallId: "1:test", toolCallIdCanonical: true as const } });
  runtime.setContext(identity("run"));
  return { runtime, command, nodes, arrays, identity, setOrder: (value: number[]) => { order = value; } };
}

describe("findElements", () => {
  it("paginates the original DOM nodes after reordering, removal and insertion", async () => {
    const h = harness(); const page = await h.runtime.createPage(3); const target = page.locator("button");
    const first: any = await h.runtime.findElements(3, target, { limit: 1 });
    expect(first).toMatchObject({ tabId: 3, documentId: 0, total: 3, hasMore: true, elements: [{ name: "First", ref: expect.stringMatching(/^t3s[a-f0-9]+d0e\d+$/) }] });
    h.nodes.get(2)!.connected = false; h.nodes.set(4, { id: 4, name: "Replacement", role: "button", connected: true }); h.setOrder([3, 4, 1]);
    const second: any = await h.runtime.findElements(3, target, { cursor: first.nextCursor, limit: 1 });
    expect(second).toMatchObject({ total: 3, elements: [{ status: "detached" }], hasMore: true });
    const third: any = await h.runtime.findElements(3, target, { cursor: second.nextCursor, limit: 1 });
    expect(third).toMatchObject({ total: 3, elements: [{ name: "Third" }], hasMore: false });
    expect(await page.ref(first.elements[0].ref).textContent()).toBe("First");
    h.nodes.get(1)!.connected = false;
    await expect(page.ref(first.elements[0].ref).textContent()).rejects.toThrow("detached");
    expect(h.command.mock.calls.filter(([, method, params]: any) => method === "Runtime.evaluate" && params.expression.includes('"nodes"'))).toHaveLength(1);
    await h.runtime.abortSessions();
  });

  it("reuses inspect references for the same backend node and truncates long metadata", async () => {
    const h = harness(); const page = await h.runtime.createPage(3);
    h.nodes.get(1)!.name = "x".repeat(500);
    const inspection = await page.inspect();
    const inspectedRef = (inspection.items as any[]).find((item) => item.ref)?.ref;
    const result: any = await h.runtime.findElements(3, page.getByRole("button"), { limit: 1 });
    expect(result.elements[0]).toMatchObject({ name: "x".repeat(160), nameTruncated: true, text: "x".repeat(120), textTruncated: true, ref: inspectedRef });
    expect(result.elements[0].ref).toMatch(/^t3s[a-f0-9]+d0e\d+$/);
    expect(h.command.mock.calls.filter(([, method]) => method === "Accessibility.queryAXTree")).toHaveLength(1);
    await h.runtime.abortSessions();
  });

  it("rejects cursors across target, run, conversation, navigation and session cleanup", async () => {
    const h = harness(); const page = await h.runtime.createPage(3); const target = page.locator("button");
    const first: any = await h.runtime.findElements(3, target, { limit: 1 });
    await expect(h.runtime.findElements(3, page.locator("input"), { cursor: first.nextCursor })).rejects.toThrow("stale-search");
    h.runtime.setContext(h.identity("other"));
    await expect(h.runtime.findElements(3, target, { cursor: first.nextCursor })).rejects.toThrow("stale-search");
    h.runtime.setContext({ ...h.identity("run"), conversationId: "other" });
    await expect(h.runtime.findElements(3, target, { cursor: first.nextCursor })).rejects.toThrow("stale-search");
    h.runtime.setContext(h.identity("run"));
    h.runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    await expect(h.runtime.findElements(3, target, { cursor: first.nextCursor })).rejects.toThrow("stale-search");
    expect(h.arrays.size).toBe(0);
    const next: any = await h.runtime.findElements(3, target, { limit: 1 });
    await h.runtime.abortSessions();
    await expect(h.runtime.findElements(3, target, { cursor: next.nextCursor })).rejects.toThrow("stale-search");
    await h.runtime.abortSessions();
  });

  it("reports a CDP failure accurately and releases the incomplete snapshot", async () => {
    const h = harness(); const page = await h.runtime.createPage(3);
    const original = h.command.getMockImplementation()!;
    h.command.mockImplementation(async (source, method, params: any) => {
      if (method === "DOM.describeNode") throw new Error("CDP connection failed");
      return original(source, method, params);
    });
    await expect(h.runtime.findElements(3, page.locator("button"), { limit: 1 })).rejects.toThrow("CDP connection failed");
    expect(h.arrays.size).toBe(0);
    await h.runtime.abortSessions();
  });

  it("evicts old snapshots and releases their remote groups", async () => {
    const h = harness(); const page = await h.runtime.createPage(3); const target = page.locator("button");
    const first: any = await h.runtime.findElements(3, target, { limit: 1 });
    for (let i = 0; i < 32; i++) await h.runtime.findElements(3, target, { limit: 1 });
    await expect(h.runtime.findElements(3, target, { cursor: first.nextCursor })).rejects.toThrow("stale-search");
    expect(h.command.mock.calls.filter(([, method]) => method === "Runtime.releaseObjectGroup").length).toBeGreaterThanOrEqual(1);
    await h.runtime.abortSessions();
    expect(h.arrays.size).toBe(0);
  });

  it("does not return refs if navigation occurs while page resources are being released", async () => {
    const h = harness(); const page = await h.runtime.createPage(3); const original = h.command.getMockImplementation()!;
    let resume!: () => void; let notify!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; }); const started = new Promise<void>(resolve => { notify = resolve; });
    h.command.mockImplementation(async (source, method, params: any) => {
      if (method === "Runtime.releaseObject") { notify(); await hold; }
      return original(source, method, params);
    });
    const pending = h.runtime.findElements(3, page.locator("button"), { limit: 1 });
    await started;
    h.runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    resume();
    await expect(pending).rejects.toThrow("stale-search");
    await h.runtime.abortSessions();
  });

  it.each(["navigation", "session-closed", "abort"] as const)("rejects a snapshot when %s interrupts capture", async (event) => {
    const h = harness(); const page = await h.runtime.createPage(3); const target = page.locator("button");
    const original = h.command.getMockImplementation()!; let resume!: () => void; let notify!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; }); const started = new Promise<void>(resolve => { notify = resolve; });
    h.command.mockImplementation(async (source, method, params: any) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.length}") { notify(); await hold; }
      return original(source, method, params);
    });
    const controller = new AbortController(); h.runtime.setContext({ ...h.identity("run"), signal: controller.signal });
    const pending = h.runtime.findElements(3, target, { limit: 1 });
    await started;
    if (event === "navigation") h.runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    else if (event === "session-closed") await h.runtime.abortSessions();
    else controller.abort();
    resume();
    await expect(pending).rejects.toThrow(event === "abort" ? /abort/i : /stale-search/);
    expect(h.arrays.size).toBe(0);
    await h.runtime.abortSessions();
  });
});
