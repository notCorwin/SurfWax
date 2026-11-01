import { describe, expect, it } from "vitest";
import { sameDOMSnapshot } from "./snapshot-consistency";
import { snapshotVisibility, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

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

describe("DOM snapshot consistency", () => {
  it("compares string values rather than string-table indexes", () => {
    expect(sameDOMSnapshot(fixture(), fixture(true))).toBe(true);
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
