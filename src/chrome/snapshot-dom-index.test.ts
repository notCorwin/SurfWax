import { describe, expect, it } from "vitest";
import { createSnapshotDomIndex } from "./snapshot-dom-index";

describe("snapshot DOM ancestry index", () => {
  it("indexes a tree in linear space even when parent indexes are not ordered", () => {
    const index = createSnapshotDomIndex({ backendNodeId: [13, 10, 14, 12, 15, 11],
      parentIndex: [3, -1, 1, 5, 0, 1], nodeType: [1, 9, 1, 1, 3, 1] });
    expect(index.preorder.map((i) => index.backendAt(i))).toEqual([10, 14, 11, 12, 13, 15]);
    const twelve = index.indexOf(12)!, thirteen = index.indexOf(13)!;
    expect(index.parentAt(thirteen)).toBe(twelve);
    expect(index.subtreeRange(twelve)).toEqual({ start: 3, end: 6 });
    expect(index.contains(12, 15)).toBe(true);
    expect(index.contains(12, 12)).toBe(true);
    expect(index.contains(14, 15)).toBe(false);
    expect(index.contains(12, 999)).toBeUndefined();
    expect(index.documentScope(15)).toBe(10);
    const nearest = index.nearestMarkedAncestors(new Set([10, 12]));
    expect(index.backendAt(nearest[index.indexOf(14)!]!)).toBe(10);
    expect(index.backendAt(nearest[index.indexOf(15)!]!)).toBe(12);
    expect(nearest[twelve]).toBe(index.indexOf(10));
    expect(nearest[index.indexOf(10)!]).toBe(-1);
  });

  it("does not invent shadow root boundaries when nested roots have the same CDP type", () => {
    // A real CDP capture can flatten two nested open roots without a root node.
    const index = createSnapshotDomIndex({ backendNodeId: [1, 2, 3, 4, 5, 6],
      parentIndex: [-1, 0, 1, 2, 3, 0], nodeType: [9, 1, 1, 1, 3, 1],
      shadowRootType: { index: [2, 3, 4], value: [0, 0, 0] } });
    expect(index.documentScope(1)).toBe(1);
    expect(index.documentScope(2)).toBe(1);
    expect(index.documentScope(6)).toBe(1);
    for (const id of [3, 4, 5]) expect(index.documentScope(id)).toBeUndefined();
    expect(index.contains(2, 5)).toBe(true); // Flattened ancestry, not tree scope.
    // Missing descendant markers must not make a shadow descendant look like document scope.
    const sparse = createSnapshotDomIndex({ backendNodeId: [1, 2, 3, 4], parentIndex: [-1, 0, 1, 2],
      nodeType: [9, 1, 1, 1], shadowRootType: { index: [2], value: [0] } });
    expect(sparse.documentScope(4)).toBeUndefined();
  });

  it("rejects invalid ancestry, duplicate identities and malformed shadow metadata", () => {
    const nodes = { backendNodeId: [1, 2, 3], parentIndex: [-1, 0, 1], nodeType: [9, 1, 1] };
    expect(() => createSnapshotDomIndex({ ...nodes, parentIndex: [-1, 2, 1] })).toThrow("ancestry");
    expect(() => createSnapshotDomIndex({ ...nodes, parentIndex: [-1, 0, 9] })).toThrow("ancestry");
    expect(() => createSnapshotDomIndex({ ...nodes, backendNodeId: [1, 2, 2] })).toThrow("Duplicate");
    expect(() => createSnapshotDomIndex({ ...nodes, shadowRootType: { index: [1, 1], value: [0, 0] } })).toThrow("shadow scope");
    expect(() => createSnapshotDomIndex({ ...nodes, shadowRootType: { index: [3], value: [0] } })).toThrow("shadow scope");
  });

  it("handles a deep tree without allocating per-node ancestor arrays", () => {
    const count = 25_000;
    const nodes = { backendNodeId: Array.from({ length: count }, (_, i) => i + 1),
      parentIndex: Array.from({ length: count }, (_, i) => i - 1),
      nodeType: Array.from({ length: count }, (_, i) => i ? 1 : 9) };
    const index = createSnapshotDomIndex(nodes);
    expect(index.preorder).toHaveLength(count);
    expect(index.contains(1, count)).toBe(true);
    expect(index.contains(count, 1)).toBe(false);
    expect(index.subtreeRange(4_000)).toEqual({ start: 4_000, end: count });
    expect(index.documentScope(count)).toBe(1);
    const nearest = index.nearestMarkedAncestors(new Set([1, 5_000]));
    expect(nearest).toHaveLength(count);
    expect(index.backendAt(nearest[count - 1]!)).toBe(5_000);
    expect(index).not.toHaveProperty("ancestors");
  });
});
