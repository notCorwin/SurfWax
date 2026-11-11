import type { SnapshotLine } from "./snapshot-frame-tree";
import type { SnapshotItem } from "./snapshot-pagination";

/** Private, same-capture data; serialized only beside its delivery lease. */
export const SNAPSHOT_CANDIDATE_CONTEXT = Symbol("snapshot-candidate-context");
export type CandidateAssociation = { context: Record<string, unknown>; invalid?: true };

export function semanticContexts(observationId: string, rows: readonly SnapshotLine[], packed: readonly SnapshotLine[], items: readonly SnapshotItem[], capturePartial: boolean): (targetId: string) => Record<string, unknown> {
  const positions = new Map(rows.map((row, index) => [row.id, index]));
  const address = new Map<string, Record<string, unknown>>();
  packed.forEach((row, index) => {
    const item = items[index]!;
    if (!row.members) address.set(row.id, { itemId: item.id });
    else if (item.path) row.members.forEach((member, pathIndex) => address.set(member.id, { itemId: item.id, pathIndex }));
    else if (item.textParts) row.members.forEach((member, textPartIndex) => address.set(member.id, { itemId: item.id, textPartIndex }));
  });
  // Build ancestry and reverse text relations once, without another DOM/AX read.
  // Each text fragment is indexed once. Each label list query examines at most 13 entries.
  type Label = { index: number; value: Record<string, unknown>; bytes?: number };
  type Scope = { labels: Label[]; unknown: Label[]; indices: number[] };
  const scopes = new Map<string | undefined, Scope>();
  const containers: number[] = [], rowAncestors: number[] = [], groupAncestors: number[] = [], ends: number[] = [];
  const invalidPrefix = [0], stack: number[] = [];
  const encoder = new TextEncoder();
  rows.forEach((row, index) => {
    const node = row.node;
    while (stack.length && (!node || rows[stack.at(-1)!]!.node!.depth >= node.depth)) ends[stack.pop()!] = index;
    const parent = stack.at(-1), ancestor = parent === undefined ? undefined : rows[parent]!.node;
    const linked = node && ancestor && node.depth === ancestor.depth + 1 && node.layoutScope === ancestor.layoutScope
      && !ancestor.ownerUnrepresented && ancestor.role !== "RootWebArea";
    rowAncestors[index] = linked ? ancestor.role === "row" || ancestor.role === "listitem" ? parent! : rowAncestors[parent!]! : -1;
    groupAncestors[index] = linked ? ancestor.role === "group" ? parent! : groupAncestors[parent!]! : -1;
    containers[index] = rowAncestors[index]! >= 0 ? rowAncestors[index]! : groupAncestors[index]!;
    const source = address.get(row.id);
    invalidPrefix.push(invalidPrefix[index]! + (!node || !source || node.ownerUnrepresented || node.role === "RootWebArea" ? 1 : 0));
    if (!node) return;
    stack.push(index);
    const scope = scopes.get(node.layoutScope) ?? { labels: [], unknown: [], indices: [] };
    scopes.set(node.layoutScope, scope);
    scope.indices.push(index);
    if (!source || node.ownerUnrepresented || node.role === "RootWebArea") return;
    if (node.nameUnknown || node.valueUnknown || node.role === "StaticText" && node.name && !node.textWhitespaceProven && !node.textFragments?.length)
      scope.unknown.push({ index, value: source, bytes: 0 });
    const fragments = node.textFragments ?? (node.role === "StaticText" && node.textWhitespaceProven && node.name !== undefined ? [{ text: node.name }] : []);
    fragments.forEach((fragment, part) => scope.labels.push({ index,
      value: { ...source, ...(node.textFragments && fragments.length > 1 ? { textPartIndex: part } : {}), text: fragment.text,
        fragment: Boolean(node.nameUnknown), source: node.textFragments ? "textFragments" : "StaticText" } }));
  });
  while (stack.length) ends[stack.pop()!] = rows.length;
  const lower = <T>(values: readonly T[], index: number, key: (value: T) => number) => {
    let low = 0, high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (key(values[middle]!) < index) low = middle + 1; else high = middle; }
    return low;
  };
  const cache = new Map<number, Record<string, unknown>>();
  return targetId => {
    const unknown = (reason: string) => ({ status: "unknown", observationId, reason });
    const target = positions.get(targetId);
    if (target === undefined) return unknown("not-represented");
    const container = containers[target]!;
    if (container < 0 || !address.has(rows[container]!.id)) return unknown("missing-semantic-container");
    let context = cache.get(container);
    if (!context) {
      const parent = rows[container]!.node!, scope = scopes.get(parent.layoutScope)!, end = ends[container]!;
      const labels: Record<string, unknown>[] = [], unknownLabels: Record<string, unknown>[] = [];
      let used = 0, omitted = false;
      for (let i = lower(scope.labels, container, label => label.index); i < scope.labels.length && scope.labels[i]!.index < end; i++) {
        const label = scope.labels[i]!;
        const bytes = label.bytes ??= encoder.encode(label.value.text as string).length;
        if (labels.length >= 12 || used + bytes > 768) { omitted = true; break; }
        used += bytes; labels.push(label.value);
      }
      for (let i = lower(scope.unknown, container, label => label.index); i < scope.unknown.length && scope.unknown[i]!.index < end; i++) {
        if (unknownLabels.length >= 12) { omitted = true; break; }
        unknownLabels.push(scope.unknown[i]!.value);
      }
      const sameScope = lower(scope.indices, end, index => index) - lower(scope.indices, container, index => index);
      const partial = capturePartial || invalidPrefix[end]! > invalidPrefix[container]! || sameScope !== end - container;
      context = !labels.length && !unknownLabels.length
        ? { ...unknown("unknown-visible-labels"), ...(omitted || partial ? { partial: true, ...(omitted ? { labelsOmitted: true } : {}) } : {}) }
        : { status: "verified", observationId, container: { ...address.get(rows[container]!.id), role: parent.role }, visibleLabels: labels,
          partial: partial || omitted || unknownLabels.length > 0, unknownLabels, ...(omitted ? { labelsOmitted: true } : {}) };
      cache.set(container, context);
    }
    return { ...context, snapshotItemId: address.get(targetId)?.itemId };
  };
}

/** Associations are capture observations, never extra executable target IDs. */
export function automaticContexts(items: readonly SnapshotItem[], contextFor: (id: string) => Record<string, unknown>, maxBytes = 3072) {
  const targets: Record<string, unknown>[] = [];
  let omitted = 0;
  const encoder = new TextEncoder();
  for (const item of items) {
    if (!item.actionable || item.change === "removed") continue;
    const pair = { targetId: item.id, context: contextFor(item.id) };
    if (encoder.encode(JSON.stringify({ targets: [...targets, pair], omitted: items.length })).length <= maxBytes) targets.push(pair);
    else omitted++;
  }
  const result = targets.length || omitted ? { targets, ...(omitted ? { omitted } : {}) } : undefined;
  return result && encoder.encode(JSON.stringify(result)).length <= maxBytes ? result : undefined;
}
