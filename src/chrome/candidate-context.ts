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
  return targetId => {
    const unknown = (reason: string) => ({ status: "unknown", observationId, reason });
    const target = positions.get(targetId);
    if (target === undefined) return unknown("not-represented");
    let partial = capturePartial;
    // Depth is capture structure, never visual order. Missing ancestors and
    // document boundaries terminate the relationship rather than guessing it.
    let depth = rows[target]!.node!.depth, group = -1, container = -1;
    const scope = rows[target]!.node!.layoutScope;
    for (let i = target - 1; i >= 0; i--) {
      const node = rows[i]!.node;
      if (!node || node.depth >= depth) continue;
      if (node.depth !== depth - 1 || node.layoutScope !== scope || node.ownerUnrepresented || node.role === "RootWebArea") break;
      depth = node.depth;
      if (node.role === "row" || node.role === "listitem") { container = i; break; }
      if (group < 0 && node.role === "group") group = i;
    }
    if (container < 0) container = group;
    if (container < 0 || !address.has(rows[container]!.id)) return unknown("missing-semantic-container");
    const labels: Record<string, unknown>[] = [], unknownLabels: Record<string, unknown>[] = [];
    let used = 0, omitted = false;
    const parent = rows[container]!.node!;
    for (let i = container; i < rows.length; i++) {
      const row = rows[i]!, node = row.node;
      if (!node || i > container && node.depth <= parent.depth) break;
      if (node.layoutScope !== scope || node.ownerUnrepresented || node.role === "RootWebArea") { partial = true; continue; }
      const source = address.get(row.id);
      if (!source) { partial = true; continue; }
      if (node.nameUnknown || node.valueUnknown || node.role === "StaticText" && node.name && !node.textWhitespaceProven && !node.textFragments?.length) {
        if (unknownLabels.length < 12) unknownLabels.push(source);
        else omitted = true;
      }
      // textFragments are paint-proven folded text. A StaticText name is
      // accepted only with the capture's explicit DOMSnapshot text proof.
      const fragments = node.textFragments ?? (node.role === "StaticText" && node.textWhitespaceProven && node.name !== undefined ? [{ text: node.name }] : []);
      fragments.forEach((fragment, index) => {
        const bytes = new TextEncoder().encode(fragment.text).length;
        if (labels.length >= 12 || used + bytes > 768) { omitted = true; return; }
        used += bytes;
        labels.push({ ...source, ...(node.textFragments && fragments.length > 1 ? { textPartIndex: index } : {}), text: fragment.text, fragment: Boolean(node.nameUnknown), source: node.textFragments ? "textFragments" : "StaticText" });
      });
    }
    if (!labels.length && !unknownLabels.length) return { ...unknown("unknown-visible-labels"), ...(omitted ? { partial: true, labelsOmitted: true } : {}) };
    return { status: "verified", observationId, snapshotItemId: address.get(targetId)?.itemId,
      container: { ...address.get(rows[container]!.id), role: parent.role }, visibleLabels: labels,
      partial: partial || omitted || unknownLabels.length > 0, unknownLabels, ...(omitted ? { labelsOmitted: true } : {}) };
  };
}
