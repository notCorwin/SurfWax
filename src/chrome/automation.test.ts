import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";
import { encodeLogGraph } from "../log-graph";
import { EventSubscriptions } from "./event-subscriptions";
import { ProgramScope } from "./program";
import type { EventLogger } from "../logging";
import { ChromeExecutor } from "./executor";
import { createProgramTools, PROGRAM_TOOL_REGISTRY } from "./tool";
import { ToolScheduler } from "./tool-scheduler";
import { PLACEHOLDER_EVIDENCE_SOURCE } from "./snapshot-placeholder";
import { SNAPSHOT_CONTROL_PAINT_SOURCE } from "./snapshot-control-paint";
import { SNAPSHOT_DELIVERY_COMMIT } from "./snapshot-wire";

const inspectText = (value: any) => value.items.map((item: any) => item.line).join("\n");
const deliver = (value: any) => { const lease = value[SNAPSHOT_DELIVERY_COMMIT]; expect(lease.begin()).toBe(true); lease.finish(); };

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
  logger?: { telemetry: ReturnType<typeof vi.fn> },
  onDispatch = vi.fn(async (): Promise<void> => undefined),
  claimChooser?: (chooser: any) => { assert: () => void; finish: (outcome: "handled" | "not-dispatched" | "uncertain") => void },
) {
  metadata ??= [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }];
  const calls: Array<{ method: string; params?: any }> = [];
  let latestState: any = states[0];
  const tabsCreated = event<(tab: chrome.tabs.Tab) => void>();
  const downloadsCreated = event<(item: chrome.downloads.DownloadItem) => void>();
  // The mock AX tree is backed by matching DOM text/layout evidence. AX name
  // alone does not prove that a label is painted.
  const visibleSnapshot = () => {
    const strings = ["root", "#document", "#text", "1", "visible", "static", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "border-box", "clip"];
    const add = (value: string) => { const index = strings.indexOf(value); return index < 0 ? strings.push(value) - 1 : index; };
    const style = [3, 4, 4, 4, 4, 5, 6, 6, 6, 6, 7, 6, 6, 6, 6, 6, 7, 8, 9, 10, 11, 12, 6, 13, 14, 6, 6, 15, 6, 6, 6];
    const nodes = { backendNodeId: [1], parentIndex: [-1], nodeType: [9], nodeName: [1], nodeValue: [-1], attributes: [[]] as number[][] };
    const layout = { nodeIndex: [0], bounds: [[0, 0, 1000, 1000]], styles: [[]] as number[][], text: [-1] };
    metadata.forEach((item: any, index) => {
      const element = nodes.backendNodeId.length;
      const tag = (item.tag ?? (item.role === "button" ? "button" : "div")).toUpperCase();
      nodes.backendNodeId.push(item.backendId ?? 7 + index); nodes.parentIndex.push(0); nodes.nodeType.push(1); nodes.nodeName.push(add(tag)); nodes.nodeValue.push(-1); nodes.attributes.push([]);
      layout.nodeIndex.push(element); layout.bounds.push([0, 0, 500, 20]); layout.styles.push(style); layout.text.push(-1);
      const value = typeof item.text === "string" ? item.text : item.name;
      if (typeof value !== "string" || !value) return;
      const text = nodes.backendNodeId.length, string = add(value);
      nodes.backendNodeId.push(1_000_000 + index); nodes.parentIndex.push(element); nodes.nodeType.push(3); nodes.nodeName.push(2); nodes.nodeValue.push(string); nodes.attributes.push([]);
      layout.nodeIndex.push(text); layout.bounds.push([0, 0, 500, 20]); layout.styles.push(style); layout.text.push(string);
    });
    return { strings, documents: [{ frameId: 0, nodes, layout }] };
  };
  const command = vi.fn(async (_debuggee: chrome.debugger.Debuggee, method: string, params?: any): Promise<any> => {
    calls.push({ method, params });
    if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 0 }] };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://example.test/" } } };
    if (method === "DOMSnapshot.captureSnapshot") return visibleSnapshot();
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: metadata.map((_, index) => `node-${index}`) },
      ...metadata.map((item: any, index) => ({
        nodeId: `node-${index}`,
        parentId: "root",
        backendDOMNodeId: 7 + index,
        role: { value: item.role },
        name: { value: item.name },
        childIds: (item.text ?? item.name) ? [`text-${index}`] : [],
        properties: [{ name: "focusable", value: { value: true } }],
      })),
      ...metadata.flatMap((item: any, index) => {
        const text = item.text ?? item.name;
        return typeof text === "string" && text ? [{ nodeId: `text-${index}`, parentId: `node-${index}`, backendDOMNodeId: 1_000_000 + index,
          role: { value: "StaticText" }, name: { value: text }, childIds: [] }] : [];
      }),
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
    onDispatch,
    claimChooser,
    logger: logger as never,
  });
  return { runtime, calls, command, pressChord, detach, tabsCreated, onDispatch };
}

function textboxSnapshot(options: { value?: string; text?: string; role?: string; masked?: boolean; properties?: any[]; actions?: string[]; sibling?: boolean; independent?: boolean; logger?: { telemetry: ReturnType<typeof vi.fn> } } = {}) {
  const { runtime, command } = harness(undefined, undefined, options.logger);
  const original = command.getMockImplementation()!;
  const value = options.value ?? "DSP-17-A/7", text = options.text ?? value;
  const strings = ["root", "#document", "INPUT", "SPAN", "1", "visible", "static", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "border-box", "clip", "disc"];
  const textTag = strings.push("#text") - 1, textValue = strings.push(text) - 1, inputValue = strings.push(value) - 1;
  const style = [4, 5, 5, 5, 5, 6, 7, 7, 7, 7, 8, 7, 7, 7, 7, 7, 8, 9, 10, 11, 12, 13, 7, 14, 15, 7, options.masked ? 17 : 7, 16, 7, 7, 7];
  // Native input value text belongs to UA shadow DOM absent from DOMSnapshot.
  // A separately painted document text node, when requested, is an AX sibling.
  const snapshot = { strings, documents: [{ frameId: 0, nodes: { backendNodeId: [1, 7, 8], parentIndex: [-1, 0, 0], nodeType: [9, 1, options.independent ? 3 : 1], nodeName: [1, 2, options.independent ? textTag : 3], nodeValue: [-1, -1, options.independent ? textValue : -1], inputValue: { index: [1], value: [inputValue] }, shadowRootType: { index: [], value: [] } }, layout: { nodeIndex: [0, 1, 2], bounds: [[0, 0, 100, 100], [0, 0, 100, 20], [0, 25, 100, 20]], styles: [[], style, style], text: [-1, -1, options.independent ? textValue : -1] } }] };
  const editable = { name: "editable", value: { value: "plaintext" } };
  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["box", ...(options.independent ? ["text"] : []), ...(options.sibling ? ["extra"] : [])] },
    { nodeId: "box", parentId: "root", backendDOMNodeId: 7, role: { value: options.role ?? "textbox" }, name: { value: "Recipient" }, value: { value }, childIds: ["wrapper"] },
    { nodeId: "wrapper", parentId: "box", backendDOMNodeId: 9, role: { value: "generic" }, name: { value: "" }, properties: [editable], childIds: ["native-value"] },
    { nodeId: "native-value", parentId: "wrapper", backendDOMNodeId: 10, role: { value: "StaticText" }, name: { value }, childIds: [], properties: [editable] },
    ...(options.independent ? [{ nodeId: "text", parentId: "root", backendDOMNodeId: 8, role: { value: "StaticText" }, name: { value: text }, childIds: [], ...(options.properties ? { properties: options.properties } : {}), ...(options.actions ? { actions: options.actions } : {}) }] : []),
    ...(options.sibling ? [{ nodeId: "extra", parentId: "root", role: { value: "StaticText" }, name: { value: "extra" }, childIds: [] }] : []),
  ];
  command.mockImplementation(async (source, method, params) => {
    if (method === "DOMSnapshot.captureSnapshot") return snapshot;
    if (method === "Accessibility.getFullAXTree") return { nodes };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 31 };
    if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "native-document" } };
    if (method === "DOM.describeNode" && params?.backendNodeId === 7) return { node: { backendNodeId: 7, nodeName: "INPUT",
      shadowRoots: [{ shadowRootType: "user-agent", children: [{ children: [{ nodeType: 3, backendNodeId: 10, nodeValue: value }] }] }] } };
    if (method === "DOM.resolveNode" && params?.backendNodeId === 10 && params?.objectGroup?.startsWith("surf-wax-native-value:"))
      return { object: { objectId: "native-value-text" } };
    if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE) {
      expect(params.objectId).toBe("native-document");
      expect(params.arguments).toEqual([{ value: { native: [{ expected: value }], selects: [], selectHosts: [] } }, { value: true }, { value: true }, { objectId: "native-value-text" }]);
      const proven = /^[\x20-\x7e]{1,10}$/.test(value);
      return { result: { value: { scene: ["visible isolated document"], selectValues: [], selectStates: [], nativeValues: [proven ? { text: value, box: { x: 0, y: 0, width: 100, height: 20 } } : null] } } };
    }
    if (method === "DOM.describeNode") return { node: { backendNodeId: 8 } };
    return original(source, method, params);
  });
  return { runtime, command, value, text };
}

function placeholderSnapshot(options: { status?: string[]; label?: boolean; dependency?: boolean; transitive?: boolean; value?: string } = {}) {
  const { runtime, command } = harness(), original = command.getMockImplementation()!;
  const strings = ["root", "#document", "INPUT", "placeholder", "PRIVATE_HINT", "1", "visible", "static", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "border-box", "clip", "BUTTON", options.value ?? "", "DIV"];
  const style = [5, 6, 6, 6, 6, 7, 8, 8, 8, 8, 9, 8, 8, 8, 8, 8, 9, 10, 11, 12, 13, 14, 8, 15, 16, 8, 8, 17, 8, 8, 8];
  const snapshot = { strings, documents: [{ frameId: 0, nodes: { backendNodeId: [1, 7, 9, 10], parentIndex: [-1, 0, 0, 0], nodeType: [9, 1, 1, 1], nodeName: [1, 2, options.dependency ? 18 : 20, options.transitive ? 18 : 20], nodeValue: [-1, -1, -1, -1], attributes: [[], [3, 4], [], []], inputValue: { index: [1], value: [19] }, shadowRootType: { index: [], value: [] } },
    layout: { nodeIndex: [0, 1, 2, 3], bounds: [[0, 0, 100, 100], [0, 0, 100, 20], [0, 25, 100, 20], [0, 50, 100, 20]], styles: [[], style, style, style], text: [-1, -1, -1, -1] } }] };
  const source = options.label ? { type: "attribute", value: { value: "Label" }, attribute: "aria-label" } : { type: "placeholder", value: { value: "PRIVATE_HINT" }, attribute: "placeholder" };
  const related = (id: number) => ({ type: "relatedElement", attribute: "aria-labelledby", value: { value: "PRIVATE_HINT" }, attributeValue: { relatedNodes: [{ backendDOMNodeId: id }] } });
  const nodes: any[] = [
    { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["input", ...(options.dependency ? ["dependent"] : []), ...(options.transitive ? ["transitive"] : [])] },
    { nodeId: "input", parentId: "root", backendDOMNodeId: 7, role: { value: "textbox" }, name: { value: options.label ? "Label" : "PRIVATE_HINT", sources: [source] }, value: { value: options.value ?? "" }, childIds: [] },
    ...(options.dependency ? [{ nodeId: "dependent", parentId: "root", backendDOMNodeId: 9, role: { value: "button" }, name: { value: "PRIVATE_HINT", sources: [related(7)] }, childIds: [] }] : []),
    ...(options.transitive ? [{ nodeId: "transitive", parentId: "root", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "PRIVATE_HINT", sources: [related(9)] }, childIds: [] }] : []),
  ];
  let reads = 0;
  command.mockImplementation(async (source, method, params) => {
    if (method === "DOMSnapshot.captureSnapshot") return snapshot;
    if (method === "Accessibility.getFullAXTree") return { nodes };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 31 };
    if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "placeholder-document" } };
    if (method === "DOM.describeNode" && params?.backendNodeId === 7) return { node: { backendNodeId: 7, nodeName: "INPUT", shadowRoots: [{ shadowRootType: "user-agent", children: [
      { attributes: ["pseudo", "-webkit-input-placeholder"], children: [{ nodeType: 3, backendNodeId: 8 }] },
      ...(options.value ? [{ children: [{ nodeType: 3, backendNodeId: 12, nodeValue: options.value }] }] : []),
    ] }] } };
    if (method === "DOM.resolveNode" && params?.objectGroup?.startsWith("surf-wax-placeholder:")) return { object: { objectId: params.backendNodeId === 7 ? "placeholder-host" : "placeholder-text" } };
    if (method === "DOM.resolveNode" && params?.backendNodeId === 12 && params?.objectGroup?.startsWith("surf-wax-native-value:")) return { object: { objectId: "native-value-text" } };
    if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE) {
      expect(params.arguments).toEqual([{ value: { native: [{ expected: options.value }], selects: [], selectHosts: [] } }, { value: true }, { value: true }, { objectId: "native-value-text" }]);
      return { result: { value: { scene: ["visible isolated document"], selectValues: [], selectStates: [], nativeValues: [{ text: options.value, box: { x: 0, y: 0, width: 100, height: 20 } }] } } };
    }
    if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === PLACEHOLDER_EVIDENCE_SOURCE) {
      const status = (options.status ?? ["visible"])[Math.min(reads++, (options.status ?? ["visible"]).length - 1)];
      return { result: { value: status === "visible" ? { status, text: "PRIVATE_HINT" } : { status } } };
    }
    return original(source, method, params);
  });
  return { runtime, command, reads: () => reads };
}

describe("AutomationRuntime", () => {
  it.each([null, { multiple: false, size: 0, open: true }])("refuses a native popup with unproven visibility: %j", async (selectState) => {
    const { runtime, command } = harness([{ role: "combobox", name: "", tag: "select" }]);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["select"] },
        { nodeId: "select", parentId: "root", backendDOMNodeId: 7, role: { value: "combobox" }, childIds: ["popup"] },
        { nodeId: "popup", parentId: "select", role: { value: "MenuListPopup" }, childIds: ["option"] },
        { nodeId: "option", parentId: "popup", role: { value: "option" }, name: { value: "UNPROVEN_OPTION" }, childIds: [] },
      ] };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 31 };
      if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "select-document" } };
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE)
        return { result: { value: { scene: null, nativeValues: [], selectValues: [], selectStates: [selectState] } } };
      return original(source, method, params);
    });
    await expect((await runtime.createPage(3)).inspect()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "select-popup-unproven" } });
    await runtime.abortSessions();
  });
  it.each(["hidden", "outside-region"] as const)("ignores an unproven popup when its select is %s", async (placement) => {
    const outside = placement === "outside-region";
    const { runtime, command } = harness(outside
      ? [{ role: "region", name: "", tag: "section" }, { role: "combobox", name: "", tag: "select" }]
      : [{ role: "combobox", name: "", tag: "select" }]);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        if (!outside) {
          const hidden = snapshot.strings.push("hidden") - 1;
          snapshot.documents[0].layout.styles[1] = [...snapshot.documents[0].layout.styles[1]];
          snapshot.documents[0].layout.styles[1][3] = hidden;
        }
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [
        { nodeId: "root", role: { value: "RootWebArea" }, childIds: outside ? ["region", "select"] : ["select"] },
        ...(outside ? [{ nodeId: "region", parentId: "root", backendDOMNodeId: 7, role: { value: "region" }, childIds: [] }] : []),
        { nodeId: "select", parentId: "root", backendDOMNodeId: outside ? 8 : 7, role: { value: "combobox" }, childIds: ["popup"] },
        { nodeId: "popup", parentId: "select", role: { value: "MenuListPopup" }, childIds: ["option"] },
        { nodeId: "option", parentId: "popup", role: { value: "option" }, name: { value: "UNPROVEN_OPTION" }, childIds: [] },
      ] };
      if (outside && method === "Runtime.callFunctionOn" && params?.objectId === "node-array" && params.functionDeclaration === "function(){return this.length}")
        return { result: { value: 1 } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 31 };
      if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "select-document" } };
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE)
        return { result: { value: { scene: null, nativeValues: [], selectValues: [], selectStates: [null] } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const snapshot = outside ? await page.inspect({}, page.locator("#region")) : await page.inspect();
    expect(inspectText(snapshot)).not.toContain("UNPROVEN_OPTION");
    await runtime.abortSessions();
  });
  it.each([
    { readings: [true, false, false, false], fails: false },
    { readings: [true, false, true, false], fails: true },
    { readings: [true, true, true, true], modes: ["richtext", "plaintext", "plaintext", "plaintext"], fails: false },
  ])("retries or rejects when live editability changes during capture", async ({ readings, fails, modes }) => {
    const { runtime, command } = textboxSnapshot(), original = command.getMockImplementation()!;
    let reads = 0;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        snapshot.strings[2] = "DIV";
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") {
        const tree = structuredClone(await original(source, method, params));
        tree.nodes[1].role.value = "generic";
        tree.nodes[1].properties = [{ name: "focusable", value: { value: true } }, { name: "editable", value: { value: "richtext" } }];
        return tree;
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "editable-document" } };
      if (method === "DOM.resolveNode" && params?.objectGroup?.startsWith("surf-wax-editability:")) return { object: { objectId: "editable-host" } };
      if (method === "Runtime.callFunctionOn" && params?.objectId === "editable-host") {
        const index = Math.min(reads++, readings.length - 1), fillable = readings[index];
        return { result: { value: { fillable, disabled: false, readonly: false, mode: modes?.[index] ?? (fillable ? "richtext" : null) } } };
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (fails) await expect(page.inspect()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "editability-unstable" } });
    else if (modes) expect(inspectText(await page.inspect())).toContain("[editable=plaintext]");
    else expect(inspectText(await page.inspect())).not.toContain("[editable=");
    expect(reads).toBe(4);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-editability:"))).toHaveLength(4);
    await runtime.abortSessions();
  });
  it.each([
    { readings: [null, false, false, false], fails: false },
    { readings: [null, false, null, false], fails: true },
  ])("retries or rejects changing native indeterminate state during DOM fallback capture", async ({ readings, fails }) => {
    const { runtime, command } = textboxSnapshot(), original = command.getMockImplementation()!;
    let reads = 0;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        const document = snapshot.documents[0], nodes = document.nodes, layout = document.layout;
        nodes.backendNodeId = [1, 7]; nodes.parentIndex = [-1, 0]; nodes.nodeType = [9, 1]; nodes.nodeName = [1, 2]; nodes.nodeValue = [-1, -1];
        const type = snapshot.strings.push("type") - 1, checkbox = snapshot.strings.push("checkbox") - 1;
        const label = snapshot.strings.push("aria-label") - 1, name = snapshot.strings.push("Confirm") - 1;
        nodes.attributes = [[], [type, checkbox, label, name]]; nodes.inputChecked = { index: [] };
        nodes.inputValue = { index: [1], value: [snapshot.strings.push("on") - 1] };
        layout.nodeIndex = layout.nodeIndex.slice(0, 2); layout.bounds = layout.bounds.slice(0, 2);
        layout.styles = layout.styles.slice(0, 2); layout.text = layout.text.slice(0, 2);
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "root", role: { value: "RootWebArea" }, childIds: [] }] };
      if (method === "DOM.resolveNode" && params?.objectGroup?.startsWith("surf-wax-dom-snapshot:")) return { object: { objectId: "dom-checkbox" } };
      if (method === "Runtime.callFunctionOn" && params?.objectId === "dom-checkbox") {
        const checkedState = { supported: true, radio: false, value: readings[Math.min(reads++, readings.length - 1)] };
        if (params.functionDeclaration.includes("const labels=this.labels")) return { result: { value: {
          meta: { connected: true, tag: "input", identityRole: "checkbox", identityName: "Confirm" },
          fillability: { fillable: false, disabled: false, readonly: false, mode: null }, isContentEditable: false,
          attributes: { type: "checkbox", "aria-label": "Confirm" }, value: "on", checked: false, checkedState, labelCount: 0,
        } } };
        return { result: { value: checkedState } };
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (fails) await expect(page.inspect()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "dom-checked-unstable" } });
    else expect(inspectText(await page.inspect())).toContain("[checked=false]");
    expect(reads).toBe(4);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-dom-snapshot:"))).toHaveLength(2);
    await runtime.abortSessions();
  });
  it.each([
    { readings: [8, 9, 9, 9], fails: false },
    { readings: [8, 9, 8, 9], fails: true },
  ])("retries or rejects changing live aria-labelledby associations", async ({ readings, fails }) => {
    const { runtime, command } = textboxSnapshot(), original = command.getMockImplementation()!;
    let reads = 0;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        const nodes = snapshot.documents[0].nodes, layout = snapshot.documents[0].layout, add = (value: string) => snapshot.strings.push(value) - 1;
        snapshot.strings[2] = "DIV";
        nodes.inputValue = { index: [], value: [] };
        nodes.backendNodeId.push(9); nodes.parentIndex.push(0); nodes.nodeType.push(1); nodes.nodeName.push(3); nodes.nodeValue.push(-1);
        nodes.attributes = [[], [add("role"), add("switch"), add("aria-labelledby"), add("x")], [add("id"), add("x")], [add("id"), add("y")]];
        layout.nodeIndex.push(3); layout.bounds.push([0, 0, 100, 20]); layout.styles.push([...layout.styles[2]]); layout.text.push(-1);
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "root", role: { value: "RootWebArea" }, childIds: [] }] };
      if (method === "DOM.resolveNode" && params?.objectGroup?.startsWith("surf-wax-dom-snapshot:")) return { object: { objectId: "dom-switch" } };
      if (method === "Runtime.callFunctionOn" && params?.objectId === "dom-switch" && params.functionDeclaration.includes("const labels=this.labels")) return { result: { value: {
        meta: { connected: true, tag: "div", identityRole: "switch", identityName: "" },
        fillability: { fillable: false, disabled: false, readonly: false, mode: null }, isContentEditable: false,
        attributes: { role: "switch", "aria-labelledby": "x" }, checkedState: { supported: false }, labelCount: 0,
      } } };
      if (method === "Runtime.callFunctionOn" && params?.objectId === "dom-switch" && params.functionDeclaration.includes("ariaLabelledByElements"))
        return { result: { objectId: `aria-list-${readings[Math.min(reads++, readings.length - 1)]}` } };
      if (method === "Runtime.getProperties" && params?.objectId?.startsWith("aria-list-")) return { result: [
        { name: "0", value: { objectId: `aria-node-${params.objectId.slice(-1)}` } }, { name: "length", value: { value: 1 } },
      ] };
      if (method === "DOM.describeNode" && params?.objectId?.startsWith("aria-node-")) return { node: { nodeType: 1, backendNodeId: Number(params.objectId.slice(-1)) } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    if (fails) await expect(page.inspect()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "dom-aria-label-unstable" } });
    else await expect(page.inspect()).resolves.toMatchObject({ mode: "full" });
    expect(reads).toBe(4);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-dom-snapshot:"))).toHaveLength(2);
    await runtime.abortSessions();
  });
  it.each([true, false])("bounds an automatic snapshot after a click with ok=%s and releases the executor queue", async (ok) => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    let ready = false, observed!: () => void;
    const inspecting = new Promise<void>((resolve) => { observed = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression === "document.readyState === 'complete'") {
        observed(); return { result: { value: ready } };
      }
      return original(source, method, params);
    });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never });
    (executor as any).automation = runtime;
    (executor as any).currentBrowserState = vi.fn(async () => ({ windowId: 1, tabId: 3 }));
    (executor as any).boundPage = vi.fn(async () => page);
    executor.runProgram = vi.fn().mockResolvedValueOnce(ok ? { ok: true, result: { performed: true } } : { ok: false, error: { code: "click-failed" } })
      .mockImplementationOnce(async () => { ready = true; return { ok: true, result: "next" }; });
    const scheduler = new ToolScheduler(PROGRAM_TOOL_REGISTRY.map(({ name }) => name));
    const tools = createProgramTools(executor, { scheduler }) as Record<string, any>;
    const calls = [3, 4].map((tabId) => ({ type: "tool-call", toolCallId: String(tabId), toolName: "click", input: { target: { ref: "one" }, tabId } }));
    scheduler.prepare(calls, 3);
    vi.useFakeTimers();
    try {
      const first = tools.click.execute(calls[0]!.input, { toolCallId: "3" });
      const second = tools.click.execute(calls[1]!.input, { toolCallId: "4" });
      await inspecting;
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await first;
      expect(result).toMatchObject({ ok, pageSnapshotStatus: { state: "unavailable", error: { code: "timeout" } } });
      if (ok) expect(result.result).toEqual({ performed: true });
      else expect(result.error.code).toBe("click-failed");
      expect(result).not.toHaveProperty("pageSnapshot");
      expect(await second).toMatchObject({ ok: true, result: "next", pageSnapshot: { mode: "full" } });
    } finally { vi.useRealTimers(); executor.dispose(); }
  });

  it("bounds explicit inspect_page while it is queued and never starts a timed-out inspection", async () => {
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never });
    let release!: () => void;
    (executor as any).tail = new Promise<void>((resolve) => { release = resolve; });
    const currentBrowserState = vi.fn();
    (executor as any).currentBrowserState = currentBrowserState;
    const tools = createProgramTools(executor) as Record<string, any>;
    vi.useFakeTimers();
    try {
      const pending = tools.inspect_page.execute({ timeoutMs: 100 }, { toolCallId: "inspect" });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ ok: false, error: { code: "timeout" } });
      release(); await (executor as any).tail;
      expect(currentBrowserState).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); executor.dispose(); }
  });

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
      scoped.dispose();
      expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "owner")).toBe(true);
      expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "frame-document")).toBe(false);
    } finally { await runtime.abortSessions(); }
  });

  it("releases a frame owner when its description is aborted", async () => {
    const { runtime, command } = harness();
    const controller = new AbortController(); runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3), session = (runtime as any).sessions.get(3);
    vi.spyOn(runtime as any, "resolveDirect").mockImplementation(async () => {
      (runtime as any).objectDebuggees.set("owner", session.debuggee); return "owner";
    });
    const original = command.getMockImplementation()!;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode" && params?.objectId === "owner") { entered(); return new Promise(() => {}); }
      return original(source, method, params);
    });
    const pending = page.inspect({}, page.frameLocator("#frame").locator("#region"));
    await waiting; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "owner")).toBe(true);
    expect((runtime as any).objectDebuggees.has("owner")).toBe(false);
    await runtime.abortSessions();
  });

  it("releases frame owner handles after a failed description or ambiguous semantic match", async () => {
    const { runtime, command } = harness(); await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3), original = command.getMockImplementation()!;
    vi.spyOn(runtime as any, "resolveDirect").mockResolvedValue("owner");
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode" && params?.objectId === "owner") throw new Error("owner failed");
      return original(source, method, params);
    });
    await expect((runtime as any).locatorScope(session, { queries: [{ kind: "frame", value: "#frame" }] })).rejects.toThrow("owner failed");
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "owner")).toBe(true);
    vi.spyOn(runtime as any, "resolveSemantic").mockResolvedValue([{ objectId: "one", backendNodeId: 1 }, { objectId: "two", backendNodeId: 2 }]);
    await expect((runtime as any).locatorScope(session, { queries: [{ kind: "role", value: "group" }, { kind: "frame", value: "iframe" }] }))
      .rejects.toMatchObject({ code: "strict-mode" });
    for (const id of ["one", "two"]) expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === id)).toBe(true);
    await runtime.abortSessions();
  });

  it("releases a scoped reference root only after its consumer finishes, or transfers it as the result", async () => {
    const { runtime, command } = harness(); await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3), ref = { debuggee: session.debuggee };
    vi.spyOn(runtime as any, "resolveRef").mockImplementation(async () => {
      (runtime as any).objectDebuggees.set("ref-root", session.debuggee); return { ref, objectId: "ref-root" };
    });
    const resolveDom = vi.spyOn(runtime as any, "resolveDomOnce").mockImplementation(async (_session, _debuggee, _spec, root) => {
      expect(root).toBe("ref-root");
      expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "ref-root")).toBe(false);
      return "child";
    });
    const spec = { ref: "e1", queries: [{ kind: "css", value: "span" }] };
    await expect((runtime as any).resolveOnce(session, spec)).resolves.toBe("child");
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "ref-root")).toBe(true);
    expect((runtime as any).objectDebuggees.has("ref-root")).toBe(false);
    command.mockClear(); resolveDom.mockResolvedValue("ref-root");
    await expect((runtime as any).resolveOnce(session, spec)).resolves.toBe("ref-root");
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "ref-root")).toBe(false);
    expect((runtime as any).objectDebuggees.has("ref-root")).toBe(true);
    await runtime.abortSessions();
  });

  it("releases an owned reference root immediately if its consumer is aborted", async () => {
    const { runtime, command } = harness(), controller = new AbortController();
    runtime.setContext({ signal: controller.signal }); await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    vi.spyOn(runtime as any, "resolveRef").mockImplementation(async () => {
      (runtime as any).objectDebuggees.set("ref-root", session.debuggee);
      return { ref: { debuggee: session.debuggee }, objectId: "ref-root" };
    });
    let entered!: () => void, finish!: (value: string) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const result = new Promise<string>((resolve) => { finish = resolve; });
    vi.spyOn(runtime as any, "resolveDomOnce").mockImplementation(async () => { entered(); return result; });
    const pending = (runtime as any).resolveOnce(session, { ref: "e1", queries: [{ kind: "css", value: "span" }] });
    await waiting; controller.abort();
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "ref-root")).toBe(true);
    expect((runtime as any).objectDebuggees.has("ref-root")).toBe(false);
    finish("child"); await pending;
    await runtime.abortSessions();
  });

  it("releases a reference object when its live identity is stale or arrives after cancellation", async () => {
    const { runtime, command } = harness();
    const controller = new AbortController(); runtime.setContext({ signal: controller.signal });
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    const ref = (runtime as any).rememberRef(session, "test", { backendNodeId: 7, debuggee: session.debuggee, role: "button", name: "Different", generation: session.generation, identitySource: "ax" });
    await expect((runtime as any).resolveRef(session, ref)).rejects.toMatchObject({ code: "stale-ref" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "node-1")).toBe(true);
    const original = command.getMockImplementation()!;
    let entered!: () => void, deliver!: (value: any) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const late = new Promise<any>((resolve) => { deliver = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") { entered(); return late; }
      return original(source, method, params);
    });
    const pending = (runtime as any).resolveRef(session, ref);
    await waiting; controller.abort(); deliver({ object: { objectId: "late-ref" } });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "late-ref")).toBe(true);
    expect((runtime as any).objectDebuggees.has("late-ref")).toBe(false);
    await runtime.abortSessions();
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
    // jsdom does not implement Chrome's checkVisibility; this test concerns
    // disabled inheritance, and real paint behavior is covered by browser e2e.
    Object.defineProperty(button, "checkVisibility", { value: () => true });
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

  it("reads editable state consistently for text, readonly, disabled and unsupported controls", async () => {
    const input = document.createElement("input"), select = document.createElement("select");
    document.body.append(input, select);
    let element: HTMLElement = input, unavailable = false;
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function(condition)")) {
        if (unavailable) return { result: { value: { present: true, actual: null } } };
        const call = new Function(`return (${params.functionDeclaration})`)();
        return { result: { value: call.apply(element, params.arguments.map((argument: any) => argument.value)) } };
      }
      return original(source, method, params);
    });
    try {
      const locator = page.getByRole("button", { name: "Sign in" });
      await expect(locator.readCondition("editable")).resolves.toEqual({ present: true, actual: true });
      input.readOnly = true;
      await expect(locator.readCondition("editable")).resolves.toEqual({ present: true, actual: false });
      input.readOnly = false; input.disabled = true;
      await expect(locator.readCondition("editable")).resolves.toEqual({ present: true, actual: false });
      element = select;
      await expect(locator.readCondition("editable")).resolves.toEqual({ present: true, actual: false });
      unavailable = true;
      await expect(locator.readCondition("editable")).rejects.toMatchObject({ code: "state-unavailable" });
    } finally { input.remove(); select.remove(); await runtime.abortSessions(); }
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
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "loader" } } };
      if (method === "Performance.getMetrics") throw new Error("Metrics unavailable");
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    runtime.handleEvent({ tabId: 3 }, "Page.lifecycleEvent", { frameId: "root", loaderId: "loader", name: "init", timestamp: 100 });
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
    const { runtime, command } = harness([{ role: "button", name: "Deep target", backendId: 20_000 }]);
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

  it("inherits visibility for AX-only descendants while preserving a known visible descendant", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const nodes = [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["button"] },
      { nodeId: "button", parentId: "root", backendDOMNodeId: 7, role: { value: "button" },
        name: { value: "Label SECRET restored", sources: [{ type: "contents", value: { value: "Label SECRET restored" } }] }, childIds: ["label", "input"] },
      { nodeId: "label", parentId: "button", role: { value: "StaticText" }, name: { value: "Label " }, childIds: [] },
      { nodeId: "input", parentId: "button", backendDOMNodeId: 8, role: { value: "textbox" }, value: { value: "SECRET" }, childIds: ["internal"] },
      { nodeId: "internal", parentId: "input", role: { value: "generic" }, childIds: ["secret", "restored"] },
      { nodeId: "secret", parentId: "internal", backendDOMNodeId: 1000, role: { value: "StaticText" }, name: { value: "SECRET" }, childIds: [] },
      { nodeId: "restored", parentId: "internal", backendDOMNodeId: 9, role: { value: "StaticText" }, name: { value: "restored" }, childIds: [] },
    ];
    command.mockImplementation(async (source, method, params) => {
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOMSnapshot.captureSnapshot") return { strings: ["1", "0", "visible", "auto", "root", "BUTTON", "INPUT", "#text", "restored"], documents: [{
        frameId: 4, nodes: { backendNodeId: [7, 8, 9], parentIndex: [-1, -1, -1], nodeType: [1, 1, 3], nodeName: [5, 6, 7], nodeValue: [-1, -1, 8] },
        layout: { nodeIndex: [0, 1, 2], text: [-1, -1, 8], bounds: [[0, 0, 100, 20], [0, 0, 100, 20], [0, 0, 100, 20]], styles: [[0, 2, 2, 2, 3], [1, 2, 2, 2, 3], [0, 2, 2, 2, 3]] },
      }] };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const result = await page.inspect();
    expect(inspectText(result)).not.toContain("SECRET");
    expect(inspectText(result)).not.toContain("textbox");
    expect(inspectText(result)).toContain("button [name=unknown]");
    expect(inspectText(result)).not.toContain("Label");
    expect(inspectText(result)).toContain('StaticText "restored"');
    await runtime.abortSessions();
  });

  it.each(["textbox", "searchbox"])("emits a %s value once without exposing an unpainted name or losing its ref", async (role) => {
    const { runtime, value } = textboxSnapshot({ role });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain(`${role} [name=unknown]`);
    expect(inspectText(result)).not.toContain("Recipient");
    expect(inspectText(result).split(value)).toHaveLength(2);
    expect(inspectText(result)).not.toContain("StaticText");
    expect((result.items as any[]).find((item) => item.line.includes(role))?.ref).toBeTruthy();
    await runtime.abortSessions();
  });

  it("does not expose an unproven native value via its AX owner or UA-shadow text", async () => {
    const { runtime, command, value } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE)
        return { result: { value: { scene: null, nativeValues: [null], selectValues: [], selectStates: [] } } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain(value);
    expect(inspectText(result)).toContain("[value=unknown]");
    expect(inspectText(result)).not.toContain("StaticText");
    expect((result.items as any[]).find((item) => item.line.includes("textbox"))?.ref).toBeTruthy();
    await runtime.abortSessions();
  });

  it("records the frame and cause when a native value proof command fails", async () => {
    const logger = { telemetry: vi.fn() };
    const { runtime, command, value } = textboxSnapshot({ logger });
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE)
        throw new Error("proof command failed");
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain(value);
    expect(logger.telemetry).toHaveBeenCalledWith(expect.objectContaining({ type: "browser.snapshot.proof-failed",
      content: expect.objectContaining({ tabId: 3, frameId: "root", stage: "control-paint" }), error: expect.objectContaining({ message: "proof command failed" }) }));
    await runtime.abortSessions();
  });

  it("retains uncertainty for an independent unproven UA text value", async () => {
    const { runtime, command } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === SNAPSHOT_CONTROL_PAINT_SOURCE)
        return { result: { value: { scene: null, nativeValues: [null], selectValues: [], selectStates: [] } } };
      const result = await original(source, method, params);
      if (method !== "Accessibility.getFullAXTree") return result;
      const tree = structuredClone(result);
      tree.nodes.find((node: any) => node.nodeId === "native-value").value = { value: "independent" };
      return tree;
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain("StaticText [name=unknown] [value=unknown]");
    expect(inspectText(result)).not.toContain("independent");
    await runtime.abortSessions();
  });

  it("keeps an unknown leaf when its UA owner cannot be verified", async () => {
    const { runtime, command, value } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode" && params?.backendNodeId === 7)
        return { node: { backendNodeId: 7, nodeName: "INPUT", shadowRoots: [] } };
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain(value);
    expect(inspectText(result)).toContain("textbox [name=unknown] [value=unknown]");
    expect(inspectText(result)).toContain("StaticText [name=unknown]");
    await runtime.abortSessions();
  });

  it.each([true, false])("uses only a painted native label association for a textbox (visible=%s)", async (visible) => {
    const { runtime, command } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        const { nodes, layout } = snapshot.documents[0], add = (value: string) => snapshot.strings.push(value) - 1;
        const label = add("LABEL"), textTag = add("#text"), labelText = add("Recipient"), zero = add("0");
        nodes.backendNodeId.push(5, 6); nodes.parentIndex.push(0, 3); nodes.nodeType.push(1, 3);
        nodes.nodeName.push(label, textTag); nodes.nodeValue.push(-1, labelText);
        const labelStyle = [...layout.styles[1]];
        if (!visible) labelStyle[0] = zero;
        layout.nodeIndex.push(3, 4); layout.bounds.push([0, 25, 100, 20], [0, 25, 100, 20]);
        layout.styles.push(labelStyle, [...layout.styles[1]]); layout.text.push(-1, labelText);
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") {
        const tree = structuredClone(await original(source, method, params));
        tree.nodes[0].childIds.unshift("label");
        tree.nodes[1].name = { value: "Recipient", sources: [{ type: "relatedElement", value: { value: "Recipient" },
          nativeSource: "labelfor", nativeSourceValue: { relatedNodes: [{ backendDOMNodeId: 5, text: "Recipient" }] } }] };
        tree.nodes.push({ nodeId: "label", parentId: "root", backendDOMNodeId: 5, role: { value: "LabelText" }, childIds: ["label-text"] },
          { nodeId: "label-text", parentId: "label", backendDOMNodeId: 6, role: { value: "StaticText" }, name: { value: "Recipient" }, childIds: [] });
        return tree;
      }
      if (method === "Accessibility.getPartialAXTree" && params?.backendNodeId === 7)
        return { nodes: [{ backendDOMNodeId: 7, role: { value: "textbox" }, name: { value: "Recipient" } }] };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3), result = await page.inspect() as any;
    const textbox = result.items.find((item: any) => item.line.includes("textbox"));
    expect(textbox.ref).toBeTruthy();
    if (visible) expect(textbox.line).toContain('textbox "Recipient"');
    else expect(inspectText(result)).not.toContain("Recipient");
    await expect(page.ref(textbox.ref).count()).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it.each([
    { label: "plain UA value" },
    { label: "semantic text", property: "live" },
    { label: "actionable text", action: true },
    { label: "independent sibling", sibling: true },
    { label: "named wrapper", wrapperName: "Independent" },
  ])("keeps unproven native shadow text out of the visible value: $label", async ({ property, action, sibling, wrapperName }) => {
    const { runtime, command, value } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    const editable = { name: "editable", value: { value: "plaintext" } };
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = structuredClone(await original(source, method, params));
        const { nodes, layout } = snapshot.documents[0];
        for (const key of ["backendNodeId", "parentIndex", "nodeType", "nodeName", "nodeValue"]) nodes[key].pop();
        for (const key of ["nodeIndex", "bounds", "styles", "text"]) layout[key].pop();
        return snapshot;
      }
      return method !== "Accessibility.getFullAXTree" ? original(source, method, params) : { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["box"] },
      { nodeId: "box", parentId: "root", backendDOMNodeId: 7, role: { value: "textbox" }, name: { value: "Recipient" }, value: { value }, childIds: ["wrapper"] },
      { nodeId: "wrapper", parentId: "box", backendDOMNodeId: 9, role: { value: "generic" }, name: { value: wrapperName ?? "" }, properties: [editable], childIds: sibling ? ["text", "extra"] : ["text"] },
      { nodeId: "text", parentId: "wrapper", backendDOMNodeId: 10, role: { value: "StaticText" }, name: { value }, childIds: [],
        properties: property ? [editable, { name: property, value: { value: "polite" } }] : [editable], ...(action ? { actions: ["doDefault"] } : {}) },
      ...(sibling ? [{ nodeId: "extra", parentId: "wrapper", backendDOMNodeId: 11, role: { value: "StaticText" }, name: { value }, childIds: [], properties: [editable] }] : []),
      ] };
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result).split(value)).toHaveLength(2);
    expect(inspectText(result)).not.toContain("Recipient");
    expect((result.items as any[]).find((item) => item.line.includes("textbox"))?.ref).toBeTruthy();
    const unknownText = (result.items as any[]).filter((item) => item.line.includes("StaticText [name=unknown]"));
    if (property || action || sibling || wrapperName) expect(unknownText.length).toBeGreaterThan(0);
    else expect(unknownText).toHaveLength(0);
    await runtime.abortSessions();
  });

  it.each([
    { text: "Different" },
    { properties: [{ name: "live", value: { value: "polite" } }] },
    { actions: ["doDefault"] },
    { sibling: true },
    { value: "••••", text: "••••", masked: true },
  ])("preserves input text with independent content or semantics: %o", async (options) => {
    const { runtime, text } = textboxSnapshot({ ...options, independent: true });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain(`StaticText "${text}"`);
    if (options.masked) expect(inspectText(result)).toContain("masked=true");
    await runtime.abortSessions();
  });

  it("retains a selected static text region and fragments long input values correctly", async () => {
    const value = `Start ${"long😀".repeat(100)} end`;
    const { runtime } = textboxSnapshot({ value, independent: true });
    const page = await runtime.createPage(3);
    const region = await page.inspect({}, page.locator("#leaf"));
    expect(inspectText(region)).toContain(`StaticText "${value}"`);
    const first: any = await page.inspect({ budget: 240, limit: 1 });
    const items = [...first.items];
    let cursor = first.nextCursor, pages = 1;
    while (cursor) {
      const next: any = await page.inspect({ cursor, budget: 240, limit: 1 });
      items.push(...next.items);
      cursor = next.nextCursor;
      expect(++pages).toBeLessThan(100);
      if (!cursor) expect(next.truncation.baselineComplete).toBe(true);
    }
    expect(pages).toBeGreaterThan(2);
    const reconstructed = items.map((item: any) => item.line).join("");
    expect(reconstructed).toContain(value);
    expect(reconstructed).toContain("StaticText");
    // The independently painted text remains fully pageable. The long native
    // input has no full-paint proof in this fixture and must not be duplicated.
    expect(reconstructed.split(value)).toHaveLength(2);
    expect(reconstructed).toContain("[value=unknown]");
    await runtime.abortSessions();
  });

  it("rejects a scoped baseline if the same locator resolves to a different node", async () => {
    const { runtime, command } = textboxSnapshot();
    const original = command.getMockImplementation()!;
    let backendNodeId = 8;
    command.mockImplementation(async (source, method, params) => method === "DOM.describeNode"
      ? { node: { backendNodeId } } : original(source, method, params));
    const page = await runtime.createPage(3), region = page.locator("#leaf");
    const first = await page.inspect({}, region);
    backendNodeId = 7;
    await expect(page.inspect({ since: first.observationId as string }, region)).rejects.toMatchObject({ code: "stale-observation", detail: { reason: "region-identity-changed" } });
    await runtime.abortSessions();
  });

  it("invalidates frozen snapshot cursors when frame handles become stale", async () => {
    const { runtime } = textboxSnapshot({ value: "long".repeat(200) });
    const page = await runtime.createPage(3);
    const first = await page.inspect({ budget: 240, limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    runtime.handleEvent({ tabId: 3 }, "Page.frameAttached", { frameId: "new-frame", parentFrameId: "root" });
    await expect(page.inspect({ cursor: first.nextCursor as string })).rejects.toMatchObject({ code: "stale-observation" });
    await runtime.abortSessions();
  });

  it("uses DOM region membership and order when aria-owns reparents AX nodes in both directions", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    const strings = ["root", "#document", "SECTION", "H2", "BUTTON", "DIV", "1", "visible", "auto", "#text", "Inside", "Action", "Outside", "static", "none", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "border-box", "clip", "normal"];
    const style = [6, 7, 7, 7, 7, 13, 14, 14, 14, 14, 8, 14, 14, 14, 14, 14, 8, 15, 16, 17, 18, 19, 14, 20, 21, 14, 14, 22, 14, 14, 14, 14, 23, 14];
    const snapshot = { strings, documents: [{ frameId: 0,
      nodes: { backendNodeId: [1, 7, 8, 9, 10, 11, 101, 102, 103], parentIndex: [-1, 0, 1, 1, 0, 0, 2, 3, 4], nodeType: [9, 1, 1, 1, 1, 1, 3, 3, 3], nodeName: [1, 2, 3, 4, 3, 5, 9, 9, 9], nodeValue: [-1, -1, -1, -1, -1, -1, 10, 11, 12] },
      layout: { nodeIndex: [0, 1, 2, 3, 4, 5, 6, 7, 8], bounds: Array.from({ length: 9 }, () => [0, 0, 100, 20]), styles: [[], ...Array.from({ length: 8 }, () => style)], text: [-1, -1, -1, -1, -1, -1, 10, 11, 12] },
    }] };
    const nodes = [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["region", "owner"] },
      { nodeId: "region", parentId: "root", backendDOMNodeId: 7, role: { value: "region" }, name: { value: "Outside Action", sources: [{ type: "contents", value: { value: "Outside Action" } }] }, childIds: ["outside", "button"] },
      { nodeId: "outside", parentId: "region", backendDOMNodeId: 10, role: { value: "heading" }, name: { value: "Outside" }, childIds: [] },
      { nodeId: "button", parentId: "region", backendDOMNodeId: 9, role: { value: "button" }, name: { value: "Action", sources: [{ type: "attribute", value: { value: "Action" } }] }, childIds: [] },
      { nodeId: "owner", parentId: "root", backendDOMNodeId: 11, role: { value: "group" }, childIds: ["inside"] },
      { nodeId: "inside", parentId: "owner", backendDOMNodeId: 8, role: { value: "heading" }, name: { value: "Inside" }, childIds: [] },
    ];
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const result = await page.inspect({}, page.locator("#region"));
    const text = inspectText(result);
    expect(text).not.toContain("Outside");
    expect(text).toContain('heading "Inside"');
    expect(text).toContain('button "Action"');
    expect(text.indexOf('heading "Inside"')).toBeLessThan(text.indexOf('button "Action"'));
    expect((result.items as any[]).find((item) => item.line.includes('button "Action"'))?.ref).toBeTruthy();
    const paged: any = await page.inspect({ budget: 240, limit: 1 }, page.locator("#region"));
    const parts = [...paged.items];
    let cursor = paged.nextCursor;
    while (cursor) {
      const next: any = await page.inspect({ cursor, budget: 240, limit: 1 });
      parts.push(...next.items); cursor = next.nextCursor;
    }
    const reconstructed = new Map<string, string>();
    for (const item of parts) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + item.line);
    expect([...reconstructed.values()]).toEqual((result.items as any[]).map((item) => item.line));
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "node-1")).toBe(true);
    await runtime.abortSessions();
  });

  it("does not claim a complete region when an AX semantic node has unknown DOM membership", async () => {
    const { runtime, command } = textboxSnapshot(), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method !== "Accessibility.getFullAXTree") return original(source, method, params);
      const response = await original(source, method, params);
      response.nodes[0].childIds.push("unknown");
      response.nodes.push({ nodeId: "unknown", parentId: "root", backendDOMNodeId: 999, role: { value: "heading" }, name: { value: "unknown" }, childIds: [] });
      return response;
    });
    const page = await runtime.createPage(3);
    await expect(page.inspect({}, page.locator("#leaf"))).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "unknown-region-membership" } });
    await runtime.abortSessions();
  });

  it.each([
    { status: "visible", visible: true },
    { status: "hidden", visible: false },
    { status: "unknown", visible: false },
  ])("projects a $status placeholder instead of exposing the unverified AX name", async ({ status, visible }) => {
    const { runtime, command, reads } = placeholderSnapshot({ status: [status] });
    const result = await (await runtime.createPage(3)).inspect();
    const text = inspectText(result);
    expect(text.includes("PRIVATE_HINT")).toBe(visible);
    expect(text.includes("[placeholder=unknown]")).toBe(status === "unknown");
    expect((result.items as any[]).find((item) => item.line.includes("textbox"))?.ref).toBeTruthy();
    expect(reads()).toBe(2);
    expect(command.mock.calls.filter(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-placeholder:"))).toHaveLength(2);
    await runtime.abortSessions();
  });

  it("keeps a visible placeholder without exposing an unpainted ARIA name", async () => {
    const { runtime } = placeholderSnapshot({ label: true });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain("textbox [name=unknown]");
    expect(inspectText(result)).not.toContain("Label");
    expect(inspectText(result)).toContain('[placeholder="PRIVATE_HINT"]');
    await runtime.abortSessions();
  });

  it("does not expose an unpainted ARIA name when its placeholder is hidden", async () => {
    const { runtime } = placeholderSnapshot({ label: true, status: ["hidden"] });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain("textbox [name=unknown]");
    expect(inspectText(result)).not.toContain("Label");
    expect(inspectText(result)).not.toContain("PRIVATE_HINT");
    await runtime.abortSessions();
  });

  it("emits a filled value without emitting its nonpainted AX placeholder name", async () => {
    const { runtime } = placeholderSnapshot({ status: ["hidden"], value: "typed" });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain("typed");
    expect(inspectText(result)).not.toContain("PRIVATE_HINT");
    await runtime.abortSessions();
  });

  it("does not leak a hidden placeholder through an AX text child", async () => {
    const { runtime, command } = placeholderSnapshot({ status: ["hidden"] }), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method !== "Accessibility.getFullAXTree") return original(source, method, params);
      const result = await original(source, method, params);
      result.nodes[1].childIds = ["placeholder-text"];
      result.nodes.push({ nodeId: "placeholder-text", parentId: "input", backendDOMNodeId: 8, role: { value: "StaticText" }, name: { value: "PRIVATE_HINT" }, childIds: [] });
      return result;
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain("PRIVATE_HINT");
    await runtime.abortSessions();
  });

  it("marks unidentified AX text below a hidden placeholder unknown while retaining a represented input value", async () => {
    for (const value of ["", "typed"]) {
      const { runtime, command } = placeholderSnapshot({ status: ["hidden"], value }), original = command.getMockImplementation()!;
      command.mockImplementation(async (source, method, params) => {
        if (method !== "Accessibility.getFullAXTree") return original(source, method, params);
        const result = await original(source, method, params);
        result.nodes[1].childIds = ["unidentified"];
        result.nodes.push({ nodeId: "unidentified", parentId: "input", role: { value: "StaticText" }, name: { value: value || "PRIVATE_HINT" }, childIds: [] });
        return result;
      });
      const result = await (await runtime.createPage(3)).inspect();
      const text = inspectText(result);
      expect(text).not.toContain("PRIVATE_HINT");
      if (value) expect(text).toContain(": typed");
      expect(text).toContain("StaticText [name=unknown]");
      await runtime.abortSessions();
    }
  });

  it.each(["detached", "context", "context-entry"])("bounds repeated placeholder %s failures", async (mode) => {
    const { runtime, command } = placeholderSnapshot(), original = command.getMockImplementation()!;
    let attempts = 0;
    command.mockImplementation(async (source, method, params) => {
      if (mode === "detached" && method === "DOM.resolveNode" && params?.backendNodeId === 8 && params?.objectGroup?.startsWith("surf-wax-placeholder:")) {
        attempts++; throw new Error("Node not found");
      }
      if (mode === "context" && method === "Runtime.callFunctionOn" && params?.functionDeclaration === PLACEHOLDER_EVIDENCE_SOURCE) {
        attempts++; runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextDestroyed", { executionContextId: 31 });
      }
      if (mode === "context-entry" && method === "Page.createIsolatedWorld") {
        attempts++; runtime.handleEvent({ tabId: 3 }, "Runtime.executionContextDestroyed", { executionContextId: 31 });
      }
      return original(source, method, params);
    });
    await expect((await runtime.createPage(3)).inspect()).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "placeholder-context-unstable" } });
    expect(attempts).toBe(2);
    await runtime.abortSessions();
  });

  it("marks transitive AX names unknown when they depend on a hidden placeholder", async () => {
    const { runtime } = placeholderSnapshot({ status: ["hidden"], dependency: true, transitive: true });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain("PRIVATE_HINT");
    expect((result.items as any[]).filter((item) => item.line.includes("button [name=unknown]"))).toHaveLength(2);
    await runtime.abortSessions();
  });

  it("retries a placeholder whose paint evidence changes during capture", async () => {
    const { runtime, reads } = placeholderSnapshot({ status: ["visible", "hidden", "hidden", "hidden"] });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).not.toContain("PRIVATE_HINT");
    expect(reads()).toBe(4);
    await runtime.abortSessions();
  });

  it("cancels immediately but releases a placeholder group only after a late probe settles", async () => {
    const { runtime, command } = placeholderSnapshot(), original = command.getMockImplementation()!;
    const controller = new AbortController(); runtime.setContext({ signal: controller.signal });
    let entered!: () => void, deliver!: (value: any) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }), late = new Promise<any>((resolve) => { deliver = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === PLACEHOLDER_EVIDENCE_SOURCE) { entered(); return late; }
      return original(source, method, params);
    });
    const pending = (await runtime.createPage(3)).inspect();
    await waiting; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-placeholder:"))).toBe(false);
    deliver({ result: { value: { status: "hidden" } } });
    await vi.waitFor(() => expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObjectGroup" && params?.objectGroup?.startsWith("surf-wax-placeholder:"))).toBe(true));
    await runtime.abortSessions();
  });

  it("paginates a large scoped accessibility tree without expanding a large argument list", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    const count = 12_000, strings = ["root", "#document", "SECTION", "SPAN", "1", "visible", "auto"];
    const ids = Array.from({ length: count }, (_, index) => index + 10);
    const snapshot = { strings, documents: [{ frameId: 0,
      nodes: { backendNodeId: [1, 7, ...ids], parentIndex: [-1, 0, ...ids.map(() => 1)], nodeType: [9, 1, ...ids.map(() => 1)], nodeName: [1, 2, ...ids.map(() => 3)] },
      layout: { nodeIndex: Array.from({ length: count + 2 }, (_, index) => index), bounds: Array.from({ length: count + 2 }, () => [0, 0, 10, 10]), styles: [[], ...Array.from({ length: count + 1 }, () => [4, 5, 5, 5, 6])] },
    }] };
    const nodes = [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["region"] },
      { nodeId: "region", parentId: "root", backendDOMNodeId: 7, role: { value: "region" }, name: { value: "Large" }, childIds: ids.map(String) },
      ...ids.map((id) => ({ nodeId: String(id), parentId: "region", backendDOMNodeId: id, role: { value: "heading" }, name: { value: `Heading ${id}` }, childIds: [] })),
    ];
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const result = await page.inspect({ budget: 240 }, page.locator("#large"));
    expect(result).toMatchObject({ mode: "full", truncation: { truncated: true, total: count + 1 } });
    expect(result.nextCursor).toEqual(expect.any(String));
    await runtime.abortSessions();
  });

  it("releases a resolved region object when describing it is aborted", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    let entered!: () => void;
    const describing = new Promise<void>((resolve) => { entered = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.describeNode") { entered(); return new Promise(() => {}); }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3), pending = page.inspect({}, page.locator("#region"));
    await describing; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "node-1")).toBe(true);
    await runtime.abortSessions();
  });

  it("releases a late DOM locator result after the region capture is aborted", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    const controller = new AbortController(); runtime.setContext({ signal: controller.signal });
    let entered!: () => void, deliver!: (value: any) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const response = new Promise<any>((resolve) => { deliver = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params?.objectId === "node-array" && params.functionDeclaration === "function(){return this[0]}") { entered(); return response; }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3), pending = page.inspect({}, page.locator("#region"));
    await waiting; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    deliver({ result: { objectId: "late-node" } });
    await vi.waitFor(() => expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "late-node")).toBe(true));
    expect((runtime as any).objectDebuggees.has("late-node")).toBe(false);
    await runtime.abortSessions();
  });

  it("releases semantic locator document when its initial description fails", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "semantic-document" } };
      if (method === "DOM.describeNode" && params?.objectId === "semantic-document") throw new Error("describe failed");
      return original(source, method, params);
    });
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    await expect((runtime as any).resolveSemantic(session, session.debuggee, { queries: [] })).rejects.toThrow("describe failed");
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "semantic-document")).toBe(true);
    await runtime.abortSessions();
  });

  it("releases all retained semantic matches when uniqueness fails", async () => {
    const { runtime, command } = harness(); await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3), spec = { queries: [{ kind: "role", value: "button" }] };
    vi.spyOn(runtime as any, "locatorScope").mockResolvedValue({ debuggee: session.debuggee, spec, rootIsElement: true, dispose: () => {} });
    vi.spyOn(runtime as any, "resolveSemantic").mockResolvedValue([{ objectId: "semantic-one", backendNodeId: 7 }, { objectId: "semantic-two", backendNodeId: 8 }]);
    for (const id of ["semantic-one", "semantic-two"]) (runtime as any).objectDebuggees.set(id, session.debuggee);
    await expect((runtime as any).resolveOnce(session, spec)).rejects.toMatchObject({ code: "strict-mode" });
    for (const id of ["semantic-one", "semantic-two"]) {
      expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === id)).toBe(true);
      expect((runtime as any).objectDebuggees.has(id)).toBe(false);
    }
    await runtime.abortSessions();
  });

  it("releases semantic handles that arrive after a concurrent resolution fails", async () => {
    const { runtime, command } = harness(), original = command.getMockImplementation()!;
    let deliver!: (value: any) => void;
    const late = new Promise<any>((resolve) => { deliver = resolve; });
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params?.expression === "document") return { result: { objectId: "semantic-document" } };
      if (method === "DOM.describeNode" && params?.objectId === "semantic-document") return { node: { backendNodeId: 1 } };
      if (method === "DOM.resolveNode" && params?.backendNodeId === 7) throw new Error("first failed");
      if (method === "DOM.resolveNode" && params?.backendNodeId === 8) return late;
      return original(source, method, params);
    });
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    vi.spyOn(runtime as any, "resolveAccessibility").mockResolvedValue([{ backendNodeId: 7 }, { backendNodeId: 8 }]);
    const pending = (runtime as any).resolveSemantic(session, session.debuggee, { queries: [{ kind: "role", value: "button" }] });
    const rejected = expect(pending).rejects.toThrow("first failed");
    deliver({ object: { objectId: "late-semantic" } });
    await rejected;
    expect(command.mock.calls.some(([, method, params]) => method === "Runtime.releaseObject" && params?.objectId === "late-semantic")).toBe(true);
    expect((runtime as any).objectDebuggees.has("late-semantic")).toBe(false);
    await runtime.abortSessions();
  });

  it("uses painted descendants instead of explicit descendant aliases when filtering a name", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const named = (value: string, type = "contents") => ({ value, sources: [{ type, value: { value } }] });
    const originalName = "Begin HIDDEN Known alias 35 Selected choice Selected end";
    const nodes = [
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["button"] },
      { nodeId: "button", parentId: "root", backendDOMNodeId: 7, role: { value: "button" }, name: named(originalName), childIds: ["start", "secret", "alias", "range", "select", "list", "end"] },
      { nodeId: "start", parentId: "button", backendDOMNodeId: 10, role: { value: "StaticText" }, name: named("Begin ") },
      { nodeId: "secret", parentId: "button", backendDOMNodeId: 8, role: { value: "StaticText" }, name: named("HIDDEN") },
      { nodeId: "alias", parentId: "button", role: { value: "generic" }, name: named("Known alias", "attribute"), childIds: ["alias-text"] },
      { nodeId: "alias-text", parentId: "alias", backendDOMNodeId: 11, role: { value: "StaticText" }, name: named("Original text") },
      { nodeId: "range", parentId: "button", role: { value: "slider" }, name: named("Size", "attribute"), value: { value: 35 } },
      { nodeId: "select", parentId: "button", backendDOMNodeId: 9, role: { value: "combobox" }, value: { value: "Selected choice" }, childIds: ["unselected"] },
      { nodeId: "unselected", parentId: "select", role: { value: "StaticText" }, name: named("Unselected choice") },
      { nodeId: "list", parentId: "button", role: { value: "listbox" }, childIds: ["selected", "other"] },
      { nodeId: "selected", parentId: "list", role: { value: "option" }, properties: [{ name: "selected", value: { value: true } }], childIds: ["selected-text"] },
      { nodeId: "selected-text", parentId: "selected", role: { value: "StaticText" }, name: named("Selected") },
      { nodeId: "other", parentId: "list", role: { value: "option" }, properties: [{ name: "selected", value: { value: false } }], childIds: ["other-text"] },
      { nodeId: "other-text", parentId: "other", role: { value: "StaticText" }, name: named("Other") },
      { nodeId: "end", parentId: "button", backendDOMNodeId: 12, role: { value: "StaticText" }, name: named(" end") },
    ];
    const strings = ["1", "0", "visible", "auto", "root", "BUTTON", "#text", "HIDDEN", "SELECT", "none", "Begin ", "Original text", " end", "static", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "border-box", "clip", "normal"];
    const style = [0, 2, 2, 2, 2, 13, 9, 9, 9, 9, 3, 9, 9, 9, 9, 9, 3, 14, 15, 16, 17, 18, 9, 19, 20, 9, 9, 21, 9, 9, 9, 9, 22, 9];
    command.mockImplementation(async (source, method, params) => {
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOMSnapshot.captureSnapshot") return { strings, documents: [{
        frameId: 4, nodes: { backendNodeId: [7, 8, 9, 10, 11, 12], parentIndex: [-1, 0, 0, 0, 0, 0], nodeType: [1, 3, 1, 3, 3, 3], nodeName: [5, 6, 8, 6, 6, 6], nodeValue: [-1, 7, -1, 10, 11, 12] },
        layout: { nodeIndex: [0, 1, 2, 3, 4, 5], text: [-1, 7, -1, 10, 11, 12], bounds: Array.from({ length: 6 }, () => [0, 0, 100, 20]), styles: [style, [1, ...style.slice(1)], style, style, style, style] },
      }] };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const result = await page.inspect() as any;
    const button = result.items.find((item: any) => item.line.includes("- button "));
    expect(button.line).toContain('button "Begin Original text end"');
    expect(button.line).not.toContain("HIDDEN");
    expect(button.line).not.toContain("Known alias");
    expect(button.line).not.toContain("Unselected choice");
    expect(button.line).not.toContain("Other");
    expect((runtime as any).sessions.get(3).refs.get(button.ref).name).toBe(originalName);
    await runtime.abortSessions();
  });

  it("discards the old AX text if the same DOM node changes during capture", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    let captures = 0, axCaptures = 0;
    const snapshot = (value: "A" | "B") => {
      const strings = ["root", "#document", "#text", "A", "B", "1", "visible", "auto", "static", "none", "16px", "rgb(0, 0, 0)", "ltr", "horizontal-tb", "block", "0px", "border-box", "clip"];
      const style = [5,6,6,6,6,8,9,9,9,9,7,9,9,9,9,9,7,12,13,14,10,11,9,15,16,9,9,17,9,9,9].map(Number);
      const text = value === "A" ? 3 : 4;
      return { strings, documents: [{ frameId: 0, nodes: { backendNodeId: [1, 7], parentIndex: [-1, 0], nodeType: [9, 3], nodeName: [1, 2], nodeValue: [-1, text] },
        layout: { nodeIndex: [0, 1], text: [-1, text], bounds: [[0, 0, 100, 100], [0, 0, 30, 20]], styles: [[], style] } }] };
    };
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOMSnapshot.captureSnapshot") return snapshot(++captures === 1 ? "A" : "B");
      if (method === "Accessibility.getFullAXTree") {
        const value = ++axCaptures === 1 ? "A" : "B";
        return { nodes: [{ nodeId: "root", role: { value: "RootWebArea" }, childIds: ["text"] },
          { nodeId: "text", parentId: "root", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value } }] };
      }
      return original(source, method, params);
    });
    const result = await (await runtime.createPage(3)).inspect();
    expect(inspectText(result)).toContain('StaticText "B"');
    expect(inspectText(result)).not.toContain('StaticText "A"');
    expect(axCaptures).toBe(2);
    expect(captures).toBe(4);
    await runtime.abortSessions();
  });

  it("inspects text by default, qualifies references, and returns changes without repeating the full snapshot", async () => {
    const metadata = [{ role: "button", name: "Save", tag: "button", text: "Save" }];
    const { runtime, calls } = harness(metadata); const page = await runtime.createPage(3);
    const first = await page.inspect();
    expect(first).toMatchObject({ mode: "full", tabId: 3, documentId: 0, truncation: { baselineComplete: true } });
    const ref = (first.items as any[]).find((item) => item.line.includes('button "Save"'))?.ref;
    expect(ref).toMatch(/^t3s[a-f0-9]+d0e1$/); expect(first).not.toHaveProperty("screenshot");
    metadata[0]!.name = "Continue"; metadata[0]!.text = "Continue";
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

  it("rejects all observations from an earlier debugger session even when the tab and document generation are reused", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    const old = await page.inspect() as any;
    const visual = await runtime.observe(3, "visual") as any;
    runtime.handleDetach({ tabId: 3 });
    const replacement = await runtime.createPage(3);
    const fresh = await replacement.inspect() as any;
    expect(old.documentId).toBe(fresh.documentId);
    await expect(replacement.inspect({ since: old.observationId })).rejects.toMatchObject({ code: "stale-observation" });
    await expect(runtime.observe(3, "semantic", visual.observationId)).rejects.toMatchObject({ code: "stale-observation" });
    await expect(runtime.ensureObservation(3, visual.observationId)).rejects.toMatchObject({ code: "stale-observation" });
    const before = calls.filter(({ method }) => method === "Input.dispatchMouseEvent").length;
    await expect(runtime.point(3, visual.observationId, 1, 1, "click")).rejects.toMatchObject({ code: "stale-observation" });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(before);
    await runtime.abortSessions();
  });

  it("uses short stable semantic item IDs while retaining long frame IDs outside item identity", async () => {
    const { runtime, command } = harness([{ role: "button", name: "Save" }]);
    const original = command.getMockImplementation()!;
    const frameId = "FRAME-12345678901234567890123456789012";
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: frameId } } };
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = await original(source, method, params);
        snapshot.strings[0] = frameId;
        return snapshot;
      }
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    const first = await page.inspect() as any;
    const second = await page.inspect({ since: first.observationId }) as any;
    expect(first.items.map((item: any) => item.id)).toEqual(["1.aroot", "1.anode-0"]);
    expect(second).toMatchObject({ mode: "delta", items: [] });
    const ref = first.items.find((item: any) => item.ref)?.ref;
    expect(ref).toMatch(/^t3s[a-f0-9]+d0e1$/);
    await expect(page.ref(ref).count()).resolves.toBe(1);
    await runtime.abortSessions();
  });

  it("preserves compact item IDs and predecessor links across delta pages", async () => {
    const metadata = [{ role: "button", name: "First" }, { role: "button", name: "Second" }];
    const { runtime } = harness(metadata);
    const page = await runtime.createPage(3);
    const baseline = await page.inspect() as any;
    const first = baseline.items.find((item: any) => item.line.includes('button "First"'));
    const second = baseline.items.find((item: any) => item.line.includes('button "Second"'));
    metadata[1]!.name = "Second updated";
    metadata.push({ role: "button", name: "Third" });
    const one = await page.inspect({ since: baseline.observationId, limit: 1 }) as any;
    expect(one).toMatchObject({ mode: "delta", items: [{ id: second.id, change: "updated", after: first.id }], nextCursor: expect.any(String) });
    const two = await page.inspect({ cursor: one.nextCursor, limit: 1 }) as any;
    expect(two).toMatchObject({ mode: "delta", items: [{ id: "1.anode-2", change: "added", after: second.id }] });
    expect(two.nextCursor).toBeUndefined();
    await runtime.abortSessions();
  });

  it("keeps AX row identities distinct when two semantic nodes share a backend node", async () => {
    const { runtime, command } = harness([{ role: "button", name: "Same", text: "Same" }]);
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

  it("omits role-derived action hints by default but allows explicit hints and compatible deltas", async () => {
    const { runtime } = harness([{ role: "button", name: "Save", tag: "button" }]);
    const page = await runtime.createPage(3);
    const first = await page.inspect() as any;
    expect(first.items.find((item: any) => item.line.includes('button "Save"'))).toMatchObject({ ref: expect.any(String) });
    expect(inspectText(first)).not.toContain("[actions=");
    const delta = await page.inspect({ since: first.observationId, fields: ["text", "state", "ref"] }) as any;
    expect(delta).toMatchObject({ mode: "delta", items: [] });
    await expect(page.inspect({ since: first.observationId, fields: ["text", "state", "ref", "actions"] })).rejects.toMatchObject({ code: "stale-observation" });
    const explicit = await page.inspect({ fields: ["text", "state", "ref", "actions"] }) as any;
    expect(inspectText(explicit)).toContain("[actions=click,double_click,hover]");
    await runtime.abortSessions();
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
    expect(delta).toMatchObject({ mode: "delta", items: expect.arrayContaining([expect.objectContaining({ change: "updated", line: expect.stringContaining("Changed after the initial snapshot") })]) });
    expect(delta.items.every((item: any) => item.change === "updated" || item.change === "removed")).toBe(true);
    await runtime.abortSessions();
  });

  it("fits each frozen inspection page into the model envelope before advancing the cursor", async () => {
    const metadata = Array.from({ length: 24 }, (_, index) => ({ role: "button", name: `row-${index}-${'海😀"'.repeat(120)}`, tag: "button" }));
    const { runtime } = harness(metadata);
    const page = await runtime.createPage(3);
    const expected = await page.inspect({ budget: 100_000 }) as any;
    const wire = { maxBytes: 1700, evidenceId: 'call-"🌊' };
    let current = await page.inspect({ budget: 30_000, wire }) as any;
    const observationId = current.observationId, rebuilt = new Map<string, string>();
    let pages = 0;
    for (;;) {
      expect(new TextEncoder().encode(JSON.stringify({ ...current, evidenceId: wire.evidenceId })).byteLength).toBeLessThanOrEqual(wire.maxBytes);
      expect(current.truncation.budget).toBeLessThanOrEqual(30_000);
      for (const item of current.items) rebuilt.set(item.id, (rebuilt.get(item.id) ?? "") + item.line);
      deliver(current);
      pages++;
      if (!current.nextCursor) break;
      if (pages === 1) await expect(page.inspect({ cursor: current.nextCursor, budget: 30_000, wire: { ...wire, evidenceId: "x".repeat(3000) } })).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "wire-budget-insufficient" } });
      current = await page.inspect({ cursor: current.nextCursor, budget: 30_000, wire }) as any;
      expect(current.observationId).toBe(observationId);
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
    expect([...rebuilt]).toEqual(expected.items.map((item: any) => [item.id, item.line]));
    expect(current.truncation.baselineComplete).toBe(true);
    expect(await page.inspect({ since: observationId })).toMatchObject({ mode: "delta", items: [] });
    await runtime.abortSessions();
  });

  it("continues a frozen refresh with oversized metadata without repeating or losing it", async () => {
    const metadata = Array.from({ length: 8 }, (_, index) => ({ role: "button", name: `row-${index}-${"海😀".repeat(90)}`, tag: "button" }));
    const { runtime, command, calls } = harness(metadata);
    const original = command.getMockImplementation()!;
    const title = "标题🌊".repeat(5000), url = `https://example.test/${"x".repeat(20_000)}`;
    command.mockImplementation(async (debuggee, method, params) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("({url:")) return { result: { value: { url, title } } };
      return original(debuggee, method, params);
    });
    const page = await runtime.createPage(3);
    const first = await page.inspect({ budget: 700, deferDelivery: true }) as any;
    expect(first).toMatchObject({ url, title, nextCursor: expect.any(String) });
    deliver(first);
    const wire = { maxBytes: 16_384, evidenceId: "call" };
    const retry = await page.inspect({ cursor: `${first.observationId}:0:0`, budget: 700, wire }) as any;
    expect(retry).toMatchObject({ continuation: true, observationId: first.observationId });
    expect(retry).not.toHaveProperty("url");
    expect(retry).not.toHaveProperty("title");
    deliver(retry);
    const reconstructed = new Map<string, string>();
    for (const item of first.items) reconstructed.set(item.id, item.line);
    let cursor = first.nextCursor, last: any, pages = 0;
    do {
      last = await page.inspect({ cursor, budget: 700, wire }) as any;
      expect(last).toMatchObject({ continuation: true, observationId: first.observationId });
      expect(last).not.toHaveProperty("url");
      expect(last).not.toHaveProperty("title");
      expect(new TextEncoder().encode(JSON.stringify({ ...last, evidenceId: wire.evidenceId })).byteLength).toBeLessThanOrEqual(wire.maxBytes);
      for (const item of last.items) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + item.line);
      deliver(last);
      cursor = last.nextCursor;
      expect(++pages).toBeLessThan(50);
    } while (cursor);
    expect(last.truncation.baselineComplete).toBe(true);
    expect([...reconstructed.values()].join("\n")).toContain("row-7-");
    expect(calls.filter(({ method }) => method === "Accessibility.getFullAXTree")).toHaveLength(1);
    await expect(page.inspect({ since: first.observationId, wire })).rejects.toMatchObject({ code: "snapshot-unavailable", detail: { reason: "wire-budget-insufficient" } });
    expect(await page.inspect({ since: first.observationId })).toMatchObject({ mode: "delta", url, title, items: [] });
    await runtime.abortSessions();
  });

  it("commits a wire baseline only after delivery, with an idempotent non-serialized callback", async () => {
    const { runtime } = harness([{ role: "button", name: "One", tag: "button" }]);
    const page = await runtime.createPage(3);
    const prepared = await page.inspect({ wire: { maxBytes: 5000, evidenceId: "call" } }) as any;
    expect(prepared.truncation.baselineComplete).toBe(true);
    expect(Object.getOwnPropertyDescriptor(prepared, SNAPSHOT_DELIVERY_COMMIT)?.enumerable).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain("snapshot-delivery-commit");
    expect(await page.inspect({ since: prepared.observationId })).toMatchObject({ mode: "full", reset: "previous-output-truncated" });
    const lease = prepared[SNAPSHOT_DELIVERY_COMMIT];
    expect(lease.begin()).toBe(true);
    expect(lease.begin()).toBe(true);
    lease.finish(); lease.finish();
    expect(await page.inspect({ since: prepared.observationId })).toMatchObject({ mode: "delta", items: [] });
    await runtime.abortSessions();
  });

  it("rejects out-of-order or stale prepared pages without advancing the frozen baseline", async () => {
    const { runtime } = harness(Array.from({ length: 6 }, (_, index) => ({ role: "button", name: `Row ${index}`, tag: "button" })));
    const page = await runtime.createPage(3), wire = { maxBytes: 5000, evidenceId: "call" };
    const first = await page.inspect({ limit: 1, wire }) as any;
    const tooEarly = await page.inspect({ cursor: first.nextCursor, limit: 1, wire }) as any;
    deliver(tooEarly);
    expect(await page.inspect({ since: first.observationId })).toMatchObject({ mode: "full", reset: "previous-output-truncated" });
    deliver(first);
    const retry = await page.inspect({ cursor: first.nextCursor, limit: 1, wire }) as any;
    deliver(retry);
    const stale = await page.inspect({ cursor: retry.nextCursor, limit: 1, wire }) as any;
    const session = (runtime as any).sessions.get(3);
    session.frameRevision++;
    expect(stale[SNAPSHOT_DELIVERY_COMMIT].begin()).toBe(false);
    expect(stale[SNAPSHOT_DELIVERY_COMMIT].begin()).toBe(false);
    expect(await page.inspect({ since: first.observationId })).toMatchObject({ mode: "full", reset: "previous-output-truncated" });
    await runtime.abortSessions();
  });

  it("reserves a delivery across logging and cancels safely without advancing", async () => {
    const { runtime } = harness([{ role: "button", name: "One", tag: "button" }]);
    const page = await runtime.createPage(3), wire = { maxBytes: 5000, evidenceId: "call" };
    const first = await page.inspect({ limit: 1, wire }) as any;
    const second = await page.inspect({ cursor: first.nextCursor, limit: 1, wire }) as any;
    const lease = first[SNAPSHOT_DELIVERY_COMMIT], competitor = second[SNAPSHOT_DELIVERY_COMMIT];
    expect(lease.begin()).toBe(true);
    expect(competitor.begin()).toBe(false);
    lease.cancel(); lease.cancel();
    expect(lease.begin()).toBe(false);
    expect(await page.inspect({ since: first.observationId })).toMatchObject({ mode: "full", reset: "previous-output-truncated" });
    const retry = await page.inspect({ cursor: `${first.observationId}:0:0`, limit: 1, wire }) as any;
    deliver(retry);
    const next = await page.inspect({ cursor: first.nextCursor, limit: 1, wire }) as any;
    deliver(next);
    expect(await page.inspect({ since: first.observationId })).toMatchObject({ mode: "delta", items: [] });
    await runtime.abortSessions();
  });

  it("invalidates the observation if its frame changes after delivery begins", async () => {
    const { runtime } = harness([{ role: "button", name: "One", tag: "button" }]);
    const page = await runtime.createPage(3);
    const first = await page.inspect({ limit: 1, wire: { maxBytes: 5000, evidenceId: "call" } }) as any;
    const lease = first[SNAPSHOT_DELIVERY_COMMIT];
    expect(lease.begin()).toBe(true);
    (runtime as any).sessions.get(3).frameRevision++;
    lease.finish(); lease.finish();
    await expect(page.inspect({ cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale-observation" });
    await expect(page.inspect({ since: first.observationId })).rejects.toMatchObject({ code: "stale-observation" });
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
  it("rejects unstable geometry and clicks once it is stable on retry", async () => {
    const base = { connected: true, y: 12, height: 20, visible: true, stable: true, enabled: true,
      editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [
      { ...base, x: 10, width: 20 }, { ...base, x: 30, width: 40 },
      { ...base, x: 30, width: 40 }, { ...base, x: 30, width: 40 },
    ]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).click()).rejects.toMatchObject({ code: "not-stable" });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
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
    const logger = { telemetry: vi.fn() };
    const { runtime } = harness([], undefined, logger);
    let finish!: () => void;
    const identity = { runId: "run", toolCallId: "1:call", toolCallIdCanonical: true as const };
    runtime.setContext({ conversationId: "conversation", toolCallId: "call", logIdentity: identity });
    const pending = (runtime as any).action(3, "waiting", null, () => new Promise<void>((resolve) => { finish = resolve; }));
    runtime.setContext({ conversationId: "other", toolCallId: "later" });
    finish(); await pending;
    expect(logger.telemetry.mock.calls.map(([event]) => ({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, toolCallIdCanonical: event.toolCallIdCanonical }))).toEqual([
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

  it("uses document coordinates for hit testing and viewport coordinates for mouse input after scrolling", async () => {
    const { runtime, command, calls } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 30, pageY: 400 } };
      if (method === "DOM.getNodeForLocation" && (params.x !== 40 || params.y !== 412)) throw new Error("No node found at given location");
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).click()).resolves.toMatchObject({ performed: true });
    expect(command).toHaveBeenCalledWith(expect.anything(), "DOM.getNodeForLocation", { x: 40, y: 412 });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => [params.x, params.y])).toEqual([[10, 12], [10, 12], [10, 12]]);
    await runtime.abortSessions();
  });

  it("uses an unobscured point of a transformed target when its center is blocked", async () => {
    const { runtime, command, calls } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.getContentQuads") return { quads: [[10, 10, 50, 30, 40, 50, 0, 30]] };
      if (method === "DOM.getNodeForLocation" && params.x === 25 && params.y === 30) throw new Error("No node found at given location");
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).click()).resolves.toMatchObject({ performed: true });
    const tested = command.mock.calls.filter(([, method]) => method === "DOM.getNodeForLocation").map(([, , params]) => params);
    expect(tested).toEqual([{ x: 25, y: 30 }, { x: 15, y: 25 }]);
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => [params.x, params.y]))
      .toEqual([[15, 25], [15, 25], [15, 25]]);
    await runtime.abortSessions();
  });

  it("re-resolves a locator when a framework replaces the node during hover actionability", async () => {
    const blocked = { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
    const ready = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [blocked, ready]);
    const page = await runtime.createPage(3);

    await page.getByRole("button", { name: "Sign in" }).hover();

    expect(calls.filter(({ method }) => method === "DOM.resolveNode").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual(["mouseMoved"]);
  });

  it.each(["click", "dblclick"] as const)("reports an intercepted %s without dispatching input", async (operation) => {
    const blocked = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: false, checked: false };
    const { runtime, calls } = harness(undefined, [blocked]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" })[operation]()).rejects.toMatchObject({ code: "intercepted" });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("identifies the element that intercepted a click", async () => {
    const blocked = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: false, checked: false };
    const { runtime, command, calls } = harness(undefined, [blocked]);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.getNodeForLocation") return { backendNodeId: 15, frameId: "root-frame" };
      if (method === "DOM.describeNode" && params.backendNodeId === 15) return { node: { nodeName: "DIV", attributes: ["id", "cookie-dialog"] } };
      if (method === "DOM.resolveNode" && params.backendNodeId === 15) return { object: { objectId: "blocker-node" } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function(hit)")) return { result: { value: false } };
      if (method === "Accessibility.getPartialAXTree" && params.backendNodeId === 15) return { nodes: [{ backendDOMNodeId: 15, role: { value: "dialog" }, name: { value: "Privacy settings" } }] };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).click()).rejects.toMatchObject({
      code: "intercepted",
      detail: { lastObservation: { state: { blocker: { reason: "hit-other-element", tag: "div", id: "cookie-dialog", role: "dialog", name: "Privacy settings", frameId: "root-frame" } } } },
    });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("identifies an interceptor in the parent of an out-of-process frame", async () => {
    const { runtime, command } = harness();
    await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    const child = { tabId: 3, sessionId: "child" };
    session.frames.set("child-frame", child);
    (runtime as any).frameGeometry = vi.fn(async () => ({ parent: { tabId: 3 }, owner: { backendNodeId: 19 }, quad: [0, 0, 100, 0, 100, 100, 0, 100], size: { width: 100, height: 100 } }));
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.getNodeForLocation") return sessionIdOf(source) === "child" ? { backendNodeId: 7 } : { backendNodeId: 15, frameId: "parent-frame" };
      if (method === "DOM.describeNode" && params.backendNodeId === 15) return { node: { nodeName: "DIV", attributes: ["id", "overlay"] } };
      return original(source, method, params);
    });
    const blocker = await (runtime as any).clickBlocker(session, { ...session, debuggee: child }, "node-1", { x: 10, y: 12 });
    expect(blocker).toMatchObject({ reason: "hit-other-element", tag: "div", id: "overlay", frameId: "parent-frame" });
  });

  it("fails immediately when a click target is missing", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);
    await expect(page.getByText("missing").click()).rejects.toMatchObject({ code: "not-found" });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it.each(["focus", "blur"] as const)("fails immediately when a %s target is missing", async (operation) => {
    const { runtime, calls, onDispatch } = harness([]);
    const page = await runtime.createPage(3);
    await expect(page.getByText("missing")[operation]()).rejects.toMatchObject({ code: "not-found" });
    expect(onDispatch).not.toHaveBeenCalled();
    expect(calls.filter(({ method }) => method === "DOM.focus")).toHaveLength(0);
  });

  it("rejects an invalid key before resolving or focusing its target", async () => {
    const { runtime, calls, pressChord, onDispatch } = harness([]);
    const page = await runtime.createPage(3);
    await expect(page.getByText("missing").press("Control+ARROWWUP")).rejects.toThrow("AutomationError[invalid-key]");
    expect(onDispatch).not.toHaveBeenCalled();
    expect(pressChord).not.toHaveBeenCalled();
    expect(calls.filter(({ method }) => method === "DOM.focus")).toHaveLength(0);
  });

  it.each([false, true])("fails a targeted press immediately without input when its %s frame/target is missing", async (missingFrame) => {
    const { runtime, calls, pressChord, onDispatch } = harness([]);
    const page = await runtime.createPage(3);
    const root = missingFrame ? page.frameLocator("#missing-frame") : page;
    await expect(root.getByText("missing").press("ArrowUp")).rejects.toMatchObject({ code: missingFrame ? "frame-not-found" : "not-found" });
    expect(pressChord).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(calls.filter(({ method }) => method === "DOM.focus" || method.startsWith("Input."))).toHaveLength(0);
  });

  it("still focuses an observed target and dispatches its valid key once", async () => {
    const { runtime, command, pressChord } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("document.hasFocus()"))
        return { result: { value: { connected: true, focused: true } } };
      return original(source, method, params);
    });
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).press("ArrowUp")).resolves.toMatchObject({ performed: true });
    expect(pressChord).toHaveBeenCalledOnce();
    expect(pressChord).toHaveBeenCalledWith(expect.any(Object), "ArrowUp", undefined, expect.any(Function));
  });

  it.each(["keydown", "keyup"] as const)("normalizes named %s keys and rejects unsupported names before dispatch", async (operation) => {
    const { runtime, calls } = harness();
    await runtime.keyState(3, operation, "ARROWUP");
    expect(calls.filter(({ method }) => method === "Input.dispatchKeyEvent").map(({ params }) => params)).toMatchObject([
      { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, type: operation === "keydown" ? "rawKeyDown" : "keyUp" },
    ]);
    calls.length = 0;
    await expect(runtime.keyState(3, operation, "ARROWWUP")).rejects.toThrow("AutomationError[invalid-key]");
    expect(calls.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it.each([
    ["not-visible", { visible: false }],
    ["disabled", { enabled: false }],
  ])("reports a %s click target without dispatching input", async (code, override) => {
    const state = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false, ...override };
    const { runtime, calls } = harness(undefined, [state]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Sign in" }).click()).rejects.toMatchObject({ code });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(0);
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
      const logger = { telemetry: vi.fn() };
      const { runtime } = harness([], undefined, logger);
      const controller = new AbortController();
      runtime.setContext({ signal: controller.signal });
      const page = await runtime.createPage(3);
      const pending = page.getByText("missing").hover();
      const rejected = expect(pending).rejects.toThrow(/AutomationError\[timeout\].*lastObservation/);
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 2_200);
      await vi.advanceTimersByTimeAsync(2_200);

      await rejected;
      const attempts = logger.telemetry.mock.calls.map(([event]) => event).filter((event) => event.type === "automation.action.attempt");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((event) => event.content.attempt)).toEqual([1, 21, 41]);
      expect(logger.telemetry.mock.calls.map(([event]) => event).find((event) => event.type === "automation.action.failed")?.content.diagnostic)
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

  it("checks CSS scope uniqueness when resolving the target after the DOM changes", async () => {
    const { runtime, command } = harness();
    const fixture = document.createElement("div");
    fixture.innerHTML = '<section class="scope"></section>';
    document.body.append(fixture);
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes("metadata"))
        return { result: { value: new Function("document", `return ${params.expression}`)(fixture) } };
      return original(source, method, params);
    });
    try {
      const page = await runtime.createPage(3);
      const target = page.locator(".scope").uniqueScope().locator("button");
      fixture.insertAdjacentHTML("beforeend", '<section class="scope"><button>Wrong target</button></section>');
      await expect(target.count()).rejects.toThrow(/invalid-scope/);
    } finally { fixture.remove(); await runtime.abortSessions(); }
  });

  it("binds the unique role scope through later semantic resolution and rejects a detached scope", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    const original = command.getMockImplementation()!;
    let added = false, detach = false;
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression === "document") return { result: { objectId: "document" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: params.objectId === "document" ? 1 : params.objectId === "scope" ? 2 : 3 } };
      if (method === "DOM.resolveNode") return { object: { objectId: params.backendNodeId === 2 ? "scope" : "button" } };
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){return this.isConnected}") return { result: { value: !detach } };
      if (method === "Accessibility.queryAXTree") {
        if (params.objectId === "document") return { nodes: [{ backendDOMNodeId: 2, role: { value: "region" }, name: { value: "Area" } }] };
        expect(params.objectId).toBe("scope");
        added = true; // A new matching scope appears after the original has been bound.
        // The added scope has the only target; the previously bound scope has none.
        return { nodes: [] };
      }
      return original(source, method, params);
    });
    const spec = page.getByRole("region", { name: "Area" }).uniqueScope().getByRole("button", { name: "Target" }).spec;
    try {
      const result = await (runtime as any).resolveSemantic(session, session.debuggee, spec);
      expect(added).toBe(true); expect(result).toEqual([]);
      detach = true;
      await expect((runtime as any).resolveSemantic(session, session.debuggee, spec)).rejects.toMatchObject({ code: "invalid-scope", detail: { reason: "scope-detached" } });
    } finally { await runtime.abortSessions(); }
  });

  it("does not retry a scoped action against a replacement scope", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const session = (runtime as any).sessions.get(3);
    const spec = page.locator(".scope").uniqueScope().locator("button").spec;
    const resolve = vi.spyOn(runtime as any, "resolveOnce").mockResolvedValueOnce(undefined).mockResolvedValue("replacement-target");
    try {
      await expect((runtime as any).waitActionableLocator(session, spec, false, false)).rejects.toMatchObject({ code: "not-found" });
      expect(resolve).toHaveBeenCalledTimes(1);
      resolve.mockClear().mockResolvedValueOnce(undefined).mockResolvedValue("replacement-target");
      await expect((runtime as any).resolveOne(session, spec)).rejects.toMatchObject({ code: "not-found", detail: { reason: "scoped-target-not-found" } });
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally { resolve.mockRestore(); await runtime.abortSessions(); }
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
