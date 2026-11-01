import { describe, expect, it } from "vitest";
import { snapshotVisibility } from "./snapshot-visibility";

// Indexes are deliberately independent of layout indexes, as in CDP snapshots.
function capture(nodes: Array<{ parent: number; bounds?: number[]; client?: number[]; offset?: number[]; scroll?: number[]; opacity?: string; x?: string; y?: string; visibility?: string; content?: string; name?: string; type?: number; position?: string; transform?: string; clipPath?: string; clip?: string; direction?: string; writing?: string; display?: string }>, document: { contentWidth?: number; contentHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number } = {}) {
  const strings = ["1", "0", "visible", "hidden", "auto", "clip", "scroll", "IFRAME", "static", "fixed", "absolute", "relative", "none", "matrix(1, 0, 0, 1, 0, 0)", "matrix(0, 1, -1, 0, 0, 0)"];
  const stringId = (value: string) => { const index = strings.indexOf(value); if (index >= 0) return index; return strings.push(value) - 1; };
  const withLayout = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.bounds);
  return { strings, documents: [{ ...document, nodes: { backendNodeId: nodes.map((_, i) => i + 1), parentIndex: nodes.map((node) => node.parent), nodeName: nodes.map((node) => stringId(node.name ?? "")), nodeType: nodes.map((node) => node.type ?? 1) }, layout: {
    nodeIndex: withLayout.map(({ index }) => index), bounds: withLayout.map(({ node }) => node.bounds),
    clientRects: withLayout.map(({ node }) => node.client ?? []), offsetRects: withLayout.map(({ node }) => node.offset ?? []),
    scrollRects: withLayout.map(({ node }) => node.scroll ?? []),
    styles: withLayout.map(({ node }) => [node.opacity ?? "1", node.x ?? "visible", node.y ?? "visible", node.visibility ?? "visible", node.content ?? "visible", node.position ?? "static", node.transform ?? "none", "none", "none", "none", "auto", "none", "none", "none", "none", node.clipPath ?? "none", node.clip ?? "auto", node.direction ?? "ltr", node.writing ?? "horizontal-tb", node.display ?? "block"].map(stringId)),
  } }] };
}

describe("snapshot visual visibility", () => {
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
    expect([...state.values()]).toEqual([true, false, false, false, false, false, true, true, true, false, false, true, false, true]);
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
