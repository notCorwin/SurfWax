import { describe, expect, it } from "vitest";
import { snapshotVisibility, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

// Indexes are deliberately independent of layout indexes, as in CDP snapshots.
function capture(nodes: Array<{ parent: number; bounds?: number[]; client?: number[]; offset?: number[]; scroll?: number[]; opacity?: string; filter?: string; x?: string; y?: string; visibility?: string; content?: string; name?: string; type?: number; position?: string; transform?: string; clipPath?: string; clip?: string; direction?: string; writing?: string; display?: string; font?: string; fill?: string; shadow?: string; stroke?: string; backgroundClip?: string; textTransform?: string; textSecurity?: string; textOverflow?: string; lineClamp?: string; mask?: string; value?: string; text?: string }>, document: { contentWidth?: number; contentHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number } = {}) {
  const strings = ["1", "0", "visible", "hidden", "auto", "clip", "scroll", "IFRAME", "static", "fixed", "absolute", "relative", "none", "matrix(1, 0, 0, 1, 0, 0)", "matrix(0, 1, -1, 0, 0, 0)"];
  const stringId = (value: string) => { const index = strings.indexOf(value); if (index >= 0) return index; return strings.push(value) - 1; };
  const withLayout = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.bounds);
  return { strings, documents: [{ ...document, frameId: stringId("test-frame"), nodes: { backendNodeId: nodes.map((_, i) => i + 1), parentIndex: nodes.map((node) => node.parent), nodeName: nodes.map((node) => stringId(node.name ?? "")), nodeValue: nodes.map((node) => stringId(node.value ?? "")), nodeType: nodes.map((node) => node.type ?? 1) }, layout: {
    nodeIndex: withLayout.map(({ index }) => index), bounds: withLayout.map(({ node }) => node.bounds),
    text: withLayout.map(({ node }) => stringId(node.text ?? node.value ?? "")),
    clientRects: withLayout.map(({ node }) => node.client ?? []), offsetRects: withLayout.map(({ node }) => node.offset ?? []),
    scrollRects: withLayout.map(({ node }) => node.scroll ?? []),
    styles: withLayout.map(({ node }) => [node.opacity ?? "1", node.x ?? "visible", node.y ?? "visible", node.visibility ?? "visible", node.content ?? "visible", node.position ?? "static", node.transform ?? "none", node.filter ?? "none", "none", "none", "auto", "none", "none", "none", "none", node.clipPath ?? "none", node.clip ?? "auto", node.direction ?? "ltr", node.writing ?? "horizontal-tb", node.display ?? "block", node.font ?? "16px", node.fill ?? "rgb(0, 0, 0)", node.shadow ?? "none", node.stroke ?? "0px", node.backgroundClip ?? "border-box", node.textTransform ?? "none", node.textSecurity ?? "none", node.textOverflow ?? "clip", node.lineClamp ?? "none", node.mask ?? "none", "none"].map(stringId)),
  } }] };
}

describe("snapshot visual visibility", () => {
  it("collects only text with potentially invisible glyphs and leaves visibility unchanged until browser evidence arrives", () => {
    const candidates: SnapshotTextPaintCandidate[] = [];
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, type: 3, bounds: [0, 0, 0, 0], font: "0px", value: "Zero" },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "rgba(0, 0, 0, 0)", value: "Transparent" },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "color(display-p3 1 0 0 / 0)", value: "Transparent wide gamut" },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "rgba(0, 0, 0, 0.2)", value: "Translucent" },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "rgba(0, 0, 0, 0)", shadow: "rgb(0, 0, 0) 1px 1px 1px", value: "Shadow" },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", stroke: "1px", value: "Stroke" },
      { parent: 0, bounds: [0, 0, 100, 20], backgroundClip: "text" },
      { parent: 7, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", value: "Gradient" },
      { parent: 0, bounds: [0, 0, 100, 20], filter: "url(#paint)" },
      { parent: 9, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", value: "Filtered" },
      { parent: 0, name: "SVG", bounds: [0, 0, 100, 20] },
      { parent: 11, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", value: "SVG" },
      { parent: 0, bounds: [0, 0, 100, 20], opacity: "0" },
      { parent: 13, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", value: "Already hidden" },
      { parent: 9, type: 3, bounds: [0, 0, 0, 0], font: "0px", value: "Filtered zero" },
      { parent: 11, type: 3, bounds: [0, 0, 0, 0], font: "0px", value: "SVG zero" },
    ]), { textPaintCandidates: candidates });
    expect(candidates.map(({ backendNodeId, frameId }) => [backendNodeId, frameId])).toEqual([[2, "test-frame"], [3, "test-frame"], [4, "test-frame"]]);
    expect(candidates[0]).toMatchObject({ zeroFont: true });
    expect([state.get(2), state.get(3), state.get(4), state.get(15)]).toEqual([true, true, true, false]);
  });

  it("does not mistake a document layout without element styles for an unknown ancestor paint effect", () => {
    const snapshot = capture([
      { parent: -1, name: "#document", type: 9, bounds: [0, 0, 500, 500] },
      { parent: 0, name: "HTML", bounds: [0, 0, 500, 500] },
      { parent: 1, type: 3, bounds: [0, 0, 30, 20], fill: "rgba(0, 0, 0, 0)", value: "Hidden" },
    ]);
    snapshot.documents[0]!.layout.styles[0] = [];
    const candidates: SnapshotTextPaintCandidate[] = [];
    snapshotVisibility(snapshot, { textPaintCandidates: candidates });
    expect(candidates.map(({ backendNodeId }) => backendNodeId)).toEqual([3]);
  });

  it("retains source, rendered text and raw text-box metadata for later range validation", () => {
    const snapshot: any = capture([
      { parent: -1, name: "#document", type: 9, bounds: [0, 0, 500, 500] },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", textTransform: "uppercase", textSecurity: "none", value: "maß", text: "MASS" },
    ], { contentWidth: 500, contentHeight: 500, scrollOffsetX: 0, scrollOffsetY: 0 });
    snapshot.documents[0].textBoxes = { layoutIndex: [1, 1], start: [0, 2], length: [2, 2], bounds: [[0, 0, 20, 20], [20, 0, 20, 20]] };
    const candidates: SnapshotTextPaintCandidate[] = [];
    snapshotVisibility(snapshot, { textPaintCandidates: candidates });
    expect(candidates).toEqual([expect.objectContaining({ sourceText: "maß", layoutText: "MASS", textTransform: "uppercase", textSecurity: "none",
      fullyWithinClip: true, textBoxes: [{ start: 0, length: 2, bounds: [0, 0, 20, 20] }, { start: 2, length: 2, bounds: [20, 0, 20, 20] }] })]);
  });

  it("only proves text is fully within a simple clip when all text-box geometry is accounted for", () => {
    const check = (parent: Parameters<typeof capture>[0][number], bounds = [10, 0, 30, 20], start = 0, length = 4) => {
      const snapshot: any = capture([
        { parent: -1, name: "#document", type: 9, bounds: [0, 0, 500, 500] },
        { ...parent, parent: 0, bounds: [0, 0, 40, 40], x: "hidden", y: "hidden" },
        { parent: 1, type: 3, bounds, fill: "transparent", value: "Text" },
      ], { contentWidth: 500, contentHeight: 500, scrollOffsetX: 0, scrollOffsetY: 0 });
      snapshot.documents[0].textBoxes = { layoutIndex: [2], start: [start], length: [length], bounds: [bounds] };
      const candidates: SnapshotTextPaintCandidate[] = [];
      snapshotVisibility(snapshot, { textPaintCandidates: candidates });
      return candidates[0]?.fullyWithinClip;
    };
    expect(check({ parent: 0 })).toBe(true);
    expect(check({ parent: 0 }, [30, 0, 30, 20])).toBeUndefined();
    // The declaration alone does not truncate a short label: all source
    // graphemes have boxes inside its clip. An overflowing one is uncertain.
    expect(check({ parent: 0, textOverflow: "ellipsis" })).toBe(true);
    expect(check({ parent: 0, textOverflow: "ellipsis" }, [30, 0, 30, 20])).toBeUndefined();
    expect(check({ parent: 0, lineClamp: "1" })).toBeUndefined();
    expect(check({ parent: 0, clipPath: "circle(40%)" })).toBeUndefined();
    expect(check({ parent: 0, mask: "linear-gradient(black, transparent)" })).toBeUndefined();
    expect(check({ parent: 0, transform: "matrix(0, 1, -1, 0, 0, 0)" })).toBeUndefined();
    expect(check({ parent: 0 }, [10, 0, 30, 20], 1, 2)).toBeUndefined();
  });

  it("does not infer hidden glyphs from only one of multiple layouts for the same text node", () => {
    const snapshot = capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, type: 3, bounds: [0, 0, 100, 20], fill: "transparent", value: "Possibly painted" },
    ]);
    const layout = snapshot.documents[0]!.layout;
    layout.nodeIndex.push(1);
    layout.bounds.push([0, 20, 100, 20]);
    layout.styles.push([...layout.styles[1]!]);
    layout.text.push(layout.text[1]!);
    const candidates: SnapshotTextPaintCandidate[] = [];
    snapshotVisibility(snapshot, { textPaintCandidates: candidates });
    expect(candidates).toEqual([expect.objectContaining({ backendNodeId: 2 })]);
    expect(candidates[0]!.fullyWithinClip).toBeUndefined();
  });

  it("collects text-bearing transparent pseudo elements without confusing geometry-only rows", () => {
    const snapshot = capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 200, 20] },
      { parent: 1, name: "::before", bounds: [0, 0, 80, 20], fill: "transparent", text: "Hidden generated" },
      { parent: 1, name: "::after", bounds: [100, 0, 80, 20], text: "Visible generated" },
      { parent: 1, name: "::after", bounds: [100, 0, 80, 20], fill: "transparent", shadow: "black 1px 1px 1px", text: "Visible shadow" },
    ]);
    const layout = snapshot.documents[0]!.layout;
    const pseudo = layout.nodeIndex.indexOf(2);
    layout.nodeIndex.splice(pseudo, 0, 2);
    layout.bounds.splice(pseudo, 0, [...layout.bounds[pseudo]!]);
    layout.styles.splice(pseudo, 0, [...layout.styles[pseudo]!]);
    layout.text.splice(pseudo, 0, snapshot.strings.indexOf(""));
    const candidates: SnapshotTextPaintCandidate[] = [];
    const state = snapshotVisibility(snapshot, { textPaintCandidates: candidates });
    expect(candidates).toEqual([expect.objectContaining({ backendNodeId: 3, frameId: "test-frame", kind: "pseudo", pseudoType: "before",
      sourceText: "Hidden generated", layoutText: "Hidden generated" })]);
    expect(state.get(3)).toBe(true);
  });

  it("identifies a provably painted first-letter prefix and preserves ambiguous cases", () => {
    const candidates: SnapshotTextPaintCandidate[] = [];
    const snapshot = capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 200, 40] },
      { parent: 1, name: "::first-letter", bounds: [0, 0, 10, 20], text: "X" },
      { parent: 1, type: 3, bounds: [10, 0, 120, 20], value: "Xunpainted suffix", text: "unpainted suffix", fill: "transparent" },
      { parent: 0, bounds: [0, 40, 200, 40] },
      { parent: 4, name: "::first-letter", bounds: [0, 40, 10, 20], text: "A" },
      { parent: 4, type: 3, bounds: [10, 40, 120, 20], value: "ambiguous", text: "mbiguous", fill: "transparent" },
    ]);
    // CDP commonly exposes a no-text geometry row and a text row for the
    // same ::first-letter pseudo node.
    const layout = snapshot.documents[0]!.layout;
    const pseudo = layout.nodeIndex.indexOf(2);
    layout.nodeIndex.splice(pseudo, 0, 2);
    layout.bounds.splice(pseudo, 0, [...layout.bounds[pseudo]!]);
    layout.styles.splice(pseudo, 0, [...layout.styles[pseudo]!]);
    layout.text.splice(pseudo, 0, snapshot.strings.indexOf(""));
    snapshotVisibility(snapshot, { textPaintCandidates: candidates });
    expect(candidates).toEqual([
      expect.objectContaining({ backendNodeId: 4, sourceText: "Xunpainted suffix", layoutText: "unpainted suffix", firstLetter: "X" }),
      expect.objectContaining({ backendNodeId: 7, firstLetterUnknown: true }),
    ]);
  });

  it("filters transparent ancestors including descendants with and without layout", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 100, 100], opacity: "0" },
      { parent: 1 },
      { parent: 2, bounds: [0, 0, 20, 20] },
      { parent: 0, bounds: [0, 0, 20, 20] },
    ]));
    expect([...state.values()]).toEqual([true, false, false, false, true]);
  });

  it("filters fully transparent filter output while preserving unknown SVG effects", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "opacity(0%) blur(2px)" },
      { parent: 1, bounds: [0, 0, 20, 20], position: "fixed" },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "opacity(0) url(#flood)" },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "url(#flood) opacity(0)" },
      { parent: 0, bounds: [0, 0, 100, 100], filter: 'url("file opacity(0) value") blur(2px)' },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "opacity(0.01)" },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "opacity(calc(0))" },
      { parent: 0, bounds: [0, 0, 100, 100], filter: "opacity(0) url(#flood) opacity(0) drop-shadow(0px 0px 2px red)" },
    ]));
    expect([...state.values()]).toEqual([true, false, false, true, false, true, true, true, false]);
  });

  it("filters only clip shapes with provably zero area", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "circle(0% at 30% 20%)" },
      { parent: 1, bounds: [0, 0, 20, 20], position: "fixed" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "ellipse(10px 0px at center)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "polygon(evenodd, 0px 0%, 0% 0px, 0px 0px)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "polygon(20px 30%, 20.0px 30%, 20px 30%)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "circle(1px)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "ellipse(1px 2px)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "polygon(0px 0px, 100% 0px, 0px 100%)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "polygon(calc(0px) 0px, 0px 0px, 0px 0px)" },
    ]));
    expect([...state.values()]).toEqual([true, false, false, false, false, false, true, true, true, true]);
  });

  it("filters non-scrollable clipping while preserving offscreen scrollable content", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 0, 0], x: "hidden", y: "hidden" },
      { parent: 1, bounds: [0, 0, 20, 20] },
      { parent: 0, bounds: [0, 0, 20, 20], x: "auto", y: "auto" },
      { parent: 3, bounds: [0, 200, 20, 20] },
      { parent: 0, bounds: [0, 1000, 20, 20] },
    ]));
    expect(state.get(3)).toBe(false);
    expect(state.get(5)).toBe(true);
    expect(state.get(6)).toBe(true);
  });

  it("preserves visible descendants of layoutless containers and allows visibility overrides", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0 },
      { parent: 1, bounds: [0, 0, 20, 20] },
      { parent: 0, bounds: [0, 0, 20, 20], visibility: "hidden" },
      { parent: 3, bounds: [0, 0, 20, 20], visibility: "visible" },
    ]));
    expect([...state.values()]).toEqual([true, true, true, false, true]);
  });

  it("only applies overflow clips that contain positioned descendants", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 20, 20], x: "hidden", y: "hidden" },
      { parent: 1, bounds: [100, 100, 20, 20], position: "fixed" },
      { parent: 1, bounds: [100, 100, 20, 20], position: "absolute" },
      { parent: 0, bounds: [0, 0, 20, 20], x: "hidden", y: "hidden", position: "relative" },
      { parent: 4, bounds: [100, 100, 20, 20], position: "absolute" },
      { parent: 4, bounds: [100, 100, 20, 20], position: "fixed" },
      { parent: 0, bounds: [0, 0, 20, 20], x: "hidden", y: "hidden", transform: "matrix(1, 0, 0, 1, 0, 0)" },
      { parent: 7, bounds: [100, 100, 20, 20], position: "fixed" },
      { parent: 1, bounds: [100, 100, 20, 20], position: "fixed", opacity: "0" },
    ]));
    expect([state.get(3), state.get(4), state.get(6), state.get(7), state.get(9), state.get(10)]).toEqual([true, true, false, true, false, false]);
  });

  it("clips to the client box rather than visible borders", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [8, 8, 20, 20], client: [10, 10, 0, 0], offset: [8, 8, 20, 20], x: "hidden", y: "hidden" },
      { parent: 1, bounds: [18, 18, 20, 20] },
      { parent: 0, bounds: [100, 100, 40, 40], client: [5, 5, 10, 10], offset: [100, 100, 20, 20], x: "hidden", y: "hidden" },
      { parent: 3, bounds: [105, 105, 3, 3] },
      { parent: 3, bounds: [112, 112, 3, 3] },
    ]));
    expect([state.get(3), state.get(5), state.get(6)]).toEqual([false, false, true]);
  });

  it("does not apply an inaccurate axis-aligned client clip to rotated descendants", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [10, 10, 40, 40], transform: "matrix(0, 1, -1, 0, 0, 0)" },
      { parent: 1, bounds: [10, 10, 40, 40], client: [5, 5, 5, 5], offset: [10, 10, 20, 20], x: "hidden", y: "hidden" },
      { parent: 2, bounds: [40, 40, 5, 5] },
    ]));
    expect(state.get(4)).toBe(true);
  });

  it("removes only definitively empty CSS clips, including positioned descendants", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, bounds: [0, 0, 500, 500] },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "inset(50%)" },
      { parent: 1, bounds: [0, 0, 20, 20] },
      { parent: 1, bounds: [200, 0, 20, 20], position: "fixed" },
      { parent: 1, bounds: [0, 0, 20, 20], position: "absolute" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "inset(0px 25% 0px 75% round 4px)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "inset(49%)" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "inset(calc(50% + 1px))" },
      { parent: 0, bounds: [0, 0, 100, 100], clipPath: "circle(0%)" },
      { parent: 0, bounds: [0, 0, 100, 100], clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" },
      { parent: 9, bounds: [200, 0, 20, 20], position: "fixed" },
      { parent: 0, bounds: [0, 0, 100, 100], clip: "rect(0px, 0px, 0px, 0px)" },
      { parent: 0, bounds: [0, 0, 100, 100], clip: "rect(auto, 0px, auto, 0px)", position: "fixed" },
      { parent: 0, bounds: [0, 0, 100, 100], clip: "rect(0px, 20px, 20px, 0px)", position: "absolute" },
    ]));
    expect([...state.values()]).toEqual([true, false, false, false, false, false, true, true, false, false, false, true, false, true]);
  });

  it("uses the document's scroll reachability and retains viewport-fixed and transformed fixed content appropriately", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, name: "#document", bounds: [0, 0, 800, 600] },
      { parent: 0, name: "HTML", bounds: [0, 0, 800, 1800] },
      { parent: 1, name: "BODY", bounds: [0, 0, 2000, 1800] },
      { parent: 2, bounds: [-100, 100, 20, 20], position: "absolute" },
      { parent: 2, bounds: [1800, 1200, 20, 20], position: "absolute" },
      { parent: 2, bounds: [-100, 510, 20, 20], position: "fixed" },
      { parent: 2, bounds: [20, 510, 20, 20], position: "fixed" },
      { parent: 2, bounds: [0, 1200, 100, 100], transform: "matrix(1, 0, 0, 1, 0, 0)" },
      { parent: 7, bounds: [20, 1220, 20, 20], position: "fixed" },
    ], { contentWidth: 2000, contentHeight: 1800, scrollOffsetX: 0, scrollOffsetY: 500 }));
    expect([state.get(4), state.get(5), state.get(6), state.get(7), state.get(9)]).toEqual([false, true, false, true, true]);
  });

  it("uses RTL document bounds and keeps ambiguous writing modes and reversed layout conservative", () => {
    const make = (direction: string, writing = "horizontal-tb", display = "block") => snapshotVisibility(capture([
      { parent: -1, name: "#document", bounds: [0, 0, 800, 600] },
      { parent: 0, name: "HTML", bounds: [0, 0, 800, 600], direction, writing, display },
      { parent: 1, name: "BODY", bounds: [0, 0, 800, 600], direction, writing, display },
      { parent: 2, bounds: [-900, 20, 20, 20], position: "absolute" },
      { parent: 2, bounds: [1100, 20, 20, 20], position: "absolute" },
      { parent: 2, bounds: [-9999, 20, 20, 20], position: "absolute" },
    ], { contentWidth: 1800, contentHeight: 600, scrollOffsetX: 0, scrollOffsetY: 0 }));
    expect([make("ltr").get(4), make("ltr").get(5)]).toEqual([false, true]);
    expect([make("rtl").get(4), make("rtl").get(5)]).toEqual([true, false]);
    expect([make("ltr", "vertical-rl").get(4), make("ltr", "vertical-rl").get(5)]).toEqual([true, true]);
    expect([make("ltr", "horizontal-tb", "flex").get(4), make("ltr", "horizontal-tb", "flex").get(5)]).toEqual([true, true]);
    expect(make("rtl").get(6)).toBe(false);
  });

  it("selects the HTML element, not the html doctype, for document scroll direction", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, name: "#document", type: 9, bounds: [0, 0, 800, 600] },
      { parent: 0, name: "html", type: 10 },
      { parent: 0, name: "HTML", bounds: [0, 0, 800, 600], direction: "rtl" },
      { parent: 2, name: "BODY", bounds: [0, 0, 800, 600], direction: "rtl" },
      { parent: 3, bounds: [-900, 20, 20, 20], position: "absolute" },
      { parent: 3, bounds: [1100, 20, 20, 20], position: "absolute" },
    ], { contentWidth: 1800, contentHeight: 600, scrollOffsetX: 0, scrollOffsetY: 0 }));
    expect([state.get(5), state.get(6)]).toEqual([true, false]);
  });

  it("bounds nested scroll content while retaining both reverse and partial scroll ranges", () => {
    const make = (direction: string, display = "block", current = 0) => snapshotVisibility(capture([
      { parent: -1, name: "#document", bounds: [0, 0, 800, 600] },
      { parent: 0, name: "HTML", bounds: [0, 0, 800, 600] },
      { parent: 1, name: "BODY", bounds: [0, 0, 800, 600] },
      { parent: 2, bounds: [50, 50, 200, 100], client: [0, 0, 200, 100], offset: [50, 50, 200, 100], scroll: [current, 0, 1000, 100], x: "auto", y: "auto", position: "relative", direction, display },
      { parent: 3, bounds: [-700 - current, 70, 20, 20], position: "absolute" },
      { parent: 3, bounds: [750 - current, 70, 20, 20], position: "absolute" },
      { parent: 3, bounds: [-9999, 70, 20, 20], position: "absolute" },
    ], { contentWidth: 800, contentHeight: 600, scrollOffsetX: 0, scrollOffsetY: 0 }));
    expect([make("ltr").get(5), make("ltr").get(6), make("ltr").get(7)]).toEqual([false, true, false]);
    expect([make("rtl").get(5), make("rtl").get(6)]).toEqual([true, false]);
    expect([make("ltr", "flex").get(5), make("ltr", "flex").get(6)]).toEqual([true, true]);
    expect([make("ltr", "block", 200).get(5), make("ltr", "block", 200).get(6)]).toEqual([false, true]);
  });

  it("retains conservative behavior when viewport or scroll geometry is unavailable", () => {
    const state = snapshotVisibility(capture([
      { parent: -1, name: "#document", bounds: [0, 0, 800, 600] },
      { parent: 0, bounds: [-9999, 0, 20, 20], position: "fixed" },
      { parent: 0, bounds: [10, 10, 100, 100], x: "auto", y: "auto" },
      { parent: 2, bounds: [-9999, 0, 20, 20] },
    ]));
    expect([state.get(2), state.get(4)]).toEqual([true, true]);
  });

  it("does not silently accept a failed or incomplete layout capture", () => {
    expect(() => snapshotVisibility({})).toThrow("Invalid DOM snapshot");
    expect(() => snapshotVisibility({ strings: [], documents: [{}] })).toThrow("Invalid DOM snapshot document");
  });

  it("marks a frame without a layout box hidden", () => {
    const state = snapshotVisibility(capture([{ parent: -1, bounds: [0, 0, 500, 500] }, { parent: 0, name: "IFRAME" }, { parent: 0, name: "IFRAME", bounds: [0, 0, 0, 100] }]));
    expect(state.get(2)).toBe(false);
    expect(state.get(3)).toBe(false);
  });
});
