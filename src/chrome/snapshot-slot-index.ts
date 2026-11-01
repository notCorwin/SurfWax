import { createSnapshotDomIndex } from "./snapshot-dom-index";

/** CDP's flattened parent links include slot ancestry even for closed roots. */
export function snapshotSlottedNodes(snapshot: any): Set<number> {
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) throw new Error("Invalid DOM snapshot");
  const result = new Set<number>();
  for (const document of snapshot.documents) {
    const nodes = document.nodes;
    const index = createSnapshotDomIndex(nodes);
    if (!Array.isArray(nodes.nodeName) || nodes.nodeName.length !== nodes.backendNodeId.length) throw new Error("Invalid DOM snapshot names");
    const slots = new Set<number>();
    for (const i of index.preorder) {
      const name = snapshot.strings[nodes.nodeName[i]];
      if (typeof name !== "string") throw new Error("Invalid DOM snapshot name");
      if (name.toUpperCase() === "SLOT") slots.add(i);
    }
    const ancestors = index.nearestMarkedIndexes(slots);
    for (const i of index.preorder) if (ancestors[i] !== -1) {
      const id = index.backendAt(i);
      if (id !== undefined) result.add(id);
    }
  }
  return result;
}
