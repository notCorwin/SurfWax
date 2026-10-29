import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";

function harness() {
  const command = vi.fn(async (source: chrome.debugger.Debuggee & { sessionId?: string }, method: string, params: any = {}): Promise<any> => {
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
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 8, role: { value: "button" }, name: { value: "doc-31" } }] };
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
  it.each([false, true])("restarts AX capture when a child attaches in flight (first request fails: %s)", async (failFirst) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    let rootCaptures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        if (!source.sessionId && ++rootCaptures === 1) {
          notify(); await hold;
          if (failFirst) throw new Error("target changed during capture");
        }
        const child = Boolean(source.sessionId);
        return { nodes: [{ nodeId: child ? "child-ax" : "root-ax", role: { value: "button" }, name: { value: child ? "Child target" : "Root target" }, childIds: [] }] };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const pending = page.inspect();
    await started;
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    release();
    const result: any = await pending;
    expect(result.items.map((item: any) => item.line).join("\n")).toContain('button "Child target"');
    expect(rootCaptures).toBe(2);
    expect(command.mock.calls.filter(([source, method]) => source.sessionId === "child" && method === "Accessibility.getFullAXTree")).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("captures only the target session for a cross-process region", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "target-ax", backendDOMNodeId: 8, role: { value: "button" }, name: { value: "Regional target" }, childIds: [] }] };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3);
    const cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    const result: any = await page.inspect({}, page.frameRef(cross.frameRef).getByRole("button"));
    expect(result.items.map((item: any) => item.line).join("\n")).toContain('button "Regional target"');
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.getFullAXTree")).toEqual([[{ tabId: 3, sessionId: "child" }, "Accessibility.getFullAXTree", {}]]);
    await runtime.abortSessions();
  });

  it("does not return a capture after cancellation while AX is in flight", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") { notify(); await hold; return { nodes: [] }; }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3);
    const pending = page.inspect();
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
    await runtime.abortSessions();
  });

  it("consumes an AX rejection when cancellation occurs synchronously at dispatch", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        controller.abort();
        return await new Promise((_resolve, reject) => { rejectLate = reject; });
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3);
    await expect(page.snapshot()).rejects.toMatchObject({ name: "AbortError" });
    rejectLate(new Error("late AX failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.abortSessions();
  });

  it("rejects a region capture when its session detaches during node description", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.describeNode") { notify(); await hold; return { node: { backendNodeId: 8 } }; }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3);
    const cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    const pending = page.inspect({}, page.frameRef(cross.frameRef).getByRole("button"));
    await started;
    const rejected = expect(pending).rejects.toMatchObject({ code: "stale-session" });
    runtime.handleDetach({ tabId: 3 });
    await rejected;
    release();
    await runtime.abortSessions();
  });

  it("releases a region object that resolves after its session detaches", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.resolveNode") { notify(); await hold; return { object: { objectId: "late-region" } }; }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3);
    const cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    const pending = page.inspect({}, page.frameRef(cross.frameRef).getByRole("button"));
    await started;
    const rejected = expect(pending).rejects.toMatchObject({ code: "stale-session" });
    runtime.handleDetach({ tabId: 3 });
    await rejected;
    release();
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "child" }, "Runtime.releaseObject", { objectId: "late-region" }));
    await runtime.abortSessions();
  });

  it.each(["detach", "abortSessions"] as const)("rejects an in-flight snapshot after %s removes its session", async (mode) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") { notify(); await hold; return { nodes: [] }; }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const pending = page.snapshot();
    await started;
    const rejected = expect(pending).rejects.toMatchObject({ code: "stale-session" });
    if (mode === "detach") runtime.handleDetach({ tabId: 3 });
    else await runtime.abortSessions();
    // Reusing the same tab id must not revive the old session's capture.
    await runtime.createPage(3);
    await rejected;
    release();
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.getFullAXTree")).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("reuses a frame document within one context and invalidates it on context destruction and cleanup", async () => {
    const { runtime, command } = harness(); const page = await runtime.createPage(3);
    const frames: any = await runtime.listFrames(3);
    const same = frames.frames.find((frame: any) => frame.url.endsWith("/same"));
    const target = page.frameRef(same.frameRef).getByRole("button");
    await Promise.all([target.count(), target.count(), target.count()]);
    expect(command.mock.calls.filter(([, method]) => method === "Page.createIsolatedWorld")).toHaveLength(1);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.evaluate" && params.expression === "document")).toHaveLength(1);
    runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextDestroyed", { executionContextId: 31 });
    await target.count();
    expect(command.mock.calls.filter(([, method]) => method === "Page.createIsolatedWorld")).toHaveLength(2);
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Runtime.releaseObject", { objectId: "doc-31" });
    await runtime.clearContext();
    runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
    await target.count();
    expect(command.mock.calls.filter(([, method]) => method === "Page.createIsolatedWorld")).toHaveLength(3);
    await runtime.abortSessions();
  });

  it("releases a frame document that arrives after context cleanup", async () => {
    const { runtime, command } = harness(); const page = await runtime.createPage(3);
    const frames: any = await runtime.listFrames(3);
    const same = frames.frames.find((frame: any) => frame.url.endsWith("/same"));
    const original = command.getMockImplementation()!;
    let resume!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { resume = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params: any = {}) => {
      if (method === "Runtime.evaluate" && params.expression === "document") { notify(); await hold; }
      return original(source, method, params);
    });
    const pending = page.frameRef(same.frameRef).getByRole("button").count();
    await started;
    await runtime.clearContext();
    resume();
    await expect(pending).rejects.toThrow("stale-frame");
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Runtime.releaseObject", { objectId: "doc-31" });
    await runtime.abortSessions();
  });

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
