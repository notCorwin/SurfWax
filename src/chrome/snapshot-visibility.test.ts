import { describe, expect, it } from "vitest";
import { snapshotVisibility } from "./snapshot-visibility";

// Indexes are deliberately independent of layout indexes, as in CDP snapshots.
function capture(nodes: Array<{ parent: number; bounds?: number[]; client?: number[]; offset?: number[]; opacity?: string; x?: string; y?: string; visibility?: string; content?: string; name?: string; position?: string; transform?: string }>) {
  const strings = ["1", "0", "visible", "hidden", "auto", "clip", "scroll", "IFRAME", "static", "fixed", "absolute", "relative", "none", "matrix(1, 0, 0, 1, 0, 0)", "matrix(0, 1, -1, 0, 0, 0)"];
  const stringId = (value: string) => strings.indexOf(value);
  const withLayout = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.bounds);
  return { strings, documents: [{ nodes: { backendNodeId: nodes.map((_, i) => i + 1), parentIndex: nodes.map((node) => node.parent), nodeName: nodes.map((node) => stringId(node.name ?? "")) }, layout: {
    nodeIndex: withLayout.map(({ index }) => index), bounds: withLayout.map(({ node }) => node.bounds),
    clientRects: withLayout.map(({ node }) => node.client ?? []), offsetRects: withLayout.map(({ node }) => node.offset ?? []),
    styles: withLayout.map(({ node }) => [node.opacity ?? "1", node.x ?? "visible", node.y ?? "visible", node.visibility ?? "visible", node.content ?? "visible", node.position ?? "static", node.transform ?? "none", "none", "none", "none", "auto", "none", "none", "none", "none"].map(stringId)),
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
