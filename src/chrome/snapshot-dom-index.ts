/** Parent links and identity fields of one CDP DOMSnapshot document. */
export type SnapshotDomNodes = Readonly<{
  backendNodeId: readonly number[];
  parentIndex: readonly number[];
  nodeType: readonly number[];
  /** CDP marks nodes in a shadow tree, but does not always expose each root. */
  shadowRootType?: Readonly<{ index: readonly number[]; value: readonly number[] }>;
}>;

export type SnapshotDomIndex = Readonly<{
  /** Node indexes in the capture's flattened tree order, parents before children. */
  preorder: readonly number[];
  indexOf(backendNodeId: number): number | undefined;
  backendAt(index: number): number | undefined;
  parentAt(index: number): number | undefined;
  /** Half-open range of indexes into preorder, including the selected node. */
  subtreeRange(index: number): Readonly<{ start: number; end: number }> | undefined;
  /** Inclusive containment in CDP's flattened tree; not a DOM tree-scope check. */
  contains(ancestorBackendNodeId: number, descendantBackendNodeId: number): boolean | undefined;
  /** Document backend ID only when ordinary document scope is provable. */
  documentScope(backendNodeId: number): number | undefined;
  /** Closest marked proper ancestor index, or -1, computed once in O(n). */
  nearestMarkedAncestors(markedBackendNodeIds: ReadonlySet<number>): Int32Array;
  /** As above, accepting node indexes so layoutless nodes need no backend ID. */
  nearestMarkedIndexes(markedNodeIndexes: ReadonlySet<number>): Int32Array;
}>;

/**
 * Build a validated O(n)-space index without materializing ancestor lists.
 * CDP can flatten shadow trees without identifying nested shadow-root boundaries;
 * a shadow-marked node and its descendants therefore have unknown scope here.
 */
export function createSnapshotDomIndex(nodes: SnapshotDomNodes): SnapshotDomIndex {
  const ids = nodes?.backendNodeId, parents = nodes?.parentIndex, types = nodes?.nodeType;
  if (!Array.isArray(ids) || !Array.isArray(parents) || !Array.isArray(types)
    || parents.length !== ids.length || types.length !== ids.length || ids.length > 0x7fffffff)
    throw new Error("Invalid DOM snapshot node arrays");
  const length = ids.length;
  const byBackend = new Map<number, number>();
  const firstChild = new Int32Array(length).fill(-1), nextSibling = new Int32Array(length).fill(-1);
  const starts = new Int32Array(length).fill(-1), ends = new Int32Array(length).fill(-1);
  const scope = new Int32Array(length).fill(-1), roots: number[] = [];
  const shadow = new Uint8Array(length);
  if (nodes.shadowRootType !== undefined) {
    const sparse = nodes.shadowRootType;
    if (!Array.isArray(sparse?.index) || !Array.isArray(sparse?.value) || sparse.index.length !== sparse.value.length)
      throw new Error("Invalid DOM snapshot shadow scope");
    for (let i = 0; i < sparse.index.length; i++) {
      const index = sparse.index[i], value = sparse.value[i];
      if (!Number.isSafeInteger(index) || index! < 0 || index! >= length || shadow[index!] || !Number.isSafeInteger(value) || value! < 0)
        throw new Error("Invalid DOM snapshot shadow scope");
      shadow[index!] = 1;
    }
  }
  for (let i = 0; i < length; i++) {
    const id = ids[i], parent = parents[i];
    if (Number.isSafeInteger(id) && id! > 0) {
      if (byBackend.has(id!)) throw new Error("Duplicate DOM snapshot backend node");
      byBackend.set(id!, i);
    }
    if (!Number.isSafeInteger(parent) || parent! < -1 || parent! >= length || parent === i)
      throw new Error("Invalid DOM snapshot ancestry");
    if (parent === -1) roots.push(i);
    else { nextSibling[i] = firstChild[parent!]!; firstChild[parent!] = i; }
  }
  const preorder: number[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const current = stack.pop()!;
    if (current < 0) { ends[~current] = preorder.length; continue; }
    if (starts[current] !== -1) throw new Error("Invalid DOM snapshot ancestry");
    starts[current] = preorder.length;
    preorder.push(current);
    const parent = parents[current]!;
    if (!shadow[current]) {
      if (parent === -1 && types[current] === 9) scope[current] = current;
      else if (parent !== -1) scope[current] = scope[parent]!;
    }
    stack.push(~current);
    // Children were linked in reverse input order, so stack insertion restores it.
    for (let child = firstChild[current]!; child !== -1; child = nextSibling[child]!) stack.push(child);
  }
  // A parent cycle has no path to any root and is never visited.
  if (preorder.length !== length) throw new Error("Invalid DOM snapshot ancestry");
  const validIndex = (index: number) => Number.isSafeInteger(index) && index >= 0 && index < length;
  const nearestMarked = (isMarked: (index: number) => boolean) => {
    const nearest = new Int32Array(length).fill(-1);
    for (const index of preorder) {
      const parent = parents[index]!;
      if (parent !== -1) nearest[index] = isMarked(parent) ? parent : nearest[parent]!;
    }
    return nearest;
  };
  return {
    preorder,
    indexOf: (id) => byBackend.get(id),
    backendAt: (index) => validIndex(index) && Number.isSafeInteger(ids[index]) && ids[index]! > 0 ? ids[index] : undefined,
    parentAt: (index) => validIndex(index) && parents[index] !== -1 ? parents[index] : undefined,
    subtreeRange: (index) => validIndex(index) ? { start: starts[index]!, end: ends[index]! } : undefined,
    contains(ancestorId, descendantId) {
      const ancestor = byBackend.get(ancestorId), descendant = byBackend.get(descendantId);
      if (ancestor === undefined || descendant === undefined) return undefined;
      return starts[ancestor]! <= starts[descendant]! && starts[descendant]! < ends[ancestor]!;
    },
    documentScope(id) {
      const index = byBackend.get(id);
      if (index === undefined || scope[index] === -1) return undefined;
      const documentId = ids[scope[index]!]!;
      return Number.isSafeInteger(documentId) && documentId > 0 ? documentId : undefined;
    },
    nearestMarkedAncestors(marked) {
      return nearestMarked((index) => marked.has(ids[index]!));
    },
    nearestMarkedIndexes: (marked) => nearestMarked((index) => marked.has(index)),
  };
}
