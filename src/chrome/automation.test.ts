import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";
import { encodeLogGraph } from "../log-graph";
import { EventSubscriptions } from "./event-subscriptions";
import { ProgramScope } from "./program";
import type { EventLogger } from "../logging";

const inspectText = (value: any) => value.items.map((item: any) => item.line).join("\n");

function fillReferencePool(runtime: AutomationRuntime, count: number) {
  const session = (runtime as any).sessions.get(3);
  for (let index = 0; index < count; index++) (runtime as any).rememberRef(session, `seed:${index}`, {
    backendNodeId: index + 100_000, debuggee: session.debuggee, role: "button", name: `seed-${index}`,
    generation: session.generation, identitySource: "ax",
  });
  return session;
}

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    emit: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
  };
}

const sessionIdOf = (source: chrome.debugger.Debuggee) => (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId;

function harness(
  metadata: object[] | undefined = [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }],
  states: object[] = [{ connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false }],
  logger?: { record: ReturnType<typeof vi.fn> },
  onDispatch = vi.fn(async (): Promise<void> => undefined),
  claimChooser?: (chooser: any) => { assert: () => void; finish: (outcome: "handled" | "not-dispatched" | "uncertain") => void },
  refreshGuard?: (tabId: number) => Promise<void>,
) {
  metadata ??= [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }];
  const calls: Array<{ method: string; params?: any }> = [];
  let latestState: any = states[0];
  const tabsCreated = event<(tab: chrome.tabs.Tab) => void>();
  const downloadsCreated = event<(item: chrome.downloads.DownloadItem) => void>();
  const command = vi.fn(async (_debuggee: chrome.debugger.Debuggee, method: string, params?: any): Promise<any> => {
    calls.push({ method, params });
    if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 0 }] };
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: metadata.map((_, index) => `node-${index}`) },
      ...metadata.map((item: any, index) => ({
        nodeId: `node-${index}`,
        parentId: "root",
        backendDOMNodeId: 7 + index,
        role: { value: item.role },
        name: { value: item.name },
        properties: [{ name: "focusable", value: { value: true } }],
      })),
    ] };
    if (method === "Accessibility.queryAXTree") return { nodes: metadata.map((item: any, index) => ({
      nodeId: `node-${index}`, backendDOMNodeId: 7 + index, role: { value: item.role }, name: { value: item.name },
    })) };
    if (method === "Accessibility.getPartialAXTree") {
      const item = metadata[params.backendNodeId - 7] as any;
      return { nodes: item ? [{ backendDOMNodeId: params.backendNodeId, role: { value: item.role }, name: { value: item.name } }] : [] };
    }
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("/* surf-wax:evaluate-graph */")) return { result: { value: encodeLogGraph(true) } };
      if (params.expression.includes('"nodes"')) return { result: { objectId: "node-array" } };
      if (params.returnByValue === false) return { result: { objectId: "node-1" } };
      if (params.expression.includes("metadata")) return { result: { value: metadata } };
      if (params.expression.includes("({url:")) return { result: { value: { url: "https://example.test/", title: "Test" } } };
      if (params.expression.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 50, scale: 2 } } };
      if (params.expression.includes("({width:innerWidth")) return { result: { value: { width: 100, height: 50 } } };
      return { result: { value: true } };
    }
    if (method === "Runtime.callFunctionOn" && params.objectId === "node-array") {
      if (params.functionDeclaration === "function(){return this.length}") return { result: { value: metadata.length } };
      if (params.functionDeclaration === "function(){return this[0]}") return { result: { objectId: "node-1" } };
      if (params.functionDeclaration.includes("this.slice(0,10)")) return { result: { value: metadata.slice(0, 10) } };
    }
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){ return this.isConnected; }") return { result: { value: (states[0] as any)?.connected ?? false } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function() { /* surf-wax:text-input-kind */")) return { result: { value: "text" } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("identityRole")) {
      const item = metadata[0] as any;
      return { result: { value: { connected: true, identityRole: item?.role ?? "", identityName: item?.name ?? "", role: item?.role ?? "", name: item?.name ?? "" } } };
    }
    if (method === "Runtime.callFunctionOn") { latestState = states.length > 1 ? states.shift() : states[0]; return { result: { value: latestState } }; }
    if (method === "DOM.getContentQuads") return { quads: [[latestState.x - 1, latestState.y - 1, latestState.x + 1, latestState.y - 1, latestState.x + 1, latestState.y + 1, latestState.x - 1, latestState.y + 1]] };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 7 };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "Page.captureScreenshot") return { data: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)) };
    return {};
  });
  const detach = vi.fn(async () => undefined);
  const pressChord = vi.fn(async (_debuggee: any, _chord: string, _signal?: AbortSignal) => undefined);
  const runtime = new AutomationRuntime({
    chromeApi: { tabs: { query: async () => [{ id: 3 }], onCreated: tabsCreated }, downloads: { onCreated: downloadsCreated } } as never,
    command,
    pressChord,
    detach,
    mark: vi.fn(async () => undefined),
    refreshGuard,
    onDispatch,
    claimChooser,
    logger: logger as never,
  });
  return { runtime, calls, command, pressChord, detach, tabsCreated, onDispatch };
}

describe("AutomationRuntime", () => {
  it("waits for document load before collecting a semantic snapshot", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let ready = false;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression === "document.readyState === 'complete'") return { result: { value: ready } };
      return original(source, method, params);
    });
    command.mockClear();
    const pending = page.inspect();
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "Runtime.evaluate", expect.objectContaining({ expression: "document.readyState === 'complete'" })));
    expect(command).not.toHaveBeenCalledWith(expect.anything(), "Accessibility.getFullAXTree", expect.anything());
    ready = true;
    await expect(pending).resolves.toMatchObject({ mode: "full" });
    expect(command).toHaveBeenCalledWith(expect.anything(), "Accessibility.getFullAXTree", expect.anything());
    await runtime.abortSessions();
  });
  it("rejects a chord for single-key down and up operations", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    command.mockClear();
    await expect(runtime.keyState(3, "keydown", "Control+a")).rejects.toMatchObject({ code: "invalid-key" });
    await expect(runtime.keyState(3, "keyup", "Control+a")).rejects.toMatchObject({ code: "invalid-key" });
    expect(command).not.toHaveBeenCalledWith(expect.anything(), "Input.dispatchKeyEvent", expect.anything());
    await runtime.abortSessions();
  });
  it("preserves a new OOPIF attachment when its old renderer later reports a swap", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    let requested!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<void>((resolve) => { release = resolve; });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "new" && method === "Page.enable") { requested(); await response; return {}; }
      if (sessionIdOf(source) === "new" && method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    session.frames.set("frame", { tabId: 3 });
    session.frameParents.set("frame", "root");
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "new", targetInfo: { type: "iframe", targetId: "frame" } });
    const ready = session.frameReady.get("new") as Promise<void>;
    await waiting;
    runtime.handleEvent({ tabId: 3 }, "Page.frameDetached", { frameId: "frame", reason: "swap" });
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    release();
    await ready;
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    await runtime.abortSessions();
  });

  it("retains ancestry when a swap precedes attachment, but removes a genuinely detached frame", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    session.frames.set("frame", { tabId: 3 });
    session.frameParents.set("frame", "root");
    runtime.handleEvent({ tabId: 3 }, "Page.frameDetached", { frameId: "frame", reason: "swap" });
    expect(session.frames.has("frame")).toBe(false);
    expect(session.frameParents.get("frame")).toBe("root");
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "new" && method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      return original(source, method, params);
    });
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "new", targetInfo: { type: "iframe", targetId: "frame" } });
    await session.frameReady.get("new");
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    runtime.handleEvent({ tabId: 3 }, "Page.frameDetached", { frameId: "frame", reason: "remove" });
    expect(session.frames.has("frame")).toBe(false);
    expect(session.frameParents.has("frame")).toBe(false);
    await runtime.abortSessions();
  });

  it("does not let a stale child target's swap or detach remove its replacement", async () => {
    const { runtime } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    session.frames.set("frame", { tabId: 3, sessionId: "new" });
    session.frameParents.set("frame", "root");
    runtime.handleEvent({ tabId: 3, sessionId: "old" }, "Page.frameDetached", { frameId: "frame", reason: "swap" });
    runtime.handleEvent({ tabId: 3 }, "Target.detachedFromTarget", { sessionId: "old" });
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    await runtime.abortSessions();
  });

  it("uses an isolated frame document when a same-process frame is not script-accessible", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    session.frames.set("frame", { tabId: 3 });
    vi.spyOn(runtime as any, "resolveDirect").mockResolvedValue("owner");
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode" && params.objectId === "owner") return { node: { frameId: "frame" } };
      if (method === "Runtime.callFunctionOn" && params.objectId === "owner" && params.functionDeclaration.includes("contentDocument")) return { result: { value: false } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
      if (method === "Runtime.evaluate" && params.contextId === 42) return { result: { objectId: "frame-document" } };
      return original(source, method, params);
    });
    try {
      const scoped = await (runtime as any).locatorScope(session, { queries: [{ kind: "frame", value: "#frame" }, { kind: "css", value: "#button" }] });
      expect(scoped.rootObjectId).toBe("frame-document");
      expect(scoped.spec.queries).toEqual([{ kind: "css", value: "#button" }]);
    } finally { await runtime.abortSessions(); }
  });

  it("rechecks the target when a frame is still attaching to its own process", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    session.frames.set("frame", { tabId: 3 });
    vi.spyOn(runtime as any, "resolveDirect").mockResolvedValue("owner");
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode" && params.objectId === "owner") return { node: { frameId: "frame" } };
      if (method === "Runtime.callFunctionOn" && params.objectId === "owner" && params.functionDeclaration.includes("contentDocument")) return { result: { value: false } };
      if (method === "Page.createIsolatedWorld") {
        session.frames.set("frame", { tabId: 3, sessionId: "child" });
        session.frameReady.set("child", Promise.resolve());
        throw new Error("No frame with given id found");
      }
      return original(source, method, params);
    });
    try {
      const scoped = await (runtime as any).locatorScope(session, { queries: [{ kind: "frame", value: "#frame" }, { kind: "css", value: "#button" }] });
      expect(scoped.debuggee.sessionId).toBe("child");
      expect(scoped.spec.queries).toEqual([{ kind: "css", value: "#button" }]);
    } finally { await runtime.abortSessions(); }
  });

  it("does not restore a detached frame from an in-flight frame-tree request", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    let requested!: () => void, release!: (tree: object) => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<object>((resolve) => { release = resolve; });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "old" && method === "Page.getFrameTree") { requested(); return response; }
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "old", targetInfo: { type: "iframe", targetId: "frame" } });
    const ready = session.frameReady.get("old") as Promise<void>;
    await waiting;
    runtime.handleEvent({ tabId: 3 }, "Target.detachedFromTarget", { sessionId: "old" });
    release({ frameTree: { frame: { id: "frame", parentId: "root" }, childFrames: [{ frame: { id: "child", parentId: "frame" } }] } });
    await expect(ready).rejects.toMatchObject({ code: "frame-detached" });
    expect(session.frames.has("frame")).toBe(false);
    expect(session.frames.has("child")).toBe(false);
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old" }), "Target.setAutoAttach", expect.anything());
    await runtime.abortSessions();
  });

  it("does not let a previous attachment overwrite a newer target session", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    let requested!: () => void, release!: (tree: object) => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<object>((resolve) => { release = resolve; });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree" && sessionIdOf(source) === "old") { requested(); return response; }
      if (method === "Page.getFrameTree" && sessionIdOf(source) === "new") return { frameTree: { frame: { id: "frame", parentId: "root" } } };
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    const attach = (sessionId: string) => runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId: "frame" } });
    attach("old");
    const oldReady = session.frameReady.get("old") as Promise<void>;
    await waiting;
    runtime.handleEvent({ tabId: 3, sessionId: "old" }, "Target.attachedToTarget", { sessionId: "old-child-session", targetInfo: { type: "iframe", targetId: "old-child-target" } });
    await session.frameReady.get("old-child-session");
    attach("new");
    await session.frameReady.get("new");
    expect([...session.frameReady.keys()]).toEqual(["new"]);
    expect(session.frames.has("old-child-target")).toBe(false);
    expect(session.targetParents.has("old-child-session")).toBe(false);
    runtime.handleEvent({ tabId: 3, sessionId: "old" }, "Target.attachedToTarget", { sessionId: "late-child", targetInfo: { type: "iframe", targetId: "late-child-target" } });
    expect(session.frameReady.has("late-child")).toBe(false);
    release({ frameTree: { frame: { id: "frame", parentId: "old-parent" }, childFrames: [{ frame: { id: "old-child", parentId: "frame" } }] } });
    await expect(oldReady).rejects.toMatchObject({ code: "frame-detached" });
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    expect(session.frames.has("old-child")).toBe(false);
    await expect((runtime as any).observationDebuggees(3)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "new" })]));
    runtime.handleEvent({ tabId: 3 }, "Target.detachedFromTarget", { sessionId: "old" });
    expect(session.frameReady.has("new")).toBe(true);
    expect(session.frames.get("frame").sessionId).toBe("new");
    await runtime.abortSessions();
  });

  it("ignores late frame lifecycle events from a retired target session", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree" && sessionIdOf(source) === "new") return { frameTree: { frame: { id: "frame", parentId: "root" } } };
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    for (const id of ["old", "new"]) {
      runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: id, targetInfo: { type: "iframe", targetId: "frame" } });
      await session.frameReady.get(id);
    }
    const stale = { tabId: 3, sessionId: "old" };
    runtime.handleEvent(stale, "Page.frameAttached", { frameId: "ghost", parentFrameId: "frame" });
    runtime.handleEvent(stale, "Page.frameNavigated", { frame: { id: "frame", parentId: "wrong-parent" } });
    runtime.handleEvent(stale, "Page.frameDetached", { frameId: "frame", reason: "remove" });
    expect(session.frames.has("ghost")).toBe(false);
    expect(session.frames.get("frame").sessionId).toBe("new");
    expect(session.frameParents.get("frame")).toBe("root");
    await runtime.abortSessions();
  });

  it("retires pending descendant attachments when their parent target is replaced", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "parent-old", targetInfo: { type: "iframe", targetId: "parent-frame" } });
    await session.frameReady.get("parent-old");
    let requested!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<void>((resolve) => { release = resolve; });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "child-old" && method === "Page.enable") { requested(); await response; return {}; }
      return original(source, method, params);
    });
    const oldParent = { tabId: 3, sessionId: "parent-old" };
    runtime.handleEvent(oldParent, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "parent-frame" });
    runtime.handleEvent(oldParent, "Target.attachedToTarget", { sessionId: "child-old", targetInfo: { type: "iframe", targetId: "child-frame" } });
    const oldChildReady = session.frameReady.get("child-old") as Promise<void>;
    await waiting;
    // Promotion of a same-process child must not retire its parent.
    expect(session.frameReady.has("parent-old")).toBe(true);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "parent-new", targetInfo: { type: "iframe", targetId: "parent-frame" } });
    await session.frameReady.get("parent-new");
    release();
    await expect(oldChildReady).rejects.toMatchObject({ code: "frame-detached" });
    expect([...session.frameReady.keys()]).toEqual(["parent-new"]);
    expect(session.frames.has("child-frame")).toBe(false);
    await expect((runtime as any).observationDebuggees(3)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "parent-new" })]));
    await runtime.abortSessions();
  });

  it.each(["abort", "detach"] as const)("ignores pending attachment work after %s", async (method) => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    let requested!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<void>((resolve) => { release = resolve; });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "old" && method === "Page.enable") { requested(); await response; return {}; }
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "old", targetInfo: { type: "iframe", targetId: "frame" } });
    const ready = session.frameReady.get("old") as Promise<void>;
    await waiting;
    if (method === "abort") await runtime.abortSessions(); else runtime.handleDetach({ tabId: 3 });
    release();
    await expect(ready).rejects.toMatchObject({ code: "frame-detached" });
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old" }), "Runtime.enable", expect.anything());
    expect((runtime as any).sessions.has(3)).toBe(false);
  });

  it("retries a frame-tree snapshot invalidated while it was being fetched", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    let requested!: () => void, release!: (tree: object) => void;
    const waiting = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<object>((resolve) => { release = resolve; });
    let reads = 0;
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (sessionIdOf(source) === "child" && method === "Page.getFrameTree") {
        if (++reads === 1) { requested(); return response; }
        return { frameTree: { frame: { id: "frame", parentId: "root" }, childFrames: [{ frame: { id: "new", parentId: "frame" } }] } };
      }
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "frame" } });
    const ready = session.frameReady.get("child") as Promise<void>;
    await waiting;
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.frameAttached", { frameId: "new", parentFrameId: "frame" });
    release({ frameTree: { frame: { id: "frame", parentId: "root" }, childFrames: [{ frame: { id: "old", parentId: "frame" } }] } });
    await ready;
    expect(reads).toBe(2);
    expect(session.frames.has("old")).toBe(false);
    expect(session.frames.get("new").sessionId).toBe("child");
    await runtime.abortSessions();
  });

  it("scopes same-process frames inside an OOPIF and finds later target boundaries", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    const outer = { tabId: 3, sessionId: "outer-session" };
    const nested = { tabId: 3, sessionId: "nested-session" };
    session.frames.set("outer-frame", outer);
    session.frames.set("same-frame", outer);
    session.frames.set("nested-frame", nested);
    const resolved: string[][] = [];
    vi.spyOn(runtime as any, "resolveDirect").mockImplementation(async (_debuggee, spec) => {
      const values = (spec as { queries: Array<{ value: string }> }).queries.map((query) => query.value);
      resolved.push(values);
      return values.at(-1);
    });
    vi.spyOn(runtime as any, "frameDocument").mockResolvedValue("same-frame-document");
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => method === "DOM.describeNode"
      ? { node: { frameId: ({ "#outer": "outer-frame", "#same": "same-frame", "#nested": "nested-frame" } as Record<string, string>)[params.objectId] } }
      : original(source, method, params));
    const query = (value: string) => ({ kind: "frame", value });
    try {
      const same = await (runtime as any).locatorScope(session, { queries: [query("#outer"), query("#same"), { kind: "css", value: "#target" }] });
      expect(same.debuggee).toEqual(outer);
      expect(same.rootObjectId).toBe("same-frame-document");
      expect(same.spec.queries.map((item: any) => item.value)).toEqual(["#target"]);
      const crossing = await (runtime as any).locatorScope(session, { queries: [query("#outer"), query("#same"), query("#nested"), { kind: "css", value: "#target" }] });
      expect(crossing.debuggee).toEqual(nested);
      expect(crossing.spec.queries.map((item: any) => item.value)).toEqual(["#target"]);
      expect(resolved).toContainEqual(["#nested"]);
    } finally { await runtime.abortSessions(); }
  });

  it("uses the flattened tree consistently when reading inherited disabled state", async () => {
    const host = document.createElement("div");
    const button = document.createElement("button");
    button.textContent = "Sign in";
    host.append(button);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div aria-disabled="true"><slot></slot></div>';
    document.body.append(host);
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && (params.functionDeclaration.startsWith("function(condition)")
        || params.functionDeclaration.startsWith("function(scroll, pointer)"))) {
        const call = new Function(`return (${params.functionDeclaration})`)();
        return { result: { value: call.apply(button, params.arguments.map((argument: any) => argument.value)) } };
      }
      return original(source, method, params);
    });
    try {
      const locator = page.getByRole("button", { name: "Sign in" });
      await expect(locator.readCondition("enabled")).resolves.toEqual({ present: true, actual: false });
      await expect(locator.isEnabled()).resolves.toBe(false);
      button.setAttribute("aria-disabled", "FALSE");
      await expect(locator.readCondition("enabled")).resolves.toEqual({ present: true, actual: true });
      await expect(locator.isEnabled()).resolves.toBe(true);
      button.disabled = true;
      await expect(locator.readCondition("enabled")).resolves.toEqual({ present: true, actual: false });
      await expect(locator.isEnabled()).resolves.toBe(false);
    } finally { host.remove(); await runtime.abortSessions(); }
  });

  it("records an uncertain effect when the dispatched focus command fails", async () => {
    const records: any[] = [];
    const logger = { append: async (event: any) => { records.push(event); return { id: records.length, ...event }; } } as unknown as EventLogger;
    const scope = new ProgramScope(new AbortController().signal, "job", { conversationId: "c" }, logger);
    const { runtime, command } = harness(undefined, undefined, undefined, vi.fn(() => scope.dispatched()));
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.focus") throw new Error("focus delivery failed");
      return original(source, method, params);
    });
    await expect(scope.call("focus", () => page.getByRole("button", { name: "Sign in" }).focus())).rejects.toMatchObject({ effectUnknown: true });
    expect(records.filter((event) => event.content.operation === "focus").map((event) => event.content.state)).toEqual(["not-dispatched", "dispatched-unknown", "dispatched-unknown"]);
    await runtime.abortSessions();
  });

  it("rejects redirected focus before sending input to a different element", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused: false } } };
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).fill("secret"))
      .rejects.toMatchObject({ code: "focus-lost", effectUnknown: true });
    expect(command.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
    await runtime.abortSessions();
  });

  it("stops sequential insertion after focus moves and reports the partial effect", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let focused = true;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused, editable: true } } };
      if (method === "Input.insertText") { focused = false; return {}; }
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).pressSequentially("abc"))
      .rejects.toMatchObject({ code: "focus-lost", effectUnknown: true });
    expect(command.mock.calls.filter(([, method]) => method === "Input.insertText").map(([, , params]) => params.text)).toEqual(["a"]);
    await runtime.abortSessions();
  });

  it("stops fill when focus makes the input non-editable", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let editable = true;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused: true, editable } } };
      if (method === "DOM.focus") editable = false;
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).fill("replacement"))
      .rejects.toMatchObject({ code: "not-editable", effectUnknown: true });
    expect(command.mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
    await runtime.abortSessions();
  });

  it("stops sequential insertion when the input becomes readonly after the first character", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let editable = true;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused: true, editable } } };
      if (method === "Input.insertText") editable = false;
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).pressSequentially("abc"))
      .rejects.toMatchObject({ code: "not-editable", effectUnknown: true });
    expect(command.mock.calls.filter(([, method]) => method === "Input.insertText").map(([, , params]) => params.text)).toEqual(["a"]);
    await runtime.abortSessions();
  });

  it("reports uncertain targeted press failures from the chord executor", async () => {
    const { runtime, command, pressChord } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused: true, editable: true } } };
      return original(source, method, params);
    });
    pressChord.mockRejectedValueOnce(new Error("uncertain keydown"));
    await expect(page.getByRole("button", { name: "Sign in" }).press("x"))
      .rejects.toMatchObject({ message: "uncertain keydown", effectUnknown: true });
    expect(pressChord).toHaveBeenCalledWith(expect.objectContaining({ tabId: 3 }), "x", undefined, expect.any(Function));
    await runtime.abortSessions();
  });

  it("applies filters and indexes at their position in a locator chain", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    document.body.innerHTML = '<article><span>chosen</span><button>One</button><button>Two</button></article><article><span>other</span><button>Three</button></article>';
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params: any) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("function(spec, metadata, rootDocument, refs)"))
        return { result: { value: window.eval(params.expression) } };
      return original(source, method, params);
    });
    try {
      await expect(page.locator("article").filter({ hasText: "chosen" }).locator("button").count()).resolves.toBe(2);
      await expect(page.locator("article").nth(1).first().locator("button").count()).resolves.toBe(1);
      await expect(page.locator("article").filter({ hasText: "chosen" }).filter({ hasText: "other" }).locator("button").count()).resolves.toBe(0);
    } finally {
      document.body.innerHTML = "";
      await runtime.abortSessions();
    }
  });

  it("rejects an expired reference in a nested locator", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const inspection = await page.inspect() as any;
    const ref = inspection.items.find((item: any) => item.ref).ref;
    const nested = page.locator("div").filter({ has: page.ref(ref) });
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    await expect(nested.count()).rejects.toMatchObject({ code: "stale-ref" });
    await runtime.abortSessions();
  });

  it("rejects cross-tab filters, regions and search locators", async () => {
    const { runtime } = harness();
    const first = await runtime.createPage(3), second = await runtime.createPage(4);
    const otherRuntime = harness().runtime, sameTabOtherRuntime = await otherRuntime.createPage(3);
    expect(() => first.locator("div").filter({ has: second.locator("button") })).toThrow("invalid-target");
    expect(() => first.locator("div").filter({ has: sameTabOtherRuntime.locator("button") })).toThrow("invalid-target");
    expect(() => first.inspect({}, second.locator("button"))).toThrow("invalid-target");
    expect(() => first.inspect({}, sameTabOtherRuntime.locator("button"))).toThrow("invalid-target");
    await expect(runtime.findElements(3, second.locator("button"))).rejects.toMatchObject({ code: "invalid-target" });
    await expect(runtime.findElements(3, sameTabOtherRuntime.locator("button"))).rejects.toMatchObject({ code: "invalid-target" });
    await expect(first.locator("button").dragTo(second.locator("button"))).rejects.toMatchObject({ code: "invalid-target" });
    await expect(first.locator("button").dragTo(sameTabOtherRuntime.locator("button"))).rejects.toMatchObject({ code: "invalid-target" });
    await runtime.abortSessions();
    await otherRuntime.abortSessions();
  });

  it("does not report a missing checked target as unchecked", async () => {
    const { runtime } = harness([]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("checkbox", { name: "Missing" }).isChecked()).rejects.toMatchObject({ code: "not-found" });
    await runtime.abortSessions();
  });

  it("does not interpret browser protocol errors as a hidden or detached target", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("function(scroll, pointer)")) throw new Error("Debugger connection closed");
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).waitFor({ state: "hidden" })).rejects.toThrow("Debugger connection closed");
    await expect(page.getByRole("button", { name: "Sign in" }).click()).rejects.toThrow("Debugger connection closed");
    await runtime.abortSessions();
  });

  it("surfaces AX node resolution failures instead of retrying indefinitely", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") throw new Error("Debugger connection closed");
      return original(source, method, params);
    });
    await expect(page.getByRole("button", { name: "Sign in" }).textContent()).rejects.toThrow("Debugger connection closed");
    await runtime.abortSessions();
  });

  it("reads a condition from the node selected by the same uniqueness check", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let resolutions = 0;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes('"nodes"')) {
        resolutions++;
        return { result: { objectId: "frozen-array" } };
      }
      if (method === "Runtime.callFunctionOn" && params.objectId === "frozen-array") {
        if (params.functionDeclaration === "function(){return this.length}") return { result: { value: 1 } };
        if (params.functionDeclaration === "function(){return this[0]}") return { result: { objectId: "original-node" } };
      }
      if (method === "Runtime.callFunctionOn" && params.objectId === "original-node" && params.functionDeclaration.includes("invalidChecked"))
        return { result: { value: { present: false, actual: null } } };
      return original(source, method, params);
    });
    await expect(page.locator("button").readCondition("enabled")).resolves.toEqual({ present: false, actual: null });
    expect(resolutions).toBe(1);
    expect(command).toHaveBeenCalledWith(expect.anything(), "Runtime.releaseObject", { objectId: "frozen-array" });
    await runtime.abortSessions();
  });

  it("rejects an ambiguous condition before reading either matching node", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes('"nodes"')) return { result: { objectId: "two-nodes" } };
      if (method === "Runtime.callFunctionOn" && params.objectId === "two-nodes" && params.functionDeclaration === "function(){return this.length}")
        return { result: { value: 2 } };
      return original(source, method, params);
    });
    await expect(page.locator("button").readCondition("enabled")).rejects.toMatchObject({ code: "strict-mode", detail: { count: 2 } });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.callFunctionOn" && params?.functionDeclaration === "function(){return this[0]}" )).toBe(false);
    await runtime.abortSessions();
  });

  it("rejects an unchecked reading if the selected node becomes disconnected", async () => {
    const { runtime } = harness(undefined, [{ connected: false, checked: false }]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).isChecked()).rejects.toMatchObject({ code: "not-found" });
    await runtime.abortSessions();
  });

  it("preserves protocol failures and rejects unverifiable or stale reference resolutions", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const inspection = await page.inspect() as any;
    const ref = inspection.items.find((item: any) => item.ref)?.ref;
    expect(ref).toBeDefined();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") throw new Error("Debugger connection closed");
      return original(source, method, params);
    });
    await expect(page.ref(ref).textContent()).rejects.toThrow("Debugger connection closed");
    await expect(page.ref(ref).count()).rejects.toThrow("Debugger connection closed");
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") throw new DOMException("node removed", "AbortError");
      return original(source, method, params);
    });
    await expect(page.ref(ref).textContent()).rejects.toMatchObject({ name: "AbortError" });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){ return this.isConnected; }") return { result: {} };
      return original(source, method, params);
    });
    await expect(page.ref(ref).textContent()).rejects.toMatchObject({ code: "ref-unavailable" });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){ return this.isConnected; }") {
        runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
      }
      return original(source, method, params);
    });
    await expect(page.ref(ref).textContent()).rejects.toMatchObject({ code: "stale-ref" });
    await runtime.abortSessions();
  });
  it("surfaces navigation permission errors while retrying transient context replacement", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let failure = "Execution context was destroyed.";
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression === "document.readyState !== 'loading'" && failure) {
        const message = failure; failure = ""; throw new Error(message);
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.goto("https://example.test/next")).resolves.toMatchObject({ performed: true });
    failure = 'Cannot access contents of url "about:blank#part"';
    await expect(page.goto("about:blank#part")).rejects.toThrow("Cannot access contents");
    await runtime.abortSessions();
  });
  it("does not infer root load from child or stale lifecycle events", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "current-loader" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.lifecycleEvent", { frameId: "child", loaderId: "child-loader", name: "init", timestamp: 1 });
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "old-loader", name: "load", timestamp: 2 });
    await expect(page.waitForLoadState("load")).rejects.toMatchObject({ code: "load-state-unknown" });
    await runtime.abortSessions();
  });

  it("treats a new root lifecycle init as a boundary even when document.open reuses its loader", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "same-loader" } } };
      if (method === "Runtime.evaluate" && params?.expression?.includes("domContentLoadedEventEnd"))
        return { result: { value: { state: "complete", domContentLoaded: 10, load: 20 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "same-loader", name: "init", timestamp: 100 });
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "old-loader", name: "init", timestamp: 90 });
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "same-loader", name: "load", timestamp: 99 });
    runtime.handleEvent({ tabId: 3, sessionId: "child" }, "Page.lifecycleEvent", { frameId: "root", loaderId: "same-loader", name: "load", timestamp: 101 });
    const pending = page.waitForLoadState("load");
    let settled = false; void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "same-loader", name: "DOMContentLoaded", timestamp: 110 });
    await page.waitForLoadState("domcontentloaded");
    expect(settled).toBe(false);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "same-loader", name: "load", timestamp: 120 });
    await pending;
    await runtime.abortSessions();
  });

  it("rechecks the root loader around a renderer read", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let loader = "old", reads = 0;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: loader } } };
      if (method === "Runtime.evaluate" && params?.expression === "document.readyState") {
        reads += 1;
        if (reads === 1) { loader = "new"; runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "new", name: "init", timestamp: 10 }); }
        return { result: { value: "complete" } };
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const pending = page.waitForLoadState("domcontentloaded");
    let settled = false; void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    expect(reads).toBeGreaterThan(1);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "new", name: "DOMContentLoaded", timestamp: 30 });
    await pending;
    await runtime.abortSessions();
  });

  it("reports an unknown load state on an already-attached document without an observed init", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "blank-loader" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.waitForLoadState("domcontentloaded")).rejects.toMatchObject({ code: "load-state-unknown" });
    runtime.handleEvent({ tabId: 3 }, "Page.navigatedWithinDocument", { frameId: "root", url: "about:blank#part" });
    await expect(page.waitForLoadState("load")).rejects.toMatchObject({ code: "load-state-unknown" });
    await runtime.abortSessions();
  });

  it("does not treat a lifecycle replay during enable as a newly observed document", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "loader" } } };
      if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 10 }] };
      if (method === "Page.setLifecycleEventsEnabled") {
        runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
        runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "init", timestamp: 1 });
        runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "load", timestamp: 2 });
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    // A replay delayed across the bridge is still older than the cutoff.
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "init", timestamp: 5 });
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "load", timestamp: 8 });
    await expect(page.waitForLoadState("load")).rejects.toMatchObject({ code: "load-state-unknown" });
    await runtime.abortSessions();
  });

  it("reports unknown when a trustworthy lifecycle cutoff cannot be obtained", async () => {
    const refreshGuard = vi.fn(async () => undefined);
    const { runtime, command } = harness(undefined, undefined, undefined, undefined, undefined, refreshGuard);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "loader" } } };
      if (method === "Performance.getMetrics") throw new Error("Metrics unavailable");
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "init", timestamp: 100 });
    expect(refreshGuard).toHaveBeenCalledWith(3);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "load", timestamp: 120 });
    await expect(page.waitForLoadState("load")).rejects.toMatchObject({ code: "load-state-unknown" });
    await runtime.abortSessions();
  });

  it("propagates cancellation while establishing the lifecycle cutoff", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Performance.getMetrics") { controller.abort(); throw new Error("Metrics interrupted"); }
      return original(source, method, params);
    });
    await expect(runtime.createPage(3)).rejects.toMatchObject({ name: "AbortError" });
    await runtime.abortSessions();
  });

  it("retries a destroyed navigation context but surfaces other load-state errors", async () => {
    for (const failingMethod of ["Runtime.evaluate", "Page.getFrameTree", "permission"] as const) {
      const { runtime, command } = harness();
      const original = command.getMockImplementation()!;
      let failed = false;
      command.mockImplementation(async (source, method, params) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "root", loaderId: "loader" } } };
        }
        if (method === "Runtime.evaluate" && params?.expression === "document.readyState") {
          if (failingMethod === method && !failed) { failed = true; throw new Error("Execution context was destroyed"); }
          if (failingMethod === "permission") throw new Error("Cannot access contents of url");
          return { result: { value: { state: "complete", domContentLoaded: 1, load: 1 } } };
        }
        return original(source, method, params);
      });
      const page = await runtime.createPage(3);
      runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "init", timestamp: 1 });
      runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "load", timestamp: 2 });
      if (failingMethod === "Runtime.evaluate") {
        await page.waitForLoadState("load");
        expect(failed).toBe(true);
      } else if (failingMethod === "Page.getFrameTree") {
        command.mockImplementation(async (source, method, params) => method === "Page.getFrameTree"
          ? Promise.reject(new Error("Debugger connection closed")) : original(source, method, params));
        await expect(page.waitForLoadState("load")).rejects.toThrow("Debugger connection closed");
      } else await expect(page.waitForLoadState("load")).rejects.toThrow("Cannot access contents of url");
      await runtime.abortSessions();
    }
  });

  it("rejects an identified native draggable before mouse input is dispatched", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("element.draggable")) return { result: { value: true } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.locator("#source").dragTo(page.locator("#target"))).rejects.toMatchObject({ code: "native-drag-unavailable" });
    expect(command.mock.calls.filter(([, method]) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
    await runtime.abortSessions();
  });
  it("fails before pressing when the viewport cannot contain a drag-threshold movement", async () => {
    const { runtime, command } = harness(undefined, [{ connected: true, x: 2, y: 2, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false }]);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => method === "Runtime.evaluate" && params?.expression?.includes("({width:innerWidth")
      ? { result: { value: { width: 5, height: 5 } } } : original(source, method, params));
    const page = await runtime.createPage(3);
    await expect(page.locator("#source").dragTo(page.locator("#target"))).rejects.toMatchObject({ code: "drag-unavailable" });
    expect(command.mock.calls.filter(([, method]) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
    await runtime.abortSessions();
  });
  it("cancels a failed drag and releases the pointer without replaying an uncertain release", async () => {
    for (const failAt of ["move", "release"] as const) {
      const { runtime, command } = harness();
      const original = command.getMockImplementation()!;
      const input: Array<{ method: string; type?: string; buttons?: number }> = [];
      command.mockImplementation(async (source, method, params) => {
        if (method === "Input.dispatchMouseEvent" || method === "Input.cancelDragging") {
          input.push({ method, type: params?.type, buttons: params?.buttons });
          if (failAt === "move" && params?.type === "mouseMoved" && params?.buttons === 1 || failAt === "release" && params?.type === "mouseReleased") throw new Error("uncertain dispatch");
        }
        return original(source, method, params);
      });
      const page = await runtime.createPage(3);
      await expect(page.locator("#source").dragTo(page.locator("#target"))).rejects.toMatchObject({ effectUnknown: true });
      expect(input.filter((event) => event.type === "mouseReleased")).toHaveLength(1);
      expect(input.filter((event) => event.method === "Input.cancelDragging")).toHaveLength(failAt === "move" ? 1 : 0);
      expect(input.find((event) => event.type === "mousePressed")?.buttons).toBe(1);
      await runtime.abortSessions();
    }
  });
  it("validates selection before dispatch and revalidates after the dispatch barrier", async () => {
    const { runtime, command, onDispatch } = harness([{ role: "combobox", name: "Choice", tag: "select" }]);
    const original = command.getMockImplementation()!;
    const selections: boolean[] = [];
    let invalidInitially = true;
    command.mockImplementation(async (debuggee, method, params?: any) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("function(values, apply)")) {
        const apply = params.arguments[1].value;
        selections.push(apply);
        return { result: { value: invalidInitially || apply ? { error: "option-not-found", value: "missing" } : { selected: [] } } };
      }
      return original(debuggee, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.getByRole("combobox", { name: "Choice" }).selectOption("missing")).rejects.toMatchObject({ code: "invalid-option", detail: { reason: "option-not-found" } });
    expect(onDispatch).not.toHaveBeenCalled();
    expect(selections).toEqual([false]);
    invalidInitially = false;
    await expect(page.getByRole("combobox", { name: "Choice" }).selectOption("missing")).rejects.toMatchObject({ code: "invalid-option" });
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(selections).toEqual([false, false, true]);
    await runtime.dispose();
  });
  it("shares the chooser claim with program uploads until file dispatch completes", async () => {
    const stream = new EventSubscriptions();
    const owner = { conversationId: "conversation", runId: "run" };
    const source = { tabId: 3, sessionId: "frame" };
    const chooser = stream.registerChooser({ owner, source, backendNodeId: 77, mode: "selectSingle" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const onDispatch = vi.fn(async () => held);
    const claimChooser = (value: any) => {
      expect(value).toMatchObject({ debuggee: source, backendNodeId: 77 });
      const claim = stream.claimChooser(owner, chooser.id);
      return { assert: () => stream.assertChooserClaim(owner, claim.id, claim.claimId), finish: (outcome: "handled" | "not-dispatched" | "uncertain") => stream.finishChooser(owner, claim.id, claim.claimId, outcome) };
    };
    const { runtime } = harness(undefined, undefined, undefined, onDispatch, claimChooser);
    const page = await runtime.createPage(3);
    runtime.handleEvent(source, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const pending = page.upload({ name: "one.txt", text: "one" });
    await vi.waitFor(() => expect(onDispatch).toHaveBeenCalledOnce());
    expect(() => stream.claimChooser(owner, chooser.id)).toThrow("handling");
    release();
    await pending;
    expect(() => stream.claimChooser(owner, chooser.id)).toThrow("handled");
    await runtime.dispose();
  });
  it("cleans event waiters against their original signal after context changes or session cleanup", async () => {
    const { runtime } = harness();
    const first = new AbortController();
    const second = new AbortController();
    const firstRemove = vi.spyOn(first.signal, "removeEventListener");
    const secondRemove = vi.spyOn(second.signal, "removeEventListener");
    runtime.setContext({ signal: first.signal });
    const received = runtime.waitForEvent(3, "dialog");
    runtime.setContext({ signal: second.signal });
    runtime.handleEvent({ tabId: 3 }, "Page.javascriptDialogOpening", { type: "alert", message: "hello" });
    await expect(received).resolves.toBeDefined();
    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(secondRemove).not.toHaveBeenCalled();
    runtime.setContext({ signal: first.signal });
    const abandoned = runtime.waitForEvent(3, "download");
    runtime.setContext({ signal: second.signal });
    const rejected = expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await runtime.abortSessions();
    await rejected;
    expect(firstRemove).toHaveBeenCalledTimes(2);
    expect(secondRemove).not.toHaveBeenCalled();
  });
  it("marks page evaluation at dispatch and leaves rejected locator preconditions undispatched", async () => {
    const {runtime,onDispatch} = harness([{role:"button",name:"Save"},{role:"button",name:"Save"}]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button",{name:"Save"}).evaluate(() => true)).rejects.toThrow("strict-mode");
    expect(onDispatch).not.toHaveBeenCalled();
    await page.evaluate(() => true); expect(onDispatch).toHaveBeenCalledTimes(1);
    await page.inspect(); expect(onDispatch).toHaveBeenCalledTimes(1);
  });
  it("inspects a deeply nested accessibility tree without exhausting the call stack", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const depth = 20_000;
    const nodes = Array.from({ length: depth }, (_, index) => ({
      nodeId: `deep-${index}`, ...(index ? { parentId: `deep-${index - 1}` } : {}),
      ignored: index < depth - 1, role: { value: index === depth - 1 ? "button" : "generic" },
      name: { value: index === depth - 1 ? "Deep target" : "" },
      childIds: index < depth - 1 ? [`deep-${index + 1}`] : [], backendDOMNodeId: index + 1,
    }));
    command.mockImplementation(async (source, method, params) => method === "Accessibility.getFullAXTree" ? { nodes } : original(source, method, params));
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain('button "Deep target"');
    await runtime.abortSessions();
  });

  it("inspects text by default, qualifies references, and returns changes without repeating the full snapshot", async () => {
    const metadata = [{ role: "button", name: "Save", tag: "button", text: "Save" }];
    const { runtime, calls } = harness(metadata); const page = await runtime.createPage(3);
    const first = await page.inspect();
    expect(first).toMatchObject({ mode: "full", tabId: 3, documentId: 0, truncation: { baselineComplete: true } });
    const ref = (first.items as any[]).find((item) => item.line.includes('button "Save"'))?.ref;
    expect(ref).toMatch(/^t3s[a-f0-9]+d0e1$/); expect(first).not.toHaveProperty("screenshot");
    metadata[0]!.name = "Continue";
    const second = await page.inspect({ since: first.observationId as string });
    expect(second).toMatchObject({ mode: "delta", items: [expect.objectContaining({ change: "updated", line: expect.stringContaining("Continue") })] });
    expect(second).not.toHaveProperty("snapshot");
    expect(calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
    const other = await runtime.createPage(4);
    await expect(other.ref(ref!).click()).rejects.toThrow("stale-ref");
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    await expect(page.inspect({ since: first.observationId as string })).rejects.toThrow("stale-observation");
    await expect(page.ref(ref!).click()).rejects.toThrow("stale-ref");
    await runtime.abortSessions();
    const replacement = await (await runtime.createPage(3)).inspect();
    expect((replacement.items as any[]).some((item) => item.ref === ref)).toBe(false);
  });

  it("keeps AX row identities distinct when two semantic nodes share a backend node", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let includeSecond = true;
    command.mockImplementation(async (source, method, params) => method === "Accessibility.getFullAXTree" ? { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: includeSecond ? ["one", "two"] : ["one"] },
      { nodeId: "one", parentId: "root", backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Same" } },
      ...(includeSecond ? [{ nodeId: "two", parentId: "root", backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Same" } }] : []),
    ] } : original(source, method, params));
    const page = await runtime.createPage(3);
    const baseline = await page.inspect() as any;
    const buttons = baseline.items.filter((item: any) => item.line.includes('button "Same"'));
    expect(buttons).toHaveLength(2);
    expect(buttons[0].id).not.toBe(buttons[1].id);
    expect(buttons[0].ref).toBe(buttons[1].ref);
    includeSecond = false;
    const delta = await page.inspect({ since: baseline.observationId }) as any;
    expect(delta.items).toEqual([expect.objectContaining({ id: buttons[1].id, change: "removed" })]);
    await runtime.abortSessions();
  });
  it("reports truncation, slices and fields, and resets a delta against an incomplete baseline", async () => {
    const { runtime } = harness(Array.from({ length: 8 }, (_, index) => ({ role: "button", name: `Button ${index}`, tag: "button" })));
    const page = await runtime.createPage(3);
    const truncated = await page.inspect({ budget: 100 });
    expect(truncated).toMatchObject({ mode: "full", truncation: { truncated: true, reason: "budget", baselineComplete: false } });
    const reset = await page.inspect({ since: truncated.observationId as string });
    expect(reset).toMatchObject({ mode: "full", reset: "previous-output-truncated" });
    const sliced = await page.inspect({ offset: 1, limit: 2, fields: ["text"] });
    expect(sliced).toMatchObject({ truncation: { offset: 1, returned: 2, nextOffset: 3, reason: "slice" } });
    expect((sliced.items as any[]).every((item) => item.ref === undefined)).toBe(true); expect(inspectText(sliced)).not.toContain("[actions=");
    await expect(page.inspect({ since: reset.observationId as string, fields: ["ref"] })).rejects.toThrow("stale-observation");
  });

  it("pages an immutable snapshot through a long node, then uses the completed baseline", async () => {
    const name = `Start ${"long😀\n".repeat(400)} end`;
    const metadata = [{ role: "button", name, tag: "button" }];
    const { runtime, calls } = harness(metadata);
    runtime.setContext({ conversationId: "conversation", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
    const page = await runtime.createPage(3);
    const first = await page.inspect({ budget: 240, limit: 1 }) as any;
    expect(first.nextCursor).toEqual(expect.any(String));
    metadata[0]!.name = "Changed after the initial snapshot";
    let cursor = first.nextCursor;
    let rebuilt = "";
    let ownedRef = "";
    let count = 0;
    do {
      const next = await page.inspect({ cursor, budget: 240, limit: 1 }) as any;
      expect(next.observationId).toBe(first.observationId);
      expect(next.truncation.used).toBeLessThanOrEqual(240);
      for (const item of next.items ?? []) if (item.fragment?.index === 1) {
        rebuilt += item.line;
        ownedRef = item.ref;
      }
      cursor = next.nextCursor;
      expect(++count).toBeLessThan(200);
      if (!cursor) expect(next.truncation.baselineComplete).toBe(true);
    } while (cursor);
    expect(rebuilt).toContain("Start long😀");
    expect(rebuilt).toContain(" end");
    expect(rebuilt).not.toContain("Changed after the initial snapshot");
    expect(ownedRef).toMatch(/^t3s[a-f0-9]+d0e1$/);
    expect(calls.filter(({ method }) => method === "Accessibility.getFullAXTree")).toHaveLength(1);
    const delta = await page.inspect({ since: first.observationId as string }) as any;
    expect(delta).toMatchObject({ mode: "delta", items: [expect.objectContaining({ change: "updated", line: expect.stringContaining("Changed after the initial snapshot") })] });
    await runtime.abortSessions();
  });

  it("bounds historical references at a new batch and rejects a continuation whose refs were reclaimed", async () => {
    const { runtime } = harness([{ role: "button", name: "First" }, { role: "button", name: "Second" }]);
    const page = await runtime.createPage(3);
    const first = await page.inspect({ limit: 1 }) as any;
    const session = fillReferencePool(runtime, 32_769);
    const second = await page.inspect({ cursor: first.nextCursor, limit: 1 }) as any;
    expect(session.refUsage.size).toBeGreaterThan(32_768);
    const retainedRef = second.items[0].ref;
    expect(retainedRef).toEqual(expect.any(String));
    await page.inspect();
    expect(session.refUsage.size).toBeLessThanOrEqual(24_578);
    expect(session.refsByNode.size).toBe(session.refUsage.size);
    await expect(page.ref(retainedRef).count()).resolves.toBe(1);
    await expect(page.inspect({ cursor: second.nextCursor })).rejects.toMatchObject({ code: "stale-observation" });
    await runtime.abortSessions();
  });

  it("reclaims old refs during automatic capture while preserving the operation's refs", async () => {
    const { runtime } = harness([{ role: "button", name: "First" }, { role: "button", name: "Second" }]);
    const page = await runtime.createPage(3);
    const first = await page.inspect({ limit: 1 }) as any;
    const session = fillReferencePool(runtime, 32_769);
    const oldRef = first.items.find((item: any) => item.ref)?.ref ?? (await page.inspect({ cursor: first.nextCursor, limit: 1 }) as any).items[0].ref;
    const captured = await page.inspect({ recentRefs: [oldRef], limit: 1 }) as any;
    expect(session.refUsage.size).toBeLessThanOrEqual(24_578);
    await expect(page.ref(oldRef).count()).resolves.toBe(1);
    const next = await page.inspect({ cursor: captured.nextCursor, limit: 1 }) as any;
    await expect(page.ref(next.items[0].ref).count()).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it("does not evict refs during a concurrent action and reclaims them on the next independent capture", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const initial = await page.inspect() as any;
    const ref = initial.items.find((item: any) => item.ref).ref;
    const original = command.getMockImplementation()!;
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const resolved = new Promise<void>((resolve) => { started = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") { started(); await blocked; }
      return original(source, method, params);
    });
    const action = page.ref(ref).count();
    await resolved;
    const session = fillReferencePool(runtime, 32_769);
    await page.inspect();
    expect(session.refUsage.size).toBeGreaterThan(32_768);
    release();
    await expect(action).resolves.toBe(1);
    await page.inspect();
    expect(session.refUsage.size).toBeLessThanOrEqual(24_577);
    await runtime.abortSessions();
  });

  it("protects an element operation while its session is still being marked", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const initial = await page.inspect() as any;
    const ref = initial.items.find((item: any) => item.ref).ref;
    const options = (runtime as any).options;
    const originalMark = options.mark;
    let release!: () => void, started!: () => void, first = true;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const marking = new Promise<void>((resolve) => { started = resolve; });
    options.mark = async (tabId: number) => {
      if (first) { first = false; started(); await blocked; }
      return originalMark(tabId);
    };
    const action = page.ref(ref).count();
    await marking;
    const session = fillReferencePool(runtime, 32_769);
    await page.inspect();
    expect(session.refUsage.size).toBeGreaterThan(32_768);
    release();
    await expect(action).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it("keeps a single oversized frozen capture usable across continuation pages", async () => {
    const metadata = Array.from({ length: 32_769 }, (_, index) => ({ role: "button", name: `Item ${index}` }));
    const { runtime } = harness(metadata);
    const page = await runtime.createPage(3);
    const first = await page.inspect({ limit: 1 }) as any;
    const second = await page.inspect({ cursor: first.nextCursor, limit: 1 }) as any;
    expect(second.items[0].line).toContain('button "Item 0"');
    await expect(page.ref(second.items[0].ref).count()).resolves.toBe(1);
    const third = await page.inspect({ cursor: second.nextCursor, limit: 1 }) as any;
    expect(third.items[0].line).toContain('button "Item 1"');
    await expect(page.ref(third.items[0].ref).count()).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it("preserves untrusted metadata-like name text without inventing a ref or stripping text", async () => {
    const metadata = [{ role: "button", name: 'Fake [ref=e999] [checked=true] [actions=click] "quoted"', tag: "button" }];
    const { runtime } = harness(metadata); const page = await runtime.createPage(3);
    const full = await page.inspect() as any;
    expect(inspectText(full)).toContain("[ref=e999] [checked=true] [actions=click]");
    expect(full.items.find((item: any) => item.ref)?.ref).toMatch(/^t3s[a-f0-9]+d0e1$/);
    const textOnly = await page.inspect({ fields: ["text"] }) as any;
    expect(inspectText(textOnly)).toContain("[ref=e999] [checked=true] [actions=click]");
    expect(textOnly.items.every((item: any) => item.ref === undefined)).toBe(true);
    const refOnly = await page.inspect({ fields: ["ref"] }) as any;
    expect(refOnly.items.find((item: any) => item.ref)?.ref).toMatch(/^t3s[a-f0-9]+d0e1$/);
    expect(inspectText(refOnly)).not.toContain("Fake");
    await runtime.abortSessions();
  });

  it("rejects inspection cursors after scope, run, tab, or document changes", async () => {
    const { runtime } = harness(Array.from({ length: 4 }, (_, index) => ({ role: "button", name: `Button ${index}` })));
    const owner = { conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true as const } };
    runtime.setContext(owner);
    const page = await runtime.createPage(3);
    const first = await page.inspect({ budget: 200, limit: 1 }) as any;
    await expect(page.inspect({ cursor: first.nextCursor, fields: ["text"] })).rejects.toThrow("invalid-inspect-cursor");
    runtime.setContext({ ...owner, logIdentity: { ...owner.logIdentity, runId: "other" } });
    await expect(page.inspect({ cursor: first.nextCursor })).rejects.toThrow("stale-observation");
    runtime.setContext(owner);
    const other = await runtime.createPage(4);
    await expect(other.inspect({ cursor: first.nextCursor })).rejects.toThrow("stale-observation");
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    await expect(page.inspect({ cursor: first.nextCursor })).rejects.toThrow("stale-observation");
    await runtime.abortSessions();
  });

  it("evicts observation and continuation together, and refreshes both on a valid continuation", async () => {
    const { runtime } = harness(Array.from({ length: 4 }, (_, index) => ({ role: "button", name: `Button ${index}` })));
    const page = await runtime.createPage(3);
    const evicted = await page.inspect({ limit: 1 }) as any;
    for (let index = 0; index < 32; index++) await page.observe("semantic");
    await expect(page.inspect({ cursor: evicted.nextCursor })).rejects.toThrow("stale-observation");
    await expect(page.inspect({ since: evicted.observationId })).rejects.toThrow("stale-observation");

    const retained = await page.inspect({ limit: 1 }) as any;
    let cursor = (await page.inspect({ cursor: retained.nextCursor, limit: 1 }) as any).nextCursor;
    for (let index = 0; index < 31; index++) await page.observe("semantic");
    let final: any;
    while (cursor) { final = await page.inspect({ cursor, limit: 1 }); cursor = final.nextCursor; }
    expect(final.truncation.baselineComplete).toBe(true);
    expect(await page.inspect({ since: retained.observationId })).toMatchObject({ mode: "delta", items: [] });
    await runtime.abortSessions();
  });
  it("waits for equal geometry across samples before dispatching native input", async () => {
    const base = { connected: true, y: 12, height: 20, visible: true, stable: true, enabled: true,
      editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [
      { ...base, x: 10, width: 20 }, { ...base, x: 30, width: 40 },
      { ...base, x: 30, width: 40 }, { ...base, x: 30, width: 40 },
    ]);
    const page = await runtime.createPage(3);
    await page.getByRole("button", { name: "Sign in" }).click();
    const pressed = calls.findIndex(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed");
    expect(calls.slice(0, pressed).filter(({ method }) => method === "Runtime.callFunctionOn")).toHaveLength(4);
    expect(calls[pressed]?.params).toMatchObject({ x: 30, y: 12 });
    await runtime.dispose();
  });

  it("maps an out-of-process frame through its perspective content quad", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params: any): Promise<any> => {
      if (method === "DOM.getFrameOwner") return { backendNodeId: 10 };
      if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 80, 100, 20, 100] } };
      if (method === "Runtime.evaluate" && params.expression === "({width:innerWidth,height:innerHeight})") return { result: { value: { width: 100, height: 100 } } };
      return original(source, method, params);
    });
    const session = (runtime as any).sessions.get(3);
    const child = { tabId: 3, sessionId: "child" };
    session.frames.set("child-frame", child);
    session.frames.set("root", { tabId: 3 });
    session.frameParents.set("child-frame", "root");
    const point = await (runtime as any).toRootPoint(session, { ...session, debuggee: child }, { x: 50, y: 50 });
    expect(point.x).toBeCloseTo(50);
    expect(point.y).toBeCloseTo(62.5);
    await runtime.abortSessions();
  });

  it("keeps the starting action identity when the surrounding request phase changes while it waits", async () => {
    const logger = { record: vi.fn() };
    const { runtime } = harness([], undefined, logger);
    let finish!: () => void;
    const identity = { runId: "run", toolCallId: "1:call", toolCallIdCanonical: true as const };
    runtime.setContext({ conversationId: "conversation", toolCallId: "call", logIdentity: identity });
    const pending = (runtime as any).action(3, "waiting", null, () => new Promise<void>((resolve) => { finish = resolve; }));
    runtime.setContext({ conversationId: "other", toolCallId: "later" });
    finish(); await pending;
    expect(logger.record.mock.calls.map(([event]) => ({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, toolCallIdCanonical: event.toolCallIdCanonical }))).toEqual([
      { conversationId: "conversation", ...identity }, { conversationId: "conversation", ...identity },
    ]);
  });

  it("builds compact AX snapshots with stable refs and reuses one tab session", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    const first = await page.snapshot();
    const second = await page.snapshot();

    expect(first.snapshot).toContain('button "Sign in" [ref=e1]');
    expect(second.snapshot).toContain("[ref=e1]");
    expect(calls.filter(({ method }) => method === "Page.enable")).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "Target.setAutoAttach")).toHaveLength(1);
  });

  it("rejects ambiguous semantic locators immediately", async () => {
    const { runtime } = harness([
      { role: "button", name: "Save", tag: "button", text: "Save" },
      { role: "button", name: "Save", tag: "button", text: "Save" },
    ]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Save" }).click()).rejects.toThrow("strict-mode");
  });

  it("runs actionability checks and dispatches trusted input", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    await expect(page.getByRole("button", { name: "Sign in" }).click()).resolves.toMatchObject({ performed: true });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("re-resolves a locator when a framework replaces the node during actionability", async () => {
    const blocked = { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
    const ready = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [blocked, ready]);
    const page = await runtime.createPage(3);

    await page.getByRole("button", { name: "Sign in" }).click();

    expect(calls.filter(({ method }) => method === "DOM.resolveNode").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("waits for explicit locator states", async () => {
    const disabled = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: false, editable: false, receivesEvents: true, checked: false };
    const enabled = { ...disabled, enabled: true };
    const { runtime, calls } = harness(undefined, [disabled, enabled]);
    const page = await runtime.createPage(3);

    await page.getByRole("button", { name: "Sign in" }).waitFor({ state: "enabled" });

    expect(calls.filter(({ method }) => method === "Runtime.callFunctionOn")).toHaveLength(2);
  });

  it("reports semantic updates by node identity instead of collapsing line sets", async () => {
    const metadata = [{ role: "button", name: "Save", tag: "button", text: "Save" }];
    const { runtime } = harness(metadata);
    const page = await runtime.createPage(3);
    const first = await page.observe("semantic");
    metadata[0] = { role: "button", name: "Continue", tag: "button", text: "Continue" };

    await expect(page.observe("semantic", first.observationId as string)).resolves.toMatchObject({
      changes: { updated: [{ before: expect.stringContaining('button "Save"'), after: expect.stringContaining('button "Continue"') }] },
    });
  });

  it("invalidates snapshot refs after main-document navigation", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "new-root" } });
    await expect(page.ref("e1").click()).rejects.toThrow("stale-ref");
  });

  it("refuses to heal a detached snapshot ref to a similar element", async () => {
    const detached = { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
    const { runtime } = harness(undefined, [detached]);
    const page = await runtime.createPage(3);
    await page.snapshot();

    await expect(page.ref("e1").click()).rejects.toThrow("AutomationError[detached]");
  });

  it("aborts pending locators and detaches the automation session", async () => {
    const { runtime, detach } = harness([]);
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3);
    const pending = page.getByText("later").click();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await runtime.abortSessions();
    expect(detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("returns timeout diagnostics while throttling repeated locator attempts", async () => {
    vi.useFakeTimers();
    try {
      const logger = { record: vi.fn() };
      const { runtime } = harness([], undefined, logger);
      const controller = new AbortController();
      runtime.setContext({ signal: controller.signal });
      const page = await runtime.createPage(3);
      const pending = page.getByText("missing").click();
      const rejected = expect(pending).rejects.toThrow(/AutomationError\[timeout\].*lastObservation/);
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 2_200);
      await vi.advanceTimersByTimeAsync(2_200);

      await rejected;
      const attempts = logger.record.mock.calls.map(([event]) => event).filter((event) => event.type === "automation.action.attempt");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((event) => event.content.attempt)).toEqual([1, 21, 41]);
      expect(logger.record.mock.calls.map(([event]) => event).find((event) => event.type === "automation.action.failed")?.content.diagnostic)
        .toMatchObject({ code: "timeout", lastObservation: { reason: "no-candidate", attempt: 44 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a Page handle for popups opened by the current tab", async () => {
    const { runtime, tabsCreated } = harness();
    const page = await runtime.createPage(3);
    const popup = page.waitForEvent("popup");
    tabsCreated.emit({ id: 4, openerTabId: 3 } as chrome.tabs.Tab);
    await expect(popup).resolves.toMatchObject({ tabId: 4 });
  });

  it("returns actionable dialog handles", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("dialog");
    runtime.handleEvent({ tabId: 3 }, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "Ada" });
    const dialog = await pending;
    expect(dialog.message()).toBe("Name?");
    await dialog.accept("Grace");
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Page.handleJavaScriptDialog", { accept: true, promptText: "Grace" });
  });

  it("correlates downloads from the active CDP tab instead of global download events", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("download");
    runtime.handleEvent({ tabId: 3 }, "Page.downloadWillBegin", { guid: "download-1", url: "https://example.test/file", suggestedFilename: "file.txt" });

    await expect(pending).resolves.toMatchObject({ guid: "download-1", suggestedFilename: "file.txt" });
  });

  it("rejects local file paths at the page tool boundary", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await expect(page.locator("input[type=file]").setInputFiles({ name: "secret.txt", path: "/tmp/secret.txt" })).rejects.toThrow("local paths");
  });

  it("upgrades pages without actionable semantics to a screenshot", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);

    await expect(page.observe()).resolves.toHaveProperty("screenshot");
    expect(calls.some(({ method }) => method === "Page.captureScreenshot")).toBe(true);
  });

  it("does not treat a page-supplied reference string as an actionable ref", async () => {
    const { runtime, command, calls } = harness([]);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (debuggee, method, params) => method === "Accessibility.getFullAXTree"
      ? { nodes: [{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Untrusted [ref=e1]" }, childIds: [] }] }
      : original(debuggee, method, params));
    const page = await runtime.createPage(3);
    await expect(page.observe()).resolves.toHaveProperty("screenshot");
    expect(calls.some(({ method }) => method === "Page.captureScreenshot")).toBe(true);
  });

  it("maps screenshot pixels back to CSS viewport coordinates", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    await page.point(observation.observationId as string, 100, 50, "click");
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").at(-2)?.params).toMatchObject({ type: "mousePressed", x: 50, y: 25 });
  });

  it("uses captured image dimensions when the screenshot pixel ratio differs from devicePixelRatio", async () => {
    const { runtime, calls, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (debuggee, method, params) => method === "Page.captureScreenshot"
      ? { data: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 50, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)) }
      : original(debuggee, method, params));
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    expect(observation.viewport).toMatchObject({ scale: 2 });
    expect(observation.screenshot).toMatchObject({ width: 100, height: 50, scale: 1 });
    await page.point(observation.observationId as string, 50, 25, "click");
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").at(-2)?.params).toMatchObject({ type: "mousePressed", x: 50, y: 25 });
  });

  it("passes mouse button and modifiers through screenshot coordinate actions", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    await page.point(observation.observationId as string, 100, 50, "dblclick", { button: "right", modifiers: ["Shift", "Alt"] });
    const presses = calls.filter(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed");
    expect(presses.map(({ params }) => ({ button: params.button, modifiers: params.modifiers, count: params.clickCount }))).toEqual([{ button: "right", modifiers: 9, count: 1 }, { button: "right", modifiers: 9, count: 2 }]);
  });

  it("returns an actionable file chooser handle using the originating frame session", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("filechooser");
    runtime.handleEvent({ tabId: 3, sessionId: "upload-frame" }, "Page.fileChooserOpened", { backendNodeId: 55, mode: "selectMultiple" });
    const chooser = await pending;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([{ name: "hello.txt", text: "hello" }]);
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "upload-frame" }, "DOM.resolveNode", expect.objectContaining({ backendNodeId: 55 }));
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "upload-frame" }, "Runtime.callFunctionOn", expect.objectContaining({ functionDeclaration: expect.stringContaining("this.files = transfer.files") }));
  });

  it("keeps each file chooser handle bound to the event that created it", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const firstPending = page.waitForEvent("filechooser");
    runtime.handleEvent({ tabId: 3, sessionId: "first-frame" }, "Page.fileChooserOpened", { backendNodeId: 11, mode: "selectSingle" });
    const first = await firstPending;
    const secondPending = page.waitForEvent("filechooser");
    runtime.handleEvent({ tabId: 3, sessionId: "second-frame" }, "Page.fileChooserOpened", { backendNodeId: 22, mode: "selectSingle" });
    const second = await secondPending;

    await first.setFiles({ name: "first.txt", text: "one" });
    await second.setFiles({ name: "second.txt", text: "two" });

    const resolutions = command.mock.calls.filter(([, method]) => method === "DOM.resolveNode");
    expect(resolutions.slice(-2)).toEqual([
      [{ tabId: 3, sessionId: "first-frame" }, "DOM.resolveNode", expect.objectContaining({ backendNodeId: 11 })],
      [{ tabId: 3, sessionId: "second-frame" }, "DOM.resolveNode", expect.objectContaining({ backendNodeId: 22 })],
    ]);
  });

  it("accepts a same-origin iframe file input without relying on the parent realm constructor", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    await page.locator("input[type=file]").setInputFiles({ name: "frame.txt", text: "frame" });
    const declaration = command.mock.calls.find(([, method, params]) =>
      method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("invalid-upload-target"))?.[2].functionDeclaration;
    expect(declaration).toBeTypeOf("string");

    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const input = frame.contentDocument!.createElement("input");
      input.type = "file";
      frame.contentDocument!.body.append(input);
      expect(input instanceof HTMLInputElement).toBe(false);
      const upload = new Function(`return (${declaration})`)();
      expect(() => upload.call(input, [{}, {}])).toThrow("AutomationError[invalid-file-count]");
    } finally {
      frame.remove();
    }
  });

  it("does not substitute a same-named node when snapshot DOM resolution fails", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") throw new Error("node removed");
      return original(source, method, params);
    });
    await expect(page.ref("e1").click()).rejects.toThrow("detached");
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.queryAXTree")).toHaveLength(0);
  });

  it("treats negative CSS and text indices below the beginning as empty", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const fixture = document.createElement("div");
    fixture.innerHTML = '<button>One</button><button>Two</button>';
    document.body.append(fixture);
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes("metadata")) return { result: { value: new Function("document", `return ${params.expression}`)(fixture) } };
      return original(source, method, params);
    });
    try {
      const page = await runtime.createPage(3);
      expect(await page.locator("button").nth(-3).count()).toBe(0);
      expect(await page.locator("button").nth(-1).count()).toBe(1);
      expect(await page.getByText("o").nth(-3).count()).toBe(0);
    } finally { fixture.remove(); }
  });

  it("rejects an act batch tied to an observation from an old document", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const observation = await page.observe("semantic");
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "new-root" } });
    await expect(page.ensureObservation(observation.observationId as string)).rejects.toThrow("stale-observation");
  });
});
