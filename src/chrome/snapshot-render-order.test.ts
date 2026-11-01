import { describe, expect, it } from "vitest";
import { createSnapshotDomIndex } from "./snapshot-dom-index";
import { snapshotRenderOrder } from "./snapshot-render-order";

describe("snapshot render order", () => {
  it("places each ::after after its own content while preserving subtree ranges", () => {
    // CDP reports pseudo-elements before the ordinary content of each parent.
    const index = createSnapshotDomIndex({ backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8],
      parentIndex: [-1, 0, 1, 1, 1, 4, 4, 4], nodeType: [9, 1, 1, 1, 1, 1, 1, 3] });
    const order = snapshotRenderOrder(index, [0, 1, 2, 3, 4, 2, 3, 5], ["#document", "BUTTON", "::before", "::after", "SPAN", "#text"]);
    expect([...order.positions.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual([1, 2, 3, 5, 6, 8, 7, 4]);
    expect(order.subtreeRange(1)).toEqual({ start: 1, end: 8 });
    expect(order.subtreeRange(4)).toEqual({ start: 3, end: 7 });
    expect(order.subtreeRange(3)).toEqual({ start: 7, end: 8 });
    expect(index.contains(2, 8)).toBe(true);
    expect(index.contains(5, 4)).toBe(false);
  });
});
