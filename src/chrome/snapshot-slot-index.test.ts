import { describe, expect, it } from "vitest";
import { snapshotSlottedNodes } from "./snapshot-slot-index";

describe("flattened slot ancestry", () => {
  it("marks descendants of nested slots regardless of open or closed shadow scope", () => {
    const snapshot = { strings: ["#document", "HTML", "DIV", "SLOT", "IFRAME", "INPUT", "closed"], documents: [{ nodes: {
      backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8], parentIndex: [-1, 0, 1, 2, 3, 4, 5, 1],
      nodeType: [9, 1, 1, 1, 1, 1, 1, 1], nodeName: [0, 1, 2, 3, 3, 4, 5, 5],
      shadowRootType: { index: [3], value: [6] },
    } }] };
    expect([...snapshotSlottedNodes(snapshot)].sort()).toEqual([5, 6, 7]);
  });

  it("rejects malformed node names instead of guessing ancestry", () => {
    expect(() => snapshotSlottedNodes({ strings: [], documents: [{ nodes: {
      backendNodeId: [1], parentIndex: [-1], nodeType: [9], nodeName: [0],
    } }] })).toThrow("Invalid DOM snapshot name");
  });
});
