import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";

function harness() {
  const command = vi.fn(async (source: chrome.debugger.Debuggee & { sessionId?: string }, method: string, params: any = {}) => {
    if (method === "Page.getFrameTree") return source.sessionId === "nested-child" || source.sessionId === "new-child"
      ? { frameTree: { frame: { id: "nested", url: "https://cross.test/nested", parentId: "cross" } } }
      : source.sessionId ? { frameTree: { frame: { id: "cross", url: "https://cross.test/", parentId: "root" }, childFrames: [{ frame: { id: "nested", parentId: "cross", url: "https://cross.test/nested" } }] } }
      : { frameTree: { frame: { id: "root", url: "https://top.test/" }, childFrames: [
        { frame: { id: "same", parentId: "root", url: "https://top.test/same", name: "same" } },
        { frame: { id: "cross", parentId: "root", url: "https://cross.test/" } },
      ] } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: params.frameId === "same" ? 31 : params.frameId === "cross" ? 32 : 33 };
    if (method === "Runtime.evaluate" && params.expression === "document") return { result: { objectId: `doc-${params.contextId}` } };
    if (method === "Accessibility.queryAXTree") return { nodes: [{ nodeId: "node", backendDOMNodeId: 8, role: { value: "button" }, name: { value: params.objectId ?? "wrong-root" } }] };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-object" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { connected: true, role: "button", name: "Open", tag: "button", text: "Open" } } };
    return {};
  });
  const runtime = new AutomationRuntime({ chromeApi: { tabs: { query: async () => [{ id: 3 }] } } as never,
    command, detach: async () => {}, mark: async () => {} });
  runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
  return { runtime, command };
}

describe("frame tree discovery", () => {
  it("binds stable frame refs to same-process and child-session documents across pages", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Page.frameAttached", { frameId: "cross", parentFrameId: "root" });
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.frameAttached", { frameId: "nested", parentFrameId: "cross" });
    const first: any = await runtime.listFrames(3, { limit: 2 });
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "child" }, "Target.setAutoAttach", expect.objectContaining({ autoAttach: true, flatten: true }));
    expect(first).toMatchObject({ tabId: 3, total: 4, hasMore: true, nextCursor: expect.any(String) });
    const second: any = await runtime.listFrames(3, { limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ total: 4, hasMore: false });
    const all = [...first.frames, ...second.frames];
    const top = all.find((frame) => frame.url === "https://top.test/");
    const same = all.find((frame) => frame.url === "https://top.test/same");
    const cross = all.find((frame) => frame.url === "https://cross.test/");
    const nested = all.find((frame) => frame.url === "https://cross.test/nested");
    expect(same).toMatchObject({ parentFrameRef: top.frameRef, source: { tabId: 3 } });
    expect(cross).toMatchObject({ parentFrameRef: top.frameRef, source: { tabId: 3, sessionId: "child" } });
    expect(nested).toMatchObject({ parentFrameRef: cross.frameRef, source: { tabId: 3, sessionId: "child" } });
    await expect(page.frameRef(same.frameRef).getByRole("button").count()).resolves.toBe(1);
    await expect(page.frameRef(nested.frameRef).getByRole("button").count()).resolves.toBe(1);
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Accessibility.queryAXTree", { objectId: "doc-31", role: "button" });
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "child" }, "Accessibility.queryAXTree", { objectId: "doc-33", role: "button" });
    const search: any = await runtime.findElements(3, page.frameRef(same.frameRef).getByRole("button"));
    expect(search.elements).toMatchObject([{ role: "button", name: "doc-31" }]);
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Accessibility.queryAXTree", { objectId: "doc-31", role: "button" });
    runtime.handleEvent({ tabId: 3 }, "Page.frameDetached", { frameId: "cross" });
    await expect(page.frameRef(nested.frameRef).getByRole("button").count()).rejects.toThrow("stale-frame");
    await expect(runtime.listFrames(3, { cursor: first.nextCursor })).rejects.toThrow("stale-frames");
    await runtime.abortSessions();
  });

  it("retains a nested target session when parent events arrive late, and honors reattachment", async () => {
    const { runtime } = harness(); await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Target.attachedToTarget", { sessionId: "nested-child", targetInfo: { type: "iframe", targetId: "nested" } });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.frameAttached", { frameId: "nested", parentFrameId: "cross" });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.frameNavigated", { frame: { id: "nested", parentId: "cross" } });
    const initial: any = await runtime.listFrames(3);
    expect(initial.frames.find((frame: any) => frame.url.endsWith("/nested"))).toMatchObject({ source: { sessionId: "nested-child" } });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Target.attachedToTarget", { sessionId: "new-child", targetInfo: { type: "iframe", targetId: "nested" } });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Target.detachedFromTarget", { sessionId: "nested-child" });
    const next: any = await runtime.listFrames(3);
    expect(next.frames.find((frame: any) => frame.url.endsWith("/nested"))).toMatchObject({ source: { sessionId: "new-child" } });
    await runtime.abortSessions();
  });

  it("does not reuse a frame cursor in another run or conversation", async () => {
    const { runtime } = harness(); await runtime.createPage(3);
    const first: any = await runtime.listFrames(3, { limit: 1 });
    runtime.setContext({ conversationId: "other", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
    await expect(runtime.listFrames(3, { cursor: first.nextCursor })).rejects.toThrow("stale-frames");
    await expect((await runtime.createPage(3)).frameRef(first.frames[0].frameRef).getByRole("button").count()).rejects.toThrow("stale-frame");
    await runtime.abortSessions();
  });
});
