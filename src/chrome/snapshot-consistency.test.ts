import { describe, expect, it } from "vitest";
import { changedTextNodes, hasUnrenderedHeadSourceChange, sameDOMSnapshot } from "./snapshot-consistency";
import { SNAPSHOT_COMPUTED_STYLES, snapshotVisibility, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

function fixture(reverse = false) {
  const pool = ["root", "#document", "BODY", "#text", "INPUT", "hello", "type", "text", "aria-label", "Search", "style", "left:10px", "value one", "1", "visible", "static", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "clip"];
  const strings = reverse ? [...pool].reverse() : [...pool];
  const id = (value: string) => strings.indexOf(value);
  const style = ["1", "visible", "visible", "visible", "visible", "static", "none", "none", "none", "none", "auto", "none", "none", "none", "none", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "none", "0px", "none", "none", "none", "clip", "none", "none", "none", "none"].map(id);
  return { strings, documents: [{ frameId: id("root"), contentWidth: 100, contentHeight: 100, scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { backendNodeId: [1, 2, 3, 4], parentIndex: [-1, 0, 1, 1], nodeType: [9, 1, 3, 1],
      nodeName: [id("#document"), id("BODY"), id("#text"), id("INPUT")], nodeValue: [-1, -1, id("hello"), -1],
      attributes: [[], [], [], [id("type"), id("text"), id("aria-label"), id("Search"), id("style"), id("left:10px")]],
      inputValue: { index: [3], value: [id("value one")] }, inputChecked: { index: [] as number[] }, optionSelected: { index: [] as number[] } },
    layout: { nodeIndex: [0, 1, 2, 3], bounds: [[0, 0, 100, 100], [0, 0, 100, 100], [10, 10, 30, 10], [10, 30, 30, 10]],
      styles: [style, style, style, style], text: [-1, -1, id("hello"), -1] },
    textBoxes: { layoutIndex: [2], start: [0], length: [5], bounds: [[10, 10, 30, 10]] },
  }] };
}

function intern(snapshot: ReturnType<typeof fixture>, value: string) {
  snapshot.strings.push(value); return snapshot.strings.length - 1;
}

function headFixture(sources = [{ id: 20, src: "/old.js", text: "old()" }]): any {
  const snapshot = fixture(), original = snapshot.documents[0]!, style = original.layout.styles[0]!;
  const id = (value: string) => intern(snapshot, value);
  const records = [
    { backend: 1, parent: -1, type: 9, name: "#document", value: "", attributes: [] as string[] },
    { backend: 5, parent: 0, type: 1, name: "HTML", value: "", attributes: [] as string[] },
    { backend: 6, parent: 1, type: 1, name: "HEAD", value: "", attributes: [] as string[] },
  ];
  for (const source of sources) {
    const parent = records.length;
    records.push({ backend: source.id, parent: 2, type: 1, name: "SCRIPT", value: "", attributes: ["src", source.src] });
    records.push({ backend: source.id + 100, parent, type: 3, name: "#text", value: source.text, attributes: [] });
  }
  const body = records.length, text = body + 1, input = body + 2;
  records.push(
    { backend: 2, parent: 1, type: 1, name: "BODY", value: "", attributes: [] },
    { backend: 3, parent: body, type: 3, name: "#text", value: "hello", attributes: [] },
    { backend: 4, parent: body, type: 1, name: "INPUT", value: "", attributes: ["type", "text", "aria-label", "Search", "style", "left:10px"] },
  );
  (original as any).nodes = {
    backendNodeId: records.map((record) => record.backend), parentIndex: records.map((record) => record.parent), nodeType: records.map((record) => record.type),
    nodeName: records.map((record) => id(record.name)), nodeValue: records.map((record) => record.value ? id(record.value) : -1),
    attributes: records.map((record) => record.attributes.map(id)), inputValue: { index: [input], value: [id("value one")] },
    inputChecked: { index: [] }, optionSelected: { index: [] }, isClickable: { index: [input] },
  };
  original.layout = { nodeIndex: [0, 1, body, text, input], bounds: [[0, 0, 100, 100], [0, 0, 100, 100], [0, 0, 100, 100], [10, 10, 30, 10], [10, 30, 30, 10]],
    styles: [style, style, style, style, style], text: [-1, -1, -1, id("hello"), -1] };
  original.textBoxes = { layoutIndex: [3], start: [0], length: [5], bounds: [[10, 10, 30, 10]] };
  return snapshot;
}

const completeStyleCatalog = [...SNAPSHOT_COMPUTED_STYLES, "background-image", "font-family", "outline-width"];
function completeHeadFixture(sources?: Parameters<typeof headFixture>[0]): any {
  const snapshot = headFixture(sources);
  const defaults: Record<string, string> = { "white-space": "normal", "-webkit-user-modify": "read-only", "background-color": "rgba(0, 0, 0, 0)",
    "border-radius": "0px", "mix-blend-mode": "normal", "z-index": "auto", isolation: "auto", "container-type": "normal",
    "background-image": "none", "font-family": "Arial", "outline-width": "0px" };
  snapshot.documents[0].layout.styles = snapshot.documents[0].layout.styles.map((row: number[]) => completeStyleCatalog.map((name, index) =>
    index < row.length ? row[index] : intern(snapshot, defaults[name] ?? "none")));
  return snapshot;
}
const completeHeadOptions = { ignoreUnrenderedText: true, completeStyleCatalog };

describe("DOM snapshot consistency", () => {
  it("isolates text changes only when all geometry and other evidence agree", () => {
    const before = fixture(), after = fixture(true);
    const text = intern(after, "world");
    after.documents[0]!.nodes.nodeValue[2] = text;
    after.documents[0]!.layout.text[2] = text;
    after.documents[0]!.nodes.backendNodeId[2] = 99;
    expect(changedTextNodes(before, after)).toEqual(new Set([2]));
    after.documents[0]!.layout.bounds[2]![0]++;
    expect(changedTextNodes(before, after)).toBeUndefined();
  });
  it("detects changes to user-modify even when node attributes and geometry remain unchanged", () => {
    const before = fixture(), after = fixture(true);
    for (const snapshot of [before, after]) {
      const layout = snapshot.documents[0]!.layout;
      layout.styles = layout.styles.map((style) => [...style, intern(snapshot, "normal"), intern(snapshot, "read-write")]);
    }
    expect(sameDOMSnapshot(before, after)).toBe(true);
    after.documents[0]!.layout.styles[2]![33] = intern(after, "read-only");
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });
  it("detects changed white-space styles even when text and geometry are unchanged", () => {
    const before = fixture(), after = fixture(true);
    before.documents[0]!.layout.styles[2] = [...before.documents[0]!.layout.styles[2]!, intern(before, "pre")];
    after.documents[0]!.layout.styles[2] = [...after.documents[0]!.layout.styles[2]!, intern(after, "pre")];
    expect(sameDOMSnapshot(before, after)).toBe(true);
    after.documents[0]!.layout.styles[2]![32] = intern(after, "normal");
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });

  it("compares string values rather than string-table indexes", () => {
    expect(sameDOMSnapshot(fixture(), fixture(true))).toBe(true);
  });

  it("tolerates only unpainted HEAD source churn after independent semantic confirmation", () => {
    const before = headFixture([{ id: 20, src: "/old.js", text: "old()" }, { id: 30, src: "/stable.js", text: "stable()" }]);
    const after = headFixture([{ id: 30, src: "/new-location.js", text: "changed()" }, { id: 40, src: "/new.js", text: "new()" }, { id: 50, src: "/later.js", text: "later()" }]);
    expect(sameDOMSnapshot(before, after)).toBe(false);
    expect(sameDOMSnapshot(before, after, undefined, { ignoreUnrenderedText: true })).toBe(false);
    expect(hasUnrenderedHeadSourceChange(before, after)).toBe(true);
    const fullBefore = completeHeadFixture([{ id: 20, src: "/old.js", text: "old()" }, { id: 30, src: "/stable.js", text: "stable()" }]);
    const fullAfter = completeHeadFixture([{ id: 30, src: "/new-location.js", text: "changed()" }, { id: 40, src: "/new.js", text: "new()" }, { id: 50, src: "/later.js", text: "later()" }]);
    expect(sameDOMSnapshot(fullBefore, fullAfter, undefined, completeHeadOptions)).toBe(true);
    const candidates: SnapshotTextPaintCandidate[] = [];
    const visibility = snapshotVisibility(fullBefore, { textPaintCandidates: candidates });
    expect(sameDOMSnapshot(fullBefore, fullAfter, { visibility, textPaintCandidates: candidates }, completeHeadOptions)).toBe(true);
  });

  it("keeps rendering, control state and retained structure strict while HEAD source changes", () => {
    const before = completeHeadFixture();
    const changes: Array<(snapshot: any) => void> = [
      (snapshot) => { snapshot.documents[0].layout.bounds[3][0]++; },
      (snapshot) => { snapshot.documents[0].textBoxes.bounds[0][0]++; },
      (snapshot) => { const layout = snapshot.documents[0].layout; layout.styles[3] = [...layout.styles[3]]; layout.styles[3][21] = intern(snapshot, "rgb(255,0,0)"); },
      (snapshot) => { snapshot.documents[0].nodes.attributes.at(-1).push(intern(snapshot, "data-state"), intern(snapshot, "changed")); },
      (snapshot) => { snapshot.documents[0].nodes.inputChecked.index.push(snapshot.documents[0].nodes.backendNodeId.indexOf(4)); },
      (snapshot) => { snapshot.documents[0].nodes.isClickable.index.push(snapshot.documents[0].nodes.backendNodeId.indexOf(2)); },
      (snapshot) => { snapshot.documents[0].nodes.parentIndex[snapshot.documents[0].nodes.backendNodeId.indexOf(4)] = 1; },
      (snapshot) => { snapshot.documents[0].frameId = intern(snapshot, "replacement-frame"); },
      (snapshot) => { snapshot.documents[0].layout.styles[3][completeStyleCatalog.indexOf("background-image")] = intern(snapshot, "linear-gradient(black,black)"); },
    ];
    for (const change of changes) {
      const after = completeHeadFixture([{ id: 40, src: "/new.js", text: "new()" }]);
      change(after);
      expect(sameDOMSnapshot(before, after, undefined, completeHeadOptions)).toBe(false);
    }
  });

  it("does not erase laid-out scripts, HEAD controls or annotated source", () => {
    const before = completeHeadFixture();
    for (const change of [
      (snapshot: any) => { snapshot.documents[0].nodes.nodeName[3] = intern(snapshot, "STYLE"); },
      (snapshot: any) => { snapshot.documents[0].nodes.nodeName[3] = intern(snapshot, "INPUT"); },
      (snapshot: any) => { snapshot.documents[0].nodes.pseudoType = { index: [3], value: [intern(snapshot, "before")] }; },
      (snapshot: any) => { const layout = snapshot.documents[0].layout; layout.nodeIndex.push(3); layout.styles.push([...layout.styles[0]]); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1); },
    ]) {
      const after = completeHeadFixture([{ id: 40, src: "/new.js", text: "new()" }]);
      change(after);
      expect(sameDOMSnapshot(before, after, undefined, completeHeadOptions)).toBe(false);
    }
  });

  it("rejects malformed identities and raw index references before removing HEAD source", () => {
    const before = completeHeadFixture();
    for (const change of [
      (snapshot: any) => { snapshot.documents[0].nodes.backendNodeId[3] = 1; },
      (snapshot: any) => { snapshot.documents[0].nodes.backendNodeId[3] = 0; },
      (snapshot: any) => { snapshot.documents[0].layout.nodeIndex[3] = 999; },
      (snapshot: any) => { snapshot.documents[0].nodes.inputValue.index[0] = 999; },
      (snapshot: any) => { snapshot.documents[0].nodes.contentDocumentIndex = { index: [6], value: [999] }; },
      (snapshot: any) => { snapshot.documents[0].textBoxes.layoutIndex[0] = 999; },
      (snapshot: any) => { snapshot.documents.push(structuredClone(snapshot.documents[0])); },
    ]) {
      const after = completeHeadFixture([{ id: 40, src: "/new.js", text: "new()" }]);
      change(after);
      expect(sameDOMSnapshot(before, after, undefined, completeHeadOptions)).toBe(false);
    }
  });

  it("declines HEAD relaxation for paint worklets whose custom inputs were not captured", () => {
    const before = completeHeadFixture(), after = completeHeadFixture([{ id: 40, src: "/new.js", text: "new()" }]);
    for (const snapshot of [before, after]) snapshot.documents[0].layout.styles[3][completeStyleCatalog.indexOf("background-image")] = intern(snapshot, "paint(custom-background)");
    expect(sameDOMSnapshot(before, after, undefined, completeHeadOptions)).toBe(false);
  });

  it("can ignore unrendered text only after independent semantic confirmation", () => {
    const before = fixture(), after = fixture(true);
    for (const snapshot of [before, after]) {
      const layout = snapshot.documents[0]!.layout;
      for (const field of [layout.nodeIndex, layout.bounds, layout.styles, layout.text]) field.splice(2, 1);
      snapshot.documents[0]!.textBoxes = { layoutIndex: [], start: [], length: [], bounds: [] };
    }
    after.documents[0]!.nodes.nodeValue[2] = intern(after, "changing hidden text");
    expect(sameDOMSnapshot(before, after)).toBe(false);
    expect(sameDOMSnapshot(before, after, undefined, { ignoreUnrenderedText: true })).toBe(true);
    after.documents[0]!.nodes.nodeValue[2] = 99999;
    expect(sameDOMSnapshot(before, after, undefined, { ignoreUnrenderedText: true })).toBe(false);
  });

  it("never ignores changes to laid-out text with semantic confirmation", () => {
    const before = fixture(), after = fixture(true);
    after.documents[0]!.nodes.nodeValue[2] = intern(after, "changed");
    expect(sameDOMSnapshot(before, after, undefined, { ignoreUnrenderedText: true })).toBe(false);
  });

  it("still rejects changed data attributes even with semantic confirmation", () => {
    const before = fixture(), after = fixture(true);
    before.documents[0]!.nodes.attributes[3]!.push(intern(before, "data-state"), intern(before, "one"));
    after.documents[0]!.nodes.attributes[3]!.push(intern(after, "data-state"), intern(after, "two"));
    expect(sameDOMSnapshot(before, after, undefined, { ignoreUnrenderedText: true })).toBe(false);
  });

  it("detects text, semantic attributes, form values, flags, and changed frame identity", () => {
    const before = fixture();
    const cases = [
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.nodeValue[2] = intern(after, "new text"); after.documents[0]!.layout.text[2] = after.documents[0]!.nodes.nodeValue[2]!; },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.attributes[3]![3] = intern(after, "New label"); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.inputValue.value[0] = intern(after, "value two"); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.inputChecked.index.push(3); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.optionSelected.index.push(3); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.frameId = intern(after, "other frame"); },
    ];
    for (const change of cases) { const after = fixture(true); change(after); expect(sameDOMSnapshot(before, after)).toBe(false); }
  });

  it("compares Chrome's -1 empty attribute value with an interned empty string", () => {
    const before = fixture(), after = fixture(true);
    const beforeAttrs = before.documents[0]!.nodes.attributes[3]!;
    const afterAttrs = after.documents[0]!.nodes.attributes[3]!;
    beforeAttrs.push(intern(before, "disabled"), -1);
    afterAttrs.push(intern(after, "disabled"), intern(after, ""));
    expect(sameDOMSnapshot(before, before)).toBe(true);
    expect(sameDOMSnapshot(before, after)).toBe(true);
    afterAttrs[afterAttrs.length - 1] = intern(after, "changed");
    expect(sameDOMSnapshot(before, after)).toBe(false);
    afterAttrs[afterAttrs.length - 2] = -1;
    expect(sameDOMSnapshot(after, after)).toBe(false);
  });

  it("rejects structural, ordering, visible text and text-transform changes", () => {
    const before = fixture();
    for (const change of [
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.nodes.parentIndex[3] = 0; },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.layout.nodeIndex[2] = 3; },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.layout.text[2] = intern(after, "changed paint"); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.layout.styles[2]![25] = intern(after, "uppercase"); },
      (after: ReturnType<typeof fixture>) => { after.documents[0]!.textBoxes.length[0] = 2; },
    ]) { const after = fixture(true); change(after); expect(sameDOMSnapshot(before, after)).toBe(false); }
  });

  it("permits purely geometric movement if visible content and semantics stay the same", () => {
    const before = fixture(), after = fixture(true);
    after.documents[0]!.nodes.attributes[3]![5] = intern(after, "left:15px");
    after.documents[0]!.layout.bounds[2]![0] = 15;
    after.documents[0]!.layout.bounds[3]![0] = 15;
    after.documents[0]!.textBoxes.bounds[0]![0] = 15;
    expect(sameDOMSnapshot(before, after)).toBe(true);
  });

  it("rejects a document scroll between captures even when the same nodes remain visible", () => {
    const before = fixture(), after = fixture(true);
    after.documents[0]!.scrollOffsetY = 1;
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });

  it("rejects movement of a partially clipped iframe between captures", () => {
    const before = fixture(), after = fixture(true);
    for (const snapshot of [before, after]) snapshot.documents[0]!.nodes.nodeName[3] = intern(snapshot, "IFRAME");
    after.documents[0]!.layout.bounds[3]![0] = 11;
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });

  it("detects a visible node becoming clipped even when text and style attributes are unchanged", () => {
    const before = fixture(), after = fixture(true);
    after.documents[0]!.layout.bounds[2]![0] = -1000;
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });

  it("requires matching text box geometry when a paint candidate needs live glyph analysis", () => {
    const before = fixture(), after = fixture(true);
    for (const value of [before, after]) {
      const style = [...value.documents[0]!.layout.styles[2]!];
      style[21] = intern(value, "rgba(0, 0, 0, 0)");
      value.documents[0]!.layout.styles[2] = style;
    }
    const candidates: SnapshotTextPaintCandidate[] = [];
    snapshotVisibility(before, { textPaintCandidates: candidates });
    expect(candidates).toHaveLength(1);
    expect(sameDOMSnapshot(before, after)).toBe(true);
    after.documents[0]!.textBoxes.bounds[0]![0] = 11;
    expect(sameDOMSnapshot(before, after)).toBe(false);
  });

  it("reuses the producer's paint-adjusted visibility without skipping other changes", () => {
    const before = fixture(), after = fixture(true);
    for (const value of [before, after]) {
      const style = [...value.documents[0]!.layout.styles[2]!];
      style[21] = intern(value, "rgba(0, 0, 0, 0)");
      value.documents[0]!.layout.styles[2] = style;
    }
    const candidates: SnapshotTextPaintCandidate[] = [];
    const visibility = snapshotVisibility(before, { textPaintCandidates: candidates });
    visibility.set(3, false);
    const evidence = { visibility, textPaintCandidates: candidates, paintAdjusted: true };
    expect(sameDOMSnapshot(before, after, evidence)).toBe(true);
    expect(sameDOMSnapshot(before, after, { ...evidence, paintAdjusted: false })).toBe(false);
    visibility.set(4, false);
    expect(sameDOMSnapshot(before, after, evidence)).toBe(false);
  });

  it("fails closed for missing frame identity, malformed string indices or unknown protocol fields", () => {
    const before = fixture(), after = fixture();
    after.documents[0]!.frameId = -1;
    expect(sameDOMSnapshot(before, after)).toBe(false);
    after.documents[0]!.frameId = 999;
    expect(sameDOMSnapshot(before, after)).toBe(false);
    const unknown = fixture();
    (unknown.documents[0]!.nodes as any).futureSemanticData = [42];
    expect(sameDOMSnapshot(before, unknown)).toBe(false);
  });
});
