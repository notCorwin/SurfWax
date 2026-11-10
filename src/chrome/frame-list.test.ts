import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";
import { TEXT_PAINT_CACHE_LOOKUP_SOURCE, TEXT_PAINT_CACHE_REGISTER_SOURCE } from "./snapshot-text-paint";
import { formatSnapshotItem, type ProjectedSnapshotNode } from "./snapshot-render";

const itemLine = (item: ProjectedSnapshotNode & { change?: string }) =>
  item.role === undefined && item.change === "removed" ? "" : formatSnapshotItem(item);
const inspectText = (value: { items?: readonly ProjectedSnapshotNode[] }) => (value.items ?? []).map(itemLine).join("\n");

function emptyFrameDocument(frameId: number) {
  return { frameId, nodes: { backendNodeId: [], parentIndex: [], nodeType: [], nodeName: [] },
    layout: { nodeIndex: [], bounds: [], styles: [] } };
}

/** Model a rendered control and its painted text in its owning DOM document. */
function addVisibleControl(snapshot: any, documentIndex: number, backend: number, name: string, tag = "BUTTON") {
  const doc = snapshot.documents[documentIndex], strings: string[] = snapshot.strings;
  const intern = (value: string) => { const i = strings.indexOf(value); return i < 0 ? strings.push(value) - 1 : i; };
  const style = ["1", "visible", "visible", "visible", "visible", "static", "none", "none", "none", "none", "auto", "none", "none", "none", "none", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "none", "0px", "border-box", "none", "none", "clip", "none", "none", "none"].map(intern);
  const nodes = doc.nodes, layout = doc.layout;
  nodes.nodeValue ??= nodes.backendNodeId.map(() => -1);
  layout.text ??= layout.nodeIndex.map(() => -1);
  const parent = nodes.backendNodeId.length;
  nodes.backendNodeId.push(backend); nodes.parentIndex.push(-1); nodes.nodeType.push(1); nodes.nodeName.push(intern(tag)); nodes.nodeValue.push(-1);
  layout.nodeIndex.push(parent); layout.bounds.push([0, 0, 100, 20]); layout.styles.push(style); layout.text.push(-1);
  const text = nodes.backendNodeId.length;
  nodes.backendNodeId.push(1_000_000 + backend); nodes.parentIndex.push(parent); nodes.nodeType.push(3); nodes.nodeName.push(intern("#text")); nodes.nodeValue.push(intern(name));
  layout.nodeIndex.push(text); layout.bounds.push([0, 0, 100, 20]); layout.styles.push(style); layout.text.push(intern(name));
  return snapshot;
}

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
  }, emptyFrameDocument(id("same")), emptyFrameDocument(id("cross"))] };
}

function duplicateLabelSnapshot(labelCount: number, controlCount: number) {
  const snapshot = textPaintSnapshot(), document = snapshot.documents[0]!;
  const intern = (value: string) => {
    const existing = snapshot.strings.indexOf(value);
    return existing < 0 ? snapshot.strings.push(value) - 1 : existing;
  };
  const nodes = document.nodes as any, layout = document.layout as any;
  nodes.attributes = nodes.backendNodeId.map(() => []);
  const opaque = intern("rgb(0, 0, 0)");
  for (const style of layout.styles) if (style.length) style[21] = opaque;
  const style = [...layout.styles[1]];
  const add = (id: number, parent: number, type: number, name: string, text: string, attributes: number[] = []) => {
    const index = nodes.backendNodeId.length;
    nodes.backendNodeId.push(id); nodes.parentIndex.push(parent); nodes.nodeType.push(type);
    nodes.nodeName.push(intern(name)); nodes.nodeValue.push(intern(text)); nodes.attributes.push(attributes);
    layout.nodeIndex.push(index); layout.bounds.push([0, 0, 100, 20]); layout.styles.push(style); layout.text.push(intern(text));
    return index;
  };
  const forKey = intern("for"), idKey = intern("id"), shared = intern("same-id");
  for (let i = 0; i < labelCount; i++) {
    const parent = add(20_000 + i, 0, 1, "LABEL", "", [forKey, shared]);
    add(30_000 + i, parent, 3, "#text", `Label${i}`);
  }
  for (let i = 0; i < controlCount; i++) add(10_000 + i, 0, 1, "INPUT", "", [idKey, shared]);
  return snapshot;
}

function labelCaptureHarness(labelCount: number, controlCount: number) {
  const { runtime, command } = harness(), original = command.getMockImplementation()!;
  const snapshot = duplicateLabelSnapshot(labelCount, controlCount);
  const labelName = Array.from({ length: labelCount }, (_, i) => `Label${i}`).join(" ");
  command.mockImplementation(async (source, method, params = {}) => {
    if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) return snapshot;
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    if (method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-dom-snapshot:")) return { object: { objectId: `control-${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("labelCount:")) {
      const first = params.objectId === "control-10000";
      return { result: { value: { meta: { connected: true, tag: "input", identityRole: "textbox", identityName: first ? labelName : "" },
        attributes: { id: "same-id" }, labelCount: first ? labelCount : 0 } } };
    }
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return Array.from(this.labels || [])}")
      return { result: { objectId: "label-array" } };
    if (method === "Runtime.getProperties" && params.objectId === "label-array") return { result: [
      ...Array.from({ length: labelCount }, (_, i) => ({ name: String(i), value: { objectId: `label-${i}` } })),
      { name: "length", value: { value: labelCount } },
    ] };
    if (method === "DOM.describeNode" && params.objectId?.startsWith("label-")) return { node: {
      backendNodeId: 20_000 + Number(params.objectId.slice(6)), nodeType: 1, nodeName: "LABEL",
    } };
    if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
    return original(source, method, params);
  });
  return { runtime, command, labelName };
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
    if (method === "DOM.describeNode" && params.objectId === "doc-404") return { node: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: "#document" } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [] };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("surf-wax:semantic-native-observation")) return { result: { value: { url: "https://top.test/", title: "Top", viewport: { x: 0, y: 0, width: 1000, height: 1000, scale: 1 }, rows: [{ key: 1, depth: 0, role: "text", text: "Independent", bounds: [10, 10, 50, 20] }], gaps: [] } } };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.readyState === 'complete'}") return { result: { value: true } };
    if (method === "Accessibility.queryAXTree") return { nodes: [{ nodeId: "node", backendDOMNodeId: 8, role: { value: "button" }, name: { value: params.objectId ?? "wrong-root" } }] };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 8, role: { value: "button" }, name: { value: "doc-31" } }] };
    if (method === "DOM.getFrameOwner") return { backendNodeId: { same: 101, cross: 102, nested: 103 }[params.frameId as "same" | "cross" | "nested"] };
    if (method === "DOMSnapshot.captureSnapshot") {
      const strings = ["1", "visible", "auto", "IFRAME", "root", "same", "cross", "nested"];
      const document = (frameId: number, backendNodeId: number[]) => ({ frameId,
        nodes: { backendNodeId, parentIndex: backendNodeId.map(() => -1), nodeType: backendNodeId.map(() => 1), nodeName: backendNodeId.map(() => 3) },
        layout: { nodeIndex: backendNodeId.map((_, index) => index), bounds: backendNodeId.map(() => [0, 0, 100, 100]), styles: backendNodeId.map(() => [0, 1, 1, 1, 2]) } });
      return { strings, documents: source.sessionId === "nested-child" || source.sessionId === "new-child"
        ? [emptyFrameDocument(7)] : source.sessionId
          ? [document(6, [103]), emptyFrameDocument(7)]
          : [document(4, [101, 102]), emptyFrameDocument(5), emptyFrameDocument(6)] };
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "node-object" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { connected: true, role: "button", name: "Open", tag: "button", text: "Open" } } };
    return {};
  });
  const runtime = new AutomationRuntime({ chromeApi: { runtime: { id: "unit-extension" }, tabs: { query: async () => [{ id: 3 }] }, scripting: { executeScript: async () => {
    runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextCreated", { context: { id: 404, uniqueId: "observation-context", origin: "chrome-extension://unit-extension", auxData: { frameId: "root", type: "isolated", isDefault: false } } });
    return [{ frameId: 0, result: 2 }];
  } } } as never,
    command: async (source, method, params) => {
      const result = await command(source, method, params);
      if (method !== "DOMSnapshot.captureSnapshot") return result;
      // Add the viewport metadata returned by Chrome to synthetic frame DOMs.
      const snapshot = structuredClone(result);
      for (const doc of snapshot.documents ?? []) {
        doc.scrollOffsetX ??= 0; doc.scrollOffsetY ??= 0;
        let node = doc.nodes.nodeName.findIndex((name: number) => snapshot.strings[name] === "#document");
        if (node < 0) {
          node = doc.nodes.backendNodeId.length;
          let name = snapshot.strings.indexOf("#document");
          if (name < 0) name = snapshot.strings.push("#document") - 1;
          for (const [field, value] of [["backendNodeId", 2_000_000_000 + doc.frameId], ["parentIndex", -1], ["nodeType", 9], ["nodeName", name], ["nodeValue", -1], ["attributes", []]] as const)
            if (Array.isArray(doc.nodes[field])) doc.nodes[field].push(value);
        }
        let layout = doc.layout.nodeIndex.indexOf(node);
        if (layout < 0) {
          layout = doc.layout.nodeIndex.push(node) - 1;
          doc.layout.bounds.push([0, 0, 100000, 100000]); doc.layout.styles.push([]);
          if (Array.isArray(doc.layout.text)) doc.layout.text.push(-1);
        }
      }
      return snapshot;
    }, pressChord: async () => {}, detach: async () => {} });
  runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
  return { runtime, command };
}

describe("frame tree discovery", () => {
  it("resolves only actual label associations when many controls share an id", async () => {
    const labelCount = 80, controlCount = 80;
    const { runtime, command, labelName } = labelCaptureHarness(labelCount, controlCount);
    try {
      const snapshot = await (await runtime.createPage(3)).snapshot();
      expect(snapshot.snapshot).toContain(`textbox "${labelName}"`);
      expect(command.mock.calls.filter(([, method, params]) => method === "DOM.resolveNode" && params.objectGroup?.startsWith("surf-wax-dom-snapshot:"))).toHaveLength(controlCount);
      expect(command.mock.calls.filter(([, method]) => method === "Runtime.getProperties")).toHaveLength(1);
      expect(command.mock.calls.filter(([, method, params]) => method === "DOM.describeNode" && params.objectId?.startsWith("label-"))).toHaveLength(labelCount);
      expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("labelCount:"))
        .every(([, , params]) => !params.arguments?.length)).toBe(true);
    } finally { await runtime.abortSessions(); }
  });

  it("stops label resolution after abort and releases its object group after in-flight commands settle", async () => {
    const { runtime, command } = labelCaptureHarness(40, 1), original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.describeNode" && params.objectId === "label-0") { notify(); await held; }
      return original(source, method, params);
    });
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const pending = (await runtime.createPage(3)).inspect();
    void pending.catch(() => undefined);
    try {
      await entered;
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejection;
      const released = () => command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-dom-snapshot:"));
      expect(released()).toBe(false);
      release();
      await vi.waitFor(() => expect(released()).toBe(true));
      expect(command.mock.calls.filter(([, method, params]) => method === "DOM.describeNode" && params.objectId?.startsWith("label-"))).toHaveLength(32);
    } finally { release(); await runtime.abortSessions(); }
  });

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
    // The stable retry has a final post-AX DOM confirmation.
    expect(layouts).toBe(6);
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
      const result = await page.snapshot();
      expect(result).toMatchObject({ partial: true, limitations: expect.stringContaining("text-paint-unstable") });
      expect(result.snapshot).not.toContain("Hidden item");
      expect(layouts).toBe(4);
    } else {
      expect((await page.snapshot()).snapshot).toContain('StaticText "Hidden item"');
      // One more capture verifies that the final AX and DOM views agree.
      expect(layouts).toBe(4);
    }
    expect(axCaptures).toBe(2);
    await runtime.abortSessions();
  });
  it.each([false, true])("checks the accessibility tree before accepting changing unrendered text: %s", async (semanticChange) => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let capture = 0, ax = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const snapshot: any = await original(source, method, params);
        const doc = snapshot.documents[0], nodes = doc.nodes;
        const name = snapshot.strings.push("#text") - 1;
        const value = snapshot.strings.push(`hidden-${++capture}`) - 1;
        nodes.nodeValue = nodes.backendNodeId.map(() => -1);
        nodes.backendNodeId.push(42); nodes.parentIndex.push(-1); nodes.nodeType.push(3); nodes.nodeName.push(name); nodes.nodeValue.push(value);
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: semanticChange ? [{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: String(++ax) } }] : [] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (semanticChange) {
      const result = await page.snapshot();
      expect(result).toMatchObject({ partial: true, limitations: expect.stringContaining("Read-only") });
      expect(result.snapshot).not.toContain("hidden-");
    }
    else await expect(page.snapshot()).resolves.not.toHaveProperty("partial");
    await runtime.abortSessions();
  });
  it("returns a partial snapshot of changing visible text after one confirming retry", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let captures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const snapshot = addVisibleControl(await original(source, method, params), 0, 50, `Tick${++captures % 2}`, "DIV");
        for (const document of snapshot.documents) {
          document.nodes.nodeValue ??= document.nodes.backendNodeId.map(() => -1);
          document.layout.text ??= document.layout.nodeIndex.map(() => -1);
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
        { nodeId: "text", parentId: "root", backendDOMNodeId: 1_000_050, role: { value: "StaticText" }, name: { value: "Tick0" } },
      ] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).snapshot();
    expect(result).toMatchObject({ partial: true });
    expect(result.snapshot).not.toContain("Tick0");
    expect(result.snapshot).not.toContain("Tick1");
    expect(captures).toBe(4);
    await runtime.abortSessions();
  });
  it("bounds repeated detached-node errors during snapshot confirmation", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let confirmation = false;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId && confirmation) {
        confirmation = false;
        throw new Error("Could not find node with given id");
      }
      if (method === "Accessibility.getFullAXTree") { confirmation = true; return { nodes: [] }; }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 500);
    runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true }, signal: abort.signal });
    try {
      await expect((await runtime.createPage(3)).snapshot()).resolves.toMatchObject({ partial: true, limitations: expect.stringContaining("text-paint-node-unstable") });
    } finally { clearTimeout(timer); await runtime.abortSessions(); }
  });
  it("recovers a detached text node during confirmation and returns its later stable value", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let captures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        if (++captures === 2) throw new Error("Could not find node with given id");
        const snapshot = addVisibleControl(await original(source, method, params), 0, 50, `Tick${captures === 1 ? 0 : 1}`, "DIV");
        for (const document of snapshot.documents) {
          document.nodes.nodeValue ??= document.nodes.backendNodeId.map(() => -1);
          document.layout.text ??= document.layout.nodeIndex.map(() => -1);
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
        { nodeId: "text", parentId: "root", backendDOMNodeId: 1_000_050, role: { value: "StaticText" }, name: { value: "Tick0" } },
      ] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).snapshot();
    expect(result).not.toHaveProperty("partial");
    expect(result.snapshot).not.toContain("Tick0");
    expect(result.snapshot).toContain('StaticText "Tick1"');
    await runtime.abortSessions();
  });
  it("bounds discovery of continuously changing new text regions without a caller deadline", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let captures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const snapshot: any = await original(source, method, params);
        captures++;
        for (let i = 0; i < 100; i++) addVisibleControl(snapshot, 0, 10_000 + i, `Tick${captures % 2 === 0 && i === (captures / 2 - 1) % 100 ? 1 : 0}`, "DIV");
        for (const document of snapshot.documents) {
          document.nodes.nodeValue ??= document.nodes.backendNodeId.map(() => -1);
          document.layout.text ??= document.layout.nodeIndex.map(() => -1);
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    try {
      await expect((await runtime.createPage(3)).snapshot()).resolves.toMatchObject({ partial: true, limitations: expect.stringContaining("dynamic-text-unstable") });
      expect(captures).toBeLessThan(25);
    } finally { await runtime.abortSessions(); }
  }, 10000);
  it("bounds recapture when text alternates between changing and briefly stable", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let captures = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const value = ++captures % 4 === 1 ? 0 : 1;
        const snapshot = addVisibleControl(await original(source, method, params), 0, 50, `Tick${value}`, "DIV");
        for (const document of snapshot.documents) {
          document.nodes.nodeValue ??= document.nodes.backendNodeId.map(() => -1);
          document.layout.text ??= document.layout.nodeIndex.map(() => -1);
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: params.frameId ? [] : [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
        { nodeId: "text", parentId: "root", backendDOMNodeId: 1_000_050, role: { value: "StaticText" }, name: { value: "Tick0" } },
      ] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    try {
      const result = await (await runtime.createPage(3)).snapshot();
      expect(result).toMatchObject({ partial: true });
      expect(result.snapshot).not.toContain("Tick0");
      expect(result.snapshot).not.toContain("Tick1");
      expect(captures).toBeLessThan(10);
    } finally { await runtime.abortSessions(); }
  });
  it("bounds detached-node recovery when each retry discovers a different changing region", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let confirmation = false, recovery = false, changes = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        if (confirmation) { confirmation = false; recovery = true; throw new Error("Could not find node with given id"); }
        const snapshot: any = await original(source, method, params);
        const changed = recovery ? changes++ : -1; recovery = false;
        for (let i = 0; i < 20; i++) addVisibleControl(snapshot, 0, 10_000 + i, `Tick${i === changed ? 1 : 0}`, "DIV");
        for (const document of snapshot.documents) {
          document.nodes.nodeValue ??= document.nodes.backendNodeId.map(() => -1);
          document.layout.text ??= document.layout.nodeIndex.map(() => -1);
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") { confirmation = true; return { nodes: [] }; }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    try {
      await expect((await runtime.createPage(3)).snapshot()).resolves.toMatchObject({ partial: true, limitations: expect.stringContaining("dynamic-text-unstable") });
      expect(changes).toBeLessThan(20);
    } finally { await runtime.abortSessions(); }
  });
  it("returns a read-only sample when visible changes invalidate the accessibility recheck", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let capture = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const snapshot: any = await original(source, method, params), doc = snapshot.documents[0], nodes = doc.nodes;
        const name = snapshot.strings.push("#text") - 1, value = snapshot.strings.push(`hidden-${++capture}`) - 1;
        nodes.nodeValue = nodes.backendNodeId.map(() => -1);
        nodes.backendNodeId.push(42); nodes.parentIndex.push(-1); nodes.nodeType.push(3); nodes.nodeName.push(name); nodes.nodeValue.push(value);
        if (capture >= 5) doc.layout.bounds[0] = [1_000_000, 0, 100, 100];
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).snapshot();
    expect(result).toMatchObject({ partial: true, limitations: expect.stringContaining("Read-only") });
    expect(result.snapshot).not.toContain("hidden-");
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
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = { strings: ["1", "0", "visible", "auto", "IFRAME", "root", "same", "cross"], documents: [{
          frameId: 5, nodes: { backendNodeId: [101, 102], parentIndex: [-1, -1], nodeType: [1, 1], nodeName: [4, 4] },
          layout: { nodeIndex: [0, 1], bounds: [[0, 0, 100, 100], [0, 0, 100, 100]], styles: [[hideSame ? 1 : 0, 2, 2, 2, 3], [0, 2, 2, 2, 3]] },
        }, emptyFrameDocument(6), emptyFrameDocument(7)] };
        addVisibleControl(snapshot, 0, 7, "Root frame");
        addVisibleControl(snapshot, 1, 8, "Same frame");
        return addVisibleControl(snapshot, 2, 9, "Other frame");
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const before: any = await page.inspect();
    expect(inspectText(before)).not.toContain('button "Same frame"');
    hideSame = false;
    const after: any = await page.inspect();
    const lines = inspectText(after);
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
        return { nodes: [{ nodeId: child ? "child-ax" : "root-ax", backendDOMNodeId: 8, role: { value: "button" }, name: { value: child ? "Child target" : "Root target" }, childIds: [] }] };
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = await original(source, method, params);
        addVisibleControl(snapshot, 0, 8, source.sessionId ? "Child target" : "Root target");
        if (!source.sessionId) { addVisibleControl(snapshot, 1, 8, "Root target"); addVisibleControl(snapshot, 2, 8, "Root target"); }
        return snapshot;
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
    expect(inspectText(result)).toContain('button "Child target"');
    expect(rootCaptures).toBe(2);
    expect(command.mock.calls.filter(([source, method, params]) => source.sessionId === "child" && method === "Accessibility.getFullAXTree" && !params.frameId)).toHaveLength(1);
    await runtime.abortSessions();
  });

  it("keeps frame scopes stable on attachment and replaces semantic IDs and refs when the target changes", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        const child = !!source.sessionId && !params.frameId;
        return { nodes: [{ nodeId: "shared-ax", backendDOMNodeId: 8, ...(child ? { frameId: "cross" } : {}),
          role: { value: "button" }, name: { value: child ? "Cross control" : params.frameId ? "Other control" : "Root control" }, childIds: [] }] };
      }
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){ return this.isConnected; }") return { result: { value: true } };
      if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 8, role: { value: "button" },
        name: { value: source.sessionId ? "Cross control" : "Root control" } }] };
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = await original(source, method, params);
        addVisibleControl(snapshot, 0, 8, source.sessionId ? "Cross control" : "Root control");
        if (!source.sessionId) { addVisibleControl(snapshot, 1, 8, "Other control"); addVisibleControl(snapshot, 2, 8, "Other control"); }
        return snapshot;
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const initial: any = await page.inspect({ fields: ["text", "state", "ref"] });
    const root = initial.items.find((item: any) => itemLine(item).includes('button "Root control"'));
    expect(root.id).toMatch(/^[0-9a-z]+\.ashared-ax$/);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "old-child", targetInfo: { type: "iframe", targetId: "cross" } });
    await expect(page.inspect({ fields: ["text", "state", "ref"], since: initial.observationId })).rejects.toMatchObject({ code: "stale-observation" });
    const attached: any = await page.inspect({ fields: ["text", "state", "ref"] });
    // A changed frame tree invalidates the delivered baseline, even when root identities survive.
    expect(attached.mode).toBe("full");
    expect(attached.items.some((item: any) => item.id === root.id)).toBe(true);
    const old = attached.items.find((item: any) => itemLine(item).includes('button "Cross control"'));
    expect(old).toMatchObject({ ref: expect.any(String) });
    expect(old.id).toMatch(/^[0-9a-z]+\.ashared-ax$/);
    expect(old.id).not.toBe(root.id);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "replacement-child", targetInfo: { type: "iframe", targetId: "cross" } });
    await expect(page.inspect({ fields: ["text", "state", "ref"], since: attached.observationId })).rejects.toMatchObject({ code: "stale-observation" });
    const changed: any = await page.inspect({ fields: ["text", "state", "ref"] });
    expect(changed.documentId).toBe(initial.documentId);
    expect(changed.mode).toBe("full");
    expect(changed.items.some((item: any) => item.id === old.id)).toBe(false);
    const replacement = changed.items.find((item: any) => itemLine(item).includes('button "Cross control"'));
    expect(replacement).toMatchObject({ ref: expect.any(String) });
    expect(replacement.id).not.toBe(old.id);
    expect(replacement.ref).not.toBe(old.ref);
    await expect(page.ref(replacement.ref).count()).resolves.toBe(1);
    await expect(page.ref(old.ref).count()).rejects.toMatchObject({ code: "stale-ref" });
    await runtime.abortSessions();
  });

  it.each([false, true])("uses the same actionable run-bound frame handle when the owner is AX-ignored: %s", async (ignored) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        if (!source.sessionId && !params.frameId) return { nodes: [
          { nodeId: "102", role: { value: "RootWebArea" }, childIds: ["owner"] },
          { nodeId: "owner", parentId: "102", backendDOMNodeId: 102, ignored, role: { value: "Iframe" }, name: { value: "Work item" }, childIds: [] },
        ] };
        return { nodes: [{ nodeId: "child", role: { value: "heading" }, name: { value: "Child document" }, childIds: [] }] };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    runtime.setContext({ conversationId: "c", runId: "run" });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const capture: any = await page.inspect();
    const owner = capture.items.find((item: any) => ignored ? item.id.endsWith(".d102") : item.id.endsWith(".aowner"));
    expect(owner).toEqual(expect.any(Object));
    // The iframe's accessible title is private metadata, not painted text.
    if (!ignored) { expect(owner.nameUnknown).toBe(true); expect(inspectText({ items: [owner] })).not.toContain("Work item"); }
    const root = capture.items.find((item: any) => item.id.endsWith(".a102"));
    expect(root).toEqual(expect.any(Object));
    expect(owner.id).not.toBe(root.id);
    const ref = owner.frameRef;
    expect(ref).toEqual(expect.any(String));
    expect(itemLine(owner)).not.toContain("[frame=");
    const marker = capture.items.find((item: any) => item.role === "frame-document" && item.frameRef === ref);
    expect(marker.id).toMatch(/^[0-9a-z]+\.m$/);
    expect(new Set([root.id, owner.id, marker.id]).size).toBe(3);
    const listed: any = await runtime.listFrames(3);
    expect(listed.frames.find((frame: any) => frame.url === "https://cross.test/").frameRef).toBe(ref);
    // Different runs cannot reuse the handle; a refresh capture using
    // context.runId shares it with tool calls whose logIdentity names that run.
    runtime.setContext({ conversationId: "c", runId: "other-run" });
    await expect(page.frameRef(ref!).getByRole("button").count()).rejects.toMatchObject({ code: "stale-frame" });
    runtime.setContext({ conversationId: "c", logIdentity: { runId: "run", toolCallId: "call", toolCallIdCanonical: true } });
    await expect(page.frameRef(ref!).getByRole("button").count()).resolves.toBe(1);
    runtime.handleEvent({ tabId: 3 }, "Page.frameDetached", { frameId: "cross" });
    await expect(page.frameRef(ref!).getByRole("button").count()).rejects.toMatchObject({ code: "stale-frame" });
    await runtime.abortSessions();
  });

  it("binds snapshot frame handles to the context that began capture", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void, held = false;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        if (!source.sessionId && !params.frameId && !held) { held = true; notify(); await hold; }
        return { nodes: [] };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    runtime.setContext({ conversationId: "c", runId: "initial-run" });
    const page = await runtime.createPage(3);
    const pending = page.inspect();
    await entered;
    runtime.setContext({ conversationId: "c", runId: "other-run" });
    release();
    const capture: any = await pending;
    const marker = capture.items.find((item: any) => item.id.endsWith(".m"));
    const ref = marker.frameRef;
    expect(ref).toEqual(expect.any(String));
    await expect(page.frameRef(ref!).getByRole("button").count()).rejects.toMatchObject({ code: "stale-frame" });
    runtime.setContext({ conversationId: "c", runId: "initial-run" });
    await expect(page.frameRef(ref!).getByRole("button").count()).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it("captures only the target session for a cross-process region", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let unrelatedChanges = 0;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "target-ax", backendDOMNodeId: 8, role: { value: "button" }, name: { value: "Regional target" }, childIds: [] }] };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
      if (method === "DOMSnapshot.captureSnapshot" && source.sessionId === "child") {
        const snapshot = await original(source, method, params);
        addVisibleControl(snapshot, 0, 8, "Regional target");
        // This same-target document is outside the selected button region.
        // Its continuous changes must not invalidate that observation.
        const unrelated = snapshot.documents[1];
        snapshot.strings.push("#text", `outside-${++unrelatedChanges}`);
        unrelated.nodes.backendNodeId.push(77); unrelated.nodes.parentIndex.push(-1); unrelated.nodes.nodeType.push(3);
        unrelated.nodes.nodeName.push(snapshot.strings.length - 2); unrelated.nodes.nodeValue = [snapshot.strings.length - 1];
        return snapshot;
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3);
    const cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    const result: any = await page.inspect({}, page.frameRef(cross.frameRef).getByRole("button"));
    expect(inspectText(result)).toContain('button "Regional target"');
    expect(unrelatedChanges).toBeGreaterThanOrEqual(3);
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.getFullAXTree")).toEqual([
      [{ tabId: 3, sessionId: "child" }, "Accessibility.getFullAXTree", {}],
    ]);
    await runtime.abortSessions();
  });

  it("does not report a complete region while a visible iframe owner has no attached frame", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
      if (method === "DOMSnapshot.captureSnapshot" && source.sessionId === "child") {
        const snapshot = await original(source, method, params), doc = snapshot.documents[0];
        snapshot.strings.push("SECTION");
        const root = doc.nodes.backendNodeId.length;
        doc.nodes.backendNodeId.push(8, 104); doc.nodes.parentIndex.push(-1, root); doc.nodes.nodeType.push(1, 1);
        doc.nodes.nodeName.push(snapshot.strings.length - 1, 3);
        doc.layout.nodeIndex.push(root, root + 1); doc.layout.bounds.push([0, 0, 100, 20], [0, 0, 100, 20]);
        doc.layout.styles.push([0, 1, 1, 1, 2], [0, 1, 1, 1, 2]);
        return snapshot;
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3);
    const cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    await expect(page.inspect({}, page.frameRef(cross.frameRef).getByRole("button")))
      .rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "frame-owner-not-attached" } });
    await runtime.abortSessions();
  });

  it("fails closed when a child frame owner is missing from the parent document", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
      if (method === "DOM.getFrameOwner" && params.frameId === "nested") return { backendNodeId: 404 };
      if (method === "DOMSnapshot.captureSnapshot" && source.sessionId === "child") {
        const snapshot = await original(source, method, params), doc = snapshot.documents[0];
        snapshot.strings.push("BUTTON");
        doc.nodes.backendNodeId.push(8); doc.nodes.parentIndex.push(-1); doc.nodes.nodeType.push(1); doc.nodes.nodeName.push(snapshot.strings.length - 1);
        doc.layout.nodeIndex.push(doc.nodes.backendNodeId.length - 1); doc.layout.bounds.push([0, 0, 100, 20]); doc.layout.styles.push([0, 1, 1, 1, 2]);
        return snapshot;
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3), cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    await expect(page.inspect({}, page.frameRef(cross.frameRef).getByRole("button")))
      .rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "missing-frame-owner" } });
    await runtime.abortSessions();
  });

  it("rejects a region inside a hidden frame before inspecting descendant readiness", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = await original(source, method, params);
        if (source.sessionId === "child") {
          const doc = snapshot.documents[0]; snapshot.strings.push("BUTTON");
          doc.nodes.backendNodeId.push(8); doc.nodes.parentIndex.push(-1); doc.nodes.nodeType.push(1); doc.nodes.nodeName.push(snapshot.strings.length - 1);
          doc.layout.nodeIndex.push(doc.nodes.backendNodeId.length - 1); doc.layout.bounds.push([0, 0, 100, 20]); doc.layout.styles.push([0, 1, 1, 1, 2]);
        } else {
          snapshot.strings.push("0");
          snapshot.documents[0].layout.styles[1][0] = snapshot.strings.length - 1;
        }
        return snapshot;
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const frames: any = await runtime.listFrames(3), cross = frames.frames.find((frame: any) => frame.url === "https://cross.test/");
    command.mockClear();
    await expect(page.inspect({}, page.frameRef(cross.frameRef).getByRole("button"))).rejects.toMatchObject({ code: "snapshot-region-unavailable" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.callFunctionOn" && params?.objectId === "doc-33" && params.functionDeclaration.includes("readyState"))).toBe(false);
    await runtime.abortSessions();
  });

  it.each([
    ["navigation", "snapshot"], ["navigation", "inspect"], ["target-detach", "snapshot"], ["target-detach", "inspect"],
  ] as const)("discards the old observation when %s occurs during the final DOM capture of %s", async (event, mode) => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    let rootLayouts = 0, rootAX = 0, changed = false;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        if (++rootLayouts === 2) { notify(); await hold; }
        return addVisibleControl(await original(source, method, params), 0, 7, changed ? "New document" : "Old document", "H1");
      }
      if (method === "Accessibility.getFullAXTree") {
        if (source.sessionId || params.frameId) return { nodes: [] };
        rootAX++;
        return { nodes: [{ nodeId: "root-ax", backendDOMNodeId: 7, role: { value: "heading" }, name: { value: changed ? "New document" : "Old document" }, childIds: [] }] };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      if (method === "Runtime.evaluate" && params.expression?.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (event === "target-detach") runtime.handleEvent({ tabId: 3 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "cross" } });
    const pending = mode === "snapshot" ? page.snapshot() : page.inspect();
    try {
      await entered;
      changed = true;
      if (event === "navigation") runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "root" } });
      else runtime.handleEvent({ tabId: 3 }, "Target.detachedFromTarget", { sessionId: "child" });
      release();
      const result: any = await pending;
      const text = mode === "snapshot" ? result.snapshot : inspectText(result);
      // Fresh inspect binds the internally verified final capture. Neither
      // mode can publish the old document under that new observation.
      expect(text).toContain('heading "New document"');
      expect(text).not.toContain('heading "Old document"');
      expect(rootAX).toBe(2);
      expect(rootLayouts).toBe(4);
    } finally { release(); await runtime.abortSessions(); }
  });

  it("aborts while resolving an AX-ignored visible control, before the CDP promise settles", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let release!: () => void, notify!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    let resolved = false;
    command.mockImplementation(async (source, method, params = {}) => {
      if (method === "DOMSnapshot.captureSnapshot" && !source.sessionId) {
        const snapshot = await original(source, method, params);
        const doc = snapshot.documents[0];
        snapshot.strings.push("BUTTON");
        doc.nodes.backendNodeId.push(500); doc.nodes.parentIndex.push(-1); doc.nodes.nodeType.push(1); doc.nodes.nodeName.push(snapshot.strings.length - 1);
        doc.layout.nodeIndex.push(doc.nodes.backendNodeId.length - 1); doc.layout.bounds.push([0, 0, 100, 20]); doc.layout.styles.push([0, 1, 1, 1, 2]);
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "DOM.resolveNode" && params.backendNodeId === 500) {
        notify(); await hold; resolved = true; return { object: { objectId: "late-control" } };
      }
      if (method === "Runtime.evaluate" && params.expression?.includes("({url:")) return { result: { value: { url: "https://top.test/", title: "Top" } } };
      return original(source, method, params);
    });
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const pending = (await runtime.createPage(3)).inspect();
    try {
      await entered;
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejection;
      expect(resolved).toBe(false);
      expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-dom-snapshot:"))).toBe(false);
      release();
      await vi.waitFor(() => expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup?.startsWith("surf-wax-dom-snapshot:"))).toBe(true));
    } finally { release(); await runtime.abortSessions(); }
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
