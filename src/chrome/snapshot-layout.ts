import type { SnapshotBounds } from "./snapshot-render";

/** Reuse the frozen capture; never query live geometry separately per element. */
export function snapshotBounds(document: any): Map<number, SnapshotBounds> {
  const result = new Map<number, SnapshotBounds>();
  const layout = document.layout, ids = document.nodes?.backendNodeId;
  if (!Array.isArray(layout?.nodeIndex) || !Array.isArray(ids)) return result;
  const scrollX = document.scrollOffsetX ?? 0, scrollY = document.scrollOffsetY ?? 0;
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return result;
  for (let index = 0; index < layout.nodeIndex.length; index += 1) {
    const id = ids[layout.nodeIndex[index]], bounds = layout.bounds?.[index];
    if (!Number.isSafeInteger(id) || !Array.isArray(bounds) || bounds.length !== 4
      || !bounds.every(Number.isFinite) || bounds[2] < 0 || bounds[3] < 0) continue;
    const next: SnapshotBounds = [bounds[0] - scrollX, bounds[1] - scrollY, bounds[2], bounds[3]];
    const prior = result.get(id);
    if (!prior) result.set(id, next);
    else {
      const x = Math.min(prior[0], next[0]), y = Math.min(prior[1], next[1]);
      result.set(id, [x, y, Math.max(prior[0] + prior[2], next[0] + next[2]) - x,
        Math.max(prior[1] + prior[3], next[1] + next[3]) - y]);
    }
  }
  return result;
}
