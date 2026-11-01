import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";
import { TEXT_PAINT_CACHE_LOOKUP_SOURCE, TEXT_PAINT_CACHE_REGISTER_SOURCE } from "./snapshot-text-paint";

function textPaintSnapshot() {
  const strings: string[] = [];
  const id = (value: string) => { const found = strings.indexOf(value); return found < 0 ? strings.push(value) - 1 : found; };
  const names = ["#document", "IFRAME", "IFRAME", "#text", "#text"];
  const text = ["", "", "", "Hidden item", "XX Paint YY"];
  const style = ["1", "visible", "visible", "visible", "visible", "static", "none", "none", "none", "none", "auto", "none", "none", "none", "none", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgba(0, 0, 0, 0)", "none", "0px", "border-box", "none", "none", "clip", "none", "none", "none"].map(id);
  return { strings, documents: [{ frameId: id("root"), contentWidth: 500, contentHeight: 500, scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { backendNodeId: [1, 101, 102, 7, 8], parentIndex: [-1, 0, 0, 0, 0], nodeType: [9, 1, 1, 3, 3], nodeName: names.map(id), nodeValue: text.map(id) },
    layout: { nodeIndex: [0, 1, 2, 3, 4], bounds: [[0, 0, 500, 500], [0, 0, 100, 100], [0, 0, 100, 100], [0, 0, 100, 20], [0, 30, 100, 20]],
      styles: [[], style, style, style, style], text: text.map(id) },
    textBoxes: { layoutIndex: [3, 4], start: [0, 0], length: [11, 11], bounds: [[0, 0, 100, 20], [0, 30, 100, 20]] },
  }] };
}

function harness() {
  const command = vi.fn(async (source: chrome.debugger.Debuggee & { sessionId?: string }, method: string, params: any = {}): Promise<any> => {
    if (method === "Runtime.evaluate" && params.expression === "document.readyState === 'complete'") return { result: { value: true } };
    if (method === "Page.getFrameTree") return source.sessionId === "nested-child" || source.sessionId === "new-child"
      ? { frameTree: { frame: { id: "nested", url: "https://cross.test/nested", parentId: "cross" } } }
      : source.sessionId ? { frameTree: { frame: { id: "cross", url: "https://cross.test/", parentId: "root" }, childFrames: [{ frame: { id: "nested", parentId: "cross", url: "https://cross.test/nested" } }] } }
      : { frameTree: { frame: { id: "root", url: "https://top.test/" }, childFrames: [
        { frame: { id: "same", parentId: "root", url: "https://top.test/same", name: "same" } },
        { frame: { id: "cross", parentId: "root", url: "https://cross.test/" } },
      ] } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: params.frameId === "same" ? 31 : params.frameId === "cross" ? 32 : 33 };
    if (method === "Runtime.evaluate" && params.expression === "document") return { result: { objectId: `doc-${params.contextId}` } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.readyState === 'complete'}") return { result: { value: true } };
    if (method === "Accessibility.queryAXTree") return { nodes: [{ nodeId: "node", backendDOMNodeId: 8, role: { value: "button" }, name: { value: params.objectId ?? "wrong-root" } }] };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 8, role: { value: "button" }, name: { value: "doc-31" } }] };
    if (method === "DOM.getFrameOwner") return { backendNodeId: { same: 101, cross: 102, nested: 103 }[params.frameId as "same" | "cross" | "nested"] };
    if (method === "DOMSnapshot.captureSnapshot") return { strings: ["1", "visible", "auto"], documents: [{
      nodes: { backendNodeId: [101, 102, 103], parentIndex: [-1, -1, -1] },
      layout: { nodeIndex: [0, 1, 2], bounds: [[0, 0, 100, 100], [0, 0, 100, 100], [0, 0, 100, 100]], styles: [[0, 1, 1, 1, 2], [0, 1, 1, 1, 2], [0, 1, 1, 1, 2]] },
    }] };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-object" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { connected: true, role: "button", name: "Open", tag: "button", text: "Open" } } };
    return {};
  });
  const runtime = new AutomationRuntime({ chromeApi: { tabs: { query: async () => [{ id: 3 }] } } as never,
    command, pressChord: async () => {}, detach: async () => {} });
  runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
  return { runtime, command };
}

describe("frame tree discovery", () => {
  it.each(["during-confirmation", "between-attempts"] as const)("resets text-paint retry budget after navigation %s", async (when) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let layouts = 0, navigateAtReady = false;
    const navigate = () => runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Runtime.evaluate" && params.expression === "document.readyState === 'complete'" && navigateAtReady) {
        navigateAtReady = false; navigate();
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = textPaintSnapshot();
        const opaque = ++layouts === 2 || layouts >= 4;
        if (opaque) {
          snapshot.strings.push("rgb(0, 0, 0)");
          for (const style of snapshot.documents[0]!.layout.styles) if (style.length) style[21] = snapshot.strings.length - 1;
        }
        if (layouts === 2) { if (when === "during-confirmation") navigate(); else navigateAtReady = true; }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
        { nodeId: "text", parentId: "root", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value: "Hidden item" } },
      ] };
      if (method === "DOM.resolveNode") return { object: { objectId: `paint-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn" && [TEXT_PAINT_CACHE_REGISTER_SOURCE, TEXT_PAINT_CACHE_LOOKUP_SOURCE].includes(params.functionDeclaration))
        return { result: { value: params.arguments[1].value.map((id: number) => ({ sourceText: id === 7 ? "Hidden item" : "XX Paint YY", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false })) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    expect((await (await runtime.createPage(3)).snapshot()).snapshot).toContain('StaticText "Hidden item"');
    expect(layouts).toBe(5);
    await runtime.abortSessions();
  });
  it.each([false, true])("rechecks text paint inputs and bounds retries when changing continuously: %s", async (unstable) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let layouts = 0, axCaptures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = textPaintSnapshot();
        const opaque = unstable ? ++layouts % 2 === 0 : ++layouts >= 2;
        if (opaque) {
          snapshot.strings.push("rgb(0, 0, 0)");
          for (const style of snapshot.documents[0]!.layout.styles) if (style.length) style[21] = snapshot.strings.length - 1;
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") {
        if (params.frameId) return { nodes: [] };
        axCaptures++;
        return { nodes: [{ nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
          { nodeId: "text", parentId: "root", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value: "Hidden item" } }] };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: `paint-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn" && [TEXT_PAINT_CACHE_REGISTER_SOURCE, TEXT_PAINT_CACHE_LOOKUP_SOURCE].includes(params.functionDeclaration))
        return { result: { value: params.arguments[1].value.map((id: number) => ({ sourceText: id === 7 ? "Hidden item" : "XX Paint YY", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false })) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (unstable) {
      await expect(page.snapshot()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "text-paint-unstable" } });
      expect(layouts).toBe(4);
    } else {
      expect((await page.snapshot()).snapshot).toContain('StaticText "Hidden item"');
      expect(layouts).toBe(3);
    }
    expect(axCaptures).toBe(2);
    await runtime.abortSessions();
  });
  it("batches text paint evidence in the owning frame and projects only painted fragments", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["hidden", "painted"] },
        { nodeId: "hidden", parentId: "root", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value: "Hidden item" } },
        { nodeId: "painted", parentId: "root", backendDOMNodeId: 8, role: { value: "StaticText" }, name: { value: "XX Paint YY" } },
      ] };
      if (method === "DOM.resolveNode") return { object: { objectId: `paint-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE) return { result: { value: [
        { sourceText: "Hidden item", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false },
        { sourceText: "XX Paint YY", ranges: [], selection: { start: 3, end: 8, text: "Paint" }, firstLineRisk: false, firstLetterRisk: false, unknown: false },
      ] } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).snapshot();
    expect(result.snapshot).not.toContain("Hidden item");
    expect(result.snapshot).toContain('StaticText "Paint"');
    expect(result.snapshot).not.toContain("XX Paint YY");
    const calls = command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"));
    expect(calls).toHaveLength(2);
    expect(calls.every(([, , params]) => params.executionContextId === 33)).toBe(true);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE)).toHaveLength(1);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("reuses weak text handles but recomputes evidence, resolves misses, and invalidates on context destruction", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let selected = false, missFirst = false;
    const value = (id: number) => id === 7
      ? { sourceText: "Hidden item", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false }
      : { sourceText: "XX Paint YY", ranges: [], ...(selected ? { selection: { start: 3, end: 8, text: "Paint" } } : {}), firstLineRisk: false, firstLetterRisk: false, unknown: false };
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["hidden", "painted"] },
        { nodeId: "hidden", parentId: "root", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value: "Hidden item" } },
        { nodeId: "painted", parentId: "root", backendDOMNodeId: 8, role: { value: "StaticText" }, name: { value: "XX Paint YY" } },
      ] };
      if (method === "DOM.resolveNode") return { object: { objectId: `paint-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE)
        return { result: { value: params.arguments[1].value.map(value) } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_LOOKUP_SOURCE)
        return { result: { value: params.arguments[1].value.map((id: number) => missFirst && id === 7 ? null : value(id)) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    expect((await page.snapshot()).snapshot).not.toContain("Paint");
    selected = true;
    expect((await page.snapshot()).snapshot).toContain('StaticText "Paint"');
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(2);
    missFirst = true;
    await page.snapshot();
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(3);
    const tokensBefore = command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE).map(([, , params]) => params.arguments[0].value);
    expect(new Set(tokensBefore).size).toBe(1);
    runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextDestroyed", { executionContextId: 33 });
    await page.snapshot();
    const resolves = command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"));
    expect(resolves).toHaveLength(5);
    const tokensAfter = command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE).map(([, , params]) => params.arguments[0].value);
    expect(new Set(tokensAfter).size).toBe(2);
    await runtime.abortSessions();
  });

  it("coalesces concurrent captures before reusing a frame's text handles", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void, notified = false;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    const value = (id: number) => ({ sourceText: id === 7 ? "Hidden item" : "XX Paint YY", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) {
        if (!notified) { notified = true; notify(); }
        await hold;
        return { object: { objectId: `paint-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn" && [TEXT_PAINT_CACHE_REGISTER_SOURCE, TEXT_PAINT_CACHE_LOOKUP_SOURCE].includes(params.functionDeclaration))
        return { result: { value: params.arguments[1].value.map(value) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const first = page.snapshot(), second = page.snapshot();
    await entered;
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(2);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_LOOKUP_SOURCE)).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("cancels a queued capture without dispatching redundant text resolutions", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void, notified = false;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    const value = (id: number) => ({ sourceText: id === 7 ? "Hidden item" : "XX Paint YY", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) {
        if (!notified) { notified = true; notify(); }
        await hold; return { object: { objectId: `paint-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn" && [TEXT_PAINT_CACHE_REGISTER_SOURCE, TEXT_PAINT_CACHE_LOOKUP_SOURCE].includes(params.functionDeclaration))
        return { result: { value: params.arguments[1].value.map(value) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const first = page.snapshot();
    await entered;
    const frame = (runtime as any).frameDocuments.get(JSON.stringify([3, "root", null]));
    const firstTail = frame.paintCacheTail;
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const second = page.snapshot();
    await vi.waitFor(() => expect(frame.paintCacheTail).not.toBe(firstTail));
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
    await vi.waitFor(() => expect(frame.paintCacheTail).toBeUndefined());
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(2);
    await runtime.abortSessions();
  });

  it("discards in-flight paint evidence and rebuilds the cache after its frame context expires", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void, firstBatch = true;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    const value = (id: number) => ({ sourceText: id === 7 ? "Hidden item" : "XX Paint YY", ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) {
        if (firstBatch) { notify(); await hold; }
        return { object: { objectId: `paint-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE)
        return { result: { value: params.arguments[1].value.map(value) } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const pending = (await runtime.createPage(3)).snapshot();
    await entered;
    runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextDestroyed", { executionContextId: 33 });
    firstBatch = false;
    release();
    await pending;
    expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(4);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE)).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("waits for all text-node resolutions to settle before releasing their group on failure", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) {
        if (params.backendNodeId === 7) throw new Error("CDP disconnected");
        notify(); await hold; return { object: { objectId: "late-node" } };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const pending = (await runtime.createPage(3)).snapshot();
    const rejected = expect(pending).rejects.toThrow("CDP disconnected");
    await entered;
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toBe(false);
    release();
    await rejected;
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("responds to cancellation immediately and releases late text-node handles afterward", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) { notify(); await hold; return { object: { objectId: `late-${params.backendNodeId}` } }; }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const pending = (await runtime.createPage(3)).snapshot();
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
    await vi.waitFor(() => expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(1));
    await runtime.abortSessions();
  });

  it("does not silently accept a failed text paint analysis command", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot") return textPaintSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-text-paint:")) return { object: { objectId: `paint-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === TEXT_PAINT_CACHE_REGISTER_SOURCE) throw new Error("paint analysis failed");
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    await expect((await runtime.createPage(3)).snapshot()).rejects.toThrow("paint analysis failed");
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-text-paint:"))).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("waits for each frame before capture and repeats capture if a frame starts loading afterward", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let ready = false, startedCapture = false, afterCaptureReady = false;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.readyState === 'complete'}" && params.objectId === "doc-31")
        return { result: { value: startedCapture ? afterCaptureReady : ready } };
      if (method === "Accessibility.getFullAXTree") {
        startedCapture = true;
        return { nodes: [] };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const pending = page.inspect();
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Runtime.callFunctionOn", expect.objectContaining({ objectId: "doc-31" })));
    expect(command.mock.calls.some(([, method]) => method === "Accessibility.getFullAXTree")).toBe(false);
    ready = true;
    await vi.waitFor(() => expect(command.mock.calls.some(([, method]) => method === "Accessibility.getFullAXTree")).toBe(true));
    // The first capture is discarded when a frame becomes incomplete before
    // the post-capture check. No result may be returned until it completes.
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.objectId === "doc-31").length).toBeGreaterThanOrEqual(3));
    expect(settled).toBe(false);
    afterCaptureReady = true;
    await pending;
    expect(command.mock.calls.filter(([, method, params]) => method === "Accessibility.getFullAXTree" && !params.frameId)).toHaveLength(2);
    await runtime.abortSessions();
  });

  it("retries frame readiness after navigation replaces a document", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void, first = true;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.readyState === 'complete'}" && params.objectId === "doc-31" && first) {
        first = false; notify(); await hold; return { result: { value: true } };
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const pending = page.snapshot();
    await entered;
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "same", parentId: "root" } });
    release();
    await pending;
    expect(command.mock.calls.filter(([, method, params]) => method === "Page.createIsolatedWorld" && params.frameId === "same")).toHaveLength(2);
    await runtime.abortSessions();
  });

  it("cancels while a frame readiness check is in flight", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.readyState === 'complete'}") { notify(); await hold; return { result: { value: true } }; }
      return original(source, method, params);
    });
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3);
    const pending = page.snapshot();
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
    await runtime.abortSessions();
  });

  it("captures same-process frame AX trees separately and skips hidden frame owners", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let hideSame = true;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        const name = params.frameId === "same" ? "Same frame" : params.frameId === "cross" ? "Other frame" : "Root frame";
        return { nodes: [{ nodeId: "shared-id", backendDOMNodeId: params.frameId === "same" ? 8 : params.frameId === "cross" ? 9 : 7,
          role: { value: "button" }, name: { value: name }, childIds: [] }] };
      }
      if (method === "DOMSnapshot.captureSnapshot") return { strings: ["1", "0", "visible", "auto"], documents: [{
        nodes: { backendNodeId: [101, 102], parentIndex: [-1, -1] },
        layout: { nodeIndex: [0, 1], bounds: [[0, 0, 100, 100], [0, 0, 100, 100]], styles: [[hideSame ? 1 : 0, 2, 2, 2, 3], [0, 2, 2, 2, 3]] },
      }] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const before: any = await page.inspect();
    expect(before.items.map((item: any) => item.line).join("\n")).not.toContain('button "Same frame"');
    hideSame = false;
    const after: any = await page.inspect();
    const lines = after.items.map((item: any) => item.line).join("\n");
    expect(lines).toContain('button "Root frame"');
    expect(lines).toContain('button "Same frame"');
    expect(lines).toContain('button "Other frame"');
    expect(new Set(after.items.map((item: any) => item.id)).size).toBe(after.items.length);
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Accessibility.getFullAXTree", { frameId: "same" });
    await runtime.abortSessions();
  });

  it.each([false, true])("restarts AX capture when a child attaches in flight (first request fails: %s)", async (failFirst) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void; let notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notify = resolve; });
    let rootCaptures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        if (!source.sessionId && !params.frameId && ++rootCaptures === 1) {
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
    expect(command.mock.calls.filter(([source, method, params]) => source.sessionId === "child" && method === "Accessibility.getFullAXTree" && !params.frameId)).toHaveLength(1);
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
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.getFullAXTree")).toEqual([
      [{ tabId: 3, sessionId: "child" }, "Accessibility.getFullAXTree", {}],
      [{ tabId: 3, sessionId: "child" }, "Accessibility.getFullAXTree", { frameId: "nested" }],
    ]);
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
    expect(command.mock.calls.filter(([, method, params]) => method === "Accessibility.getFullAXTree" && !params.frameId)).toHaveLength(1);
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
