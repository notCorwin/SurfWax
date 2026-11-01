import type { SnapshotDomIndex } from "./snapshot-dom-index";

/** Visual text order within the captured DOM, with CSS ::after after content. */
export function snapshotRenderOrder(index: SnapshotDomIndex, nodeNames: readonly number[], strings: readonly string[]) {
  const children = new Map<number, { content: number[]; after: number[] }>(), roots: number[] = [];
  for (const node of index.preorder) {
    const parent = index.parentAt(node);
    if (parent === undefined) { roots.push(node); continue; }
    const group = children.get(parent) ?? { content: [], after: [] };
    if ((strings[nodeNames[node]!] ?? "").toLowerCase() === "::after") group.after.push(node);
    else group.content.push(node);
    children.set(parent, group);
  }
  const starts = new Int32Array(index.preorder.length), ends = new Int32Array(index.preorder.length);
  const positions = new Map<number, number>(), order: number[] = [], pending = [...roots].reverse();
  while (pending.length) {
    const current = pending.pop()!;
    if (current < 0) { ends[~current] = order.length; continue; }
    starts[current] = order.length; order.push(current);
    const id = index.backendAt(current); if (id !== undefined) positions.set(id, order.length - 1);
    pending.push(~current);
    const group = children.get(current);
    if (group) {
      for (let i = group.after.length - 1; i >= 0; i--) pending.push(group.after[i]!);
      for (let i = group.content.length - 1; i >= 0; i--) pending.push(group.content[i]!);
    }
  }
  return { positions, subtreeRange: (node: number) => Number.isSafeInteger(node) && node >= 0 && node < starts.length
    ? { start: starts[node]!, end: ends[node]! } : undefined };
}
