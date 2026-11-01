import { describe, expect, it } from "vitest";
import { snapshotDomSupplement as captureDomSupplement } from "./snapshot-dom";

const snapshotDomSupplement = (...args: Parameters<typeof captureDomSupplement>) => captureDomSupplement(...args).items;

function fixture() {
  const strings: string[] = [];
  const s = (value: string) => { const index = strings.indexOf(value); return index === -1 ? strings.push(value) - 1 : index; };
  const document = (frame: string, base: number) => ({
    frameId: s(frame),
    nodes: {
      backendNodeId: Array.from({ length: 11 }, (_, i) => base + i),
      parentIndex: [-1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      nodeType: [9, 1, 3, 3, 3, 1, 1, 1, 1, 1, 3],
      nodeName: ["#document", "MAIN", "#text", "#text", "#text", "INPUT", "BUTTON", "INPUT", "A", "::before", "#text"].map(s),
      nodeValue: ["", "", "Visible", "Hidden", "Clipped original", "", "", "", "", "", "Visible"].map(s),
      attributes: [[], [], [], [], [], [s("type"), s("checkbox")], [s("aria-hidden"), s("true")], [s("type"), s("hidden")], [s("href"), s("/next")], [], []],
      inputChecked: { index: [5] }, inputValue: { index: [5], value: [s("on")] },
    },
    layout: { nodeIndex: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], text: ["", "", "Visible", "Hidden", "Clipped original", "", "", "", "", "Generated", "Visible"].map(s), styles: Array.from({ length: 11 }, () => [] as number[]) },
  });
  return { strings, documents: [document("outer", 10), document("child", 100)] };
}

describe("DOM snapshot visible supplementary evidence", () => {
  it.each([["", true], ["true", true], ["plaintext-only", true], ["false", false], ["invalid", false]])
  ("retains only a valid explicit contenteditable fallback (%s)", (value, expected) => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    const add = (text: string) => snapshot.strings.push(text) - 1;
    doc.nodes.nodeName[6] = add("DIV");
    doc.nodes.attributes[6] = [add("contenteditable"), add(value as string)];
    const items = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[16, true]]), covered: new Set() });
    expect(items.some((item) => item.backendNodeId === 16 && item.kind === "control")).toBe(expected);
  });
  it.each([
    ["switch", "0", true], ["checkbox", "-1", true], ["button", "", true],
    ["switch", "", true], ["heading", "0", false], ["presentation", "0", false], ["unknown", "0", false],
  ])("discovers visible explicit control roles without assuming a tab stop (%s, %s)", (role, tabIndex, expected) => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    const add = (text: string) => snapshot.strings.push(text) - 1;
    doc.nodes.nodeName[6] = add("DIV");
    doc.nodes.attributes[6] = [add("role"), add(role), ...(tabIndex ? [add("tabindex"), add(tabIndex)] : [])];
    const capture = (visible: boolean, covered = false) => snapshotDomSupplement(snapshot, {
      frameId: "outer", visibility: new Map([[16, visible]]), covered: new Set(covered ? [16] : []),
    });
    expect(capture(true).some((item) => item.backendNodeId === 16 && item.kind === "control")).toBe(expected);
    expect(capture(false)).toEqual([]);
    expect(capture(true, true)).toEqual([]);
  });
  it("preserves distinct matching text, clips projected text and exposes omitted native controls", () => {
    const snapshot = fixture();
    const visibility = new Map<number, boolean>(Array.from({ length: 11 }, (_, i) => [10 + i, true]));
    visibility.set(13, false);
    const evidence = snapshotDomSupplement(snapshot, { frameId: "outer", visibility, covered: new Set([16]),
      textProjections: new Map([[14, { full: "Clipped original", text: "Clipped" }]]) });
    expect(evidence.map(({ backendNodeId, kind, text, tag }) => ({ backendNodeId, kind, text, tag }))).toEqual([
      { backendNodeId: 12, kind: "text", text: "Visible", tag: undefined },
      { backendNodeId: 14, kind: "text", text: "Clipped", tag: undefined },
      { backendNodeId: 15, kind: "control", text: undefined, tag: "input" },
      { backendNodeId: 18, kind: "control", text: undefined, tag: "a" },
      { backendNodeId: 19, kind: "text", text: "Generated", tag: undefined },
      { backendNodeId: 20, kind: "text", text: "Visible", tag: undefined },
    ]);
    expect(evidence.find(({ backendNodeId }) => backendNodeId === 15)).toMatchObject({ checked: true, value: "on", parentBackendNodeId: 11, nodeIndex: 5 });
  });

  it("never returns a node without a positive visibility decision or layout, and supports a different frame", () => {
    const snapshot = fixture();
    snapshot.documents[1]!.layout.nodeIndex = [0, 1, 2];
    snapshot.documents[1]!.layout.text.length = 3;
    snapshot.documents[1]!.layout.styles.length = 3;
    expect(snapshotDomSupplement(snapshot, { frameId: "child", visibility: new Map([[102, true], [104, true]]), covered: new Set() }))
      .toEqual([{ frameId: "child", backendNodeId: 102, nodeIndex: 2, parentBackendNodeId: 101, kind: "text", text: "Visible" }]);
  });

  it("keeps each frame's ancestry index separate", () => {
    const snapshot = fixture();
    const { items, indexes } = captureDomSupplement(snapshot, { visibility: new Map([[12, true], [102, true]]), covered: new Set() });
    expect(items.map((item) => item.frameId)).toEqual(["outer", "child"]);
    expect(indexes.get("outer")?.contains(11, 12)).toBe(true);
    expect(indexes.get("outer")?.indexOf(102)).toBeUndefined();
    expect(indexes.get("child")?.contains(101, 102)).toBe(true);
    expect(indexes.get("child")?.indexOf(12)).toBeUndefined();
  });

  it("refuses to use a stale paint projection", () => {
    const snapshot = fixture();
    expect(() => snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[14, true]]), covered: new Set(),
      textProjections: new Map([[14, { full: "stale", text: "Clipped" }]]) })).toThrow("projection does not match");
  });

  it("decodes a CDP empty attribute value without dropping the native state", () => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    const disabled = snapshot.strings.push("disabled") - 1;
    doc.nodes.attributes[5]!.push(disabled, -1);
    const result = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[15, true]]), covered: new Set() });
    expect(result[0]?.attributes).toMatchObject({ type: "checkbox", disabled: "" });
    doc.nodes.attributes[5]!.push(-1, -1);
    expect(() => snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[15, true]]), covered: new Set() })).toThrow("Invalid DOM snapshot attribute string");
  });

  it("extracts live textarea values and selected option labels without option layout boxes", () => {
    const strings: string[] = [];
    const intern = (value: string) => { const index = strings.indexOf(value); return index < 0 ? strings.push(value) - 1 : index; };
    const snapshot = { strings, documents: [{ frameId: intern("outer"), nodes: {
      backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8], parentIndex: [-1, 0, 1, 0, 3, 4, 3, 6], nodeType: [9, 1, 3, 1, 1, 3, 1, 3],
      nodeName: ["#document", "TEXTAREA", "#text", "SELECT", "OPTION", "#text", "OPTION", "#text"].map(intern),
      nodeValue: ["", "", "Default notes", "", "", "First raw", "", "Blue label"].map(intern),
      attributes: [[], [], [], [], [intern("value"), intern("first"), intern("label"), intern("First label")], [], [intern("value"), intern("blue")], []],
      textValue: { index: [1], value: [intern("Live notes")] }, optionSelected: { index: [6] },
    }, layout: { nodeIndex: [0, 1, 3], text: [-1, -1, -1], styles: [[], [], []] } }] };
    const result = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[2, true], [4, true]]), covered: new Set() });
    expect(result.find((item) => item.backendNodeId === 2)).toMatchObject({ tag: "textarea", value: "Live notes" });
    expect(result.find((item) => item.backendNodeId === 4)).toMatchObject({ tag: "select", value: "blue", selectedOptions: [{ label: "Blue label", value: "blue" }], selectedOptionIds: [7] });
    expect(JSON.stringify(result)).not.toContain("Default notes");
    expect(JSON.stringify(result)).not.toContain("First raw");
    snapshot.documents[0]!.nodes.optionSelected.index = [4];
    const changed = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[4, true]]), covered: new Set() });
    expect(changed[0]).toMatchObject({ value: "first", selectedOptions: [{ label: "First label", value: "first" }], selectedOptionIds: [5] });
  });

  it("never merges identical adjacent layout fragments", () => {
    const snapshot = fixture();
    const layout = snapshot.documents[0]!.layout;
    layout.nodeIndex.push(2); layout.text.push(layout.text[2]!); layout.styles.push([]);
    const result = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[12, true]]), covered: new Set() });
    expect(result[0]?.text).toBe("VisibleVisible");
  });

  it("retains a painted first letter independently while applying the full text projection", () => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    const add = (value: string) => snapshot.strings.push(value) - 1;
    doc.nodes.nodeName[9] = add("::first-letter");
    doc.layout.text[9] = add("H");
    doc.nodes.nodeValue[4] = add("Hello");
    doc.layout.text[4] = add("ello");
    const options = { frameId: "outer", visibility: new Map<number, boolean>([[14, true], [19, true]]), covered: new Set<number>(),
      textProjections: new Map([[14, { full: "Hello", text: "Hlo" }]]) };
    expect(snapshotDomSupplement(snapshot, options).map(({ backendNodeId, text }) => ({ backendNodeId, text }))).toEqual([
      { backendNodeId: 14, text: "lo" }, { backendNodeId: 19, text: "H" },
    ]);
    // The same first letter can be present even when no paint projection was needed.
    expect(snapshotDomSupplement(snapshot, { ...options, textProjections: new Map() }).map(({ text }) => text)).toEqual(["ello", "H"]);
    // More than one matching visible pseudo ancestor is ambiguous.
    doc.nodes.backendNodeId.push(21); doc.nodes.parentIndex.push(1); doc.nodes.nodeType.push(1);
    doc.nodes.nodeName.push(doc.nodes.nodeName[9]!); doc.nodes.nodeValue.push(add("")); doc.nodes.attributes.push([]);
    doc.layout.nodeIndex.push(11); doc.layout.text.push(doc.layout.text[9]!); doc.layout.styles.push([]);
    options.visibility.set(21, true);
    expect(() => snapshotDomSupplement(snapshot, options)).toThrow("projection does not match");
  });

  it("requires a valid backend identity to prove a first-letter ancestor", () => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    const add = (value: string) => snapshot.strings.push(value) - 1;
    doc.nodes.backendNodeId[1] = 0;
    doc.nodes.nodeName[9] = add("::first-letter"); doc.layout.text[9] = add("H");
    doc.nodes.nodeValue[4] = add("Hello"); doc.layout.text[4] = add("ello");
    expect(() => snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[14, true], [19, true]]), covered: new Set(),
      textProjections: new Map([[14, { full: "Hello", text: "Hlo" }]]) })).toThrow("projection does not match");
  });

  it("includes layoutless native controls when a visible descendant paints", () => {
    const snapshot = fixture(), doc = snapshot.documents[0]!;
    // BUTTON (16) has no layout, but owns a visible text child (20).
    doc.nodes.parentIndex[10] = 6;
    const position = doc.layout.nodeIndex.indexOf(6);
    doc.layout.nodeIndex.splice(position, 1); doc.layout.text.splice(position, 1); doc.layout.styles.splice(position, 1);
    const result = snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[16, true], [20, true]]), covered: new Set() });
    expect(result.map(({ backendNodeId, kind }) => ({ backendNodeId, kind }))).toEqual([
      { backendNodeId: 16, kind: "control" }, { backendNodeId: 20, kind: "text" },
    ]);
    expect(snapshotDomSupplement(snapshot, { frameId: "outer", visibility: new Map([[16, true], [20, false]]), covered: new Set() })).toEqual([]);
  });

  it("extracts visible text from a 25,000-level tree without per-item ancestor arrays", () => {
    const depth = 25_000, count = depth * 2 + 1;
    const strings = ["deep", "#document", "DIV", "#text", "x"];
    const backendNodeId = Array.from({ length: count }, (_, index) => index + 1);
    const parentIndex = [-1, ...Array.from({ length: depth }, (_, index) => index),
      ...Array.from({ length: depth }, (_, index) => index + 1)];
    const nodeType = [9, ...Array.from({ length: depth }, () => 1), ...Array.from({ length: depth }, () => 3)];
    const nodeName = [1, ...Array.from({ length: depth }, () => 2), ...Array.from({ length: depth }, () => 3)];
    const nodeValue = Array.from({ length: count }, () => 4);
    const nodeIndex = Array.from({ length: depth }, (_, index) => depth + 1 + index);
    const visibility = new Map(nodeIndex.map((index) => [backendNodeId[index]!, true]));
    const snapshot = { strings, documents: [{ frameId: 0, nodes: { backendNodeId, parentIndex, nodeType, nodeName, nodeValue },
      layout: { nodeIndex, text: nodeIndex.map(() => 4), styles: nodeIndex.map(() => []) } }] };
    const { items, indexes } = captureDomSupplement(snapshot, { frameId: "deep", visibility, covered: new Set() });
    expect(items).toHaveLength(depth);
    expect(items.every((item) => item.text === "x" && !Object.hasOwn(item, "ancestors"))).toBe(true);
    const index = indexes.get("deep")!;
    expect(index.preorder).toHaveLength(count);
    expect(index.contains(1, items.at(-1)!.backendNodeId)).toBe(true);
    expect(index.subtreeRange(index.indexOf(1)!)).toEqual({ start: 0, end: count });
  });

  it("collects a deeply nested selected option without repeatedly walking parents", () => {
    const depth = 25_000, count = depth + 4;
    const strings = ["frame", "#document", "SELECT", "OPTION", "SPAN", "#text", "chosen", "value", "selected-value"];
    const backendNodeId = Array.from({ length: count }, (_, index) => index + 1);
    const parentIndex = Array.from({ length: count }, (_, index) => index - 1);
    const nodeType = [9, ...Array.from({ length: count - 2 }, () => 1), 3];
    const nodeName = [1, 2, 3, ...Array.from({ length: depth }, () => 4), 5];
    const nodeValue = Array.from({ length: count }, () => 6);
    const attributes = Array.from({ length: count }, () => [] as number[]);
    attributes[2] = [7, 8];
    const snapshot = { strings, documents: [{ frameId: 0, nodes: { backendNodeId, parentIndex, nodeType, nodeName, nodeValue,
      attributes, optionSelected: { index: [2] } }, layout: { nodeIndex: [1], text: [-1], styles: [[]] } }] };
    const { items } = captureDomSupplement(snapshot, { frameId: "frame", visibility: new Map([[2, true]]), covered: new Set() });
    expect(items).toEqual([expect.objectContaining({ tag: "select", value: "selected-value",
      selectedOptions: [{ label: "chosen", value: "selected-value" }] })]);
  });

});
