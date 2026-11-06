import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode, type SnapshotNode } from "./snapshot-render";
import { packSnapshot } from "./snapshot-repeat";
import { normalizeSnapshotText } from "./snapshot-preformatted";

const neutralRoles = new Set(["generic", "none", "presentation"]);
const namedRoles = new Set([
  "button", "link", "heading", "checkbox", "radio", "switch", "tab", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);
const normalize = normalizeSnapshotText;

/** An empty attribute is not evidence of an independently rendered state. */
function hasDetails(node: SnapshotNode): boolean {
  return Boolean(node.nameUnknown || node.value || node.valueUnknown || node.preserveTextWhitespace
    || node.selectedLabels?.length || node.placeholder || node.childFrameRef || node.documentFrameRef
    || Object.values(node.state ?? {}).some((value) => value !== undefined));
}

function passive(node: SnapshotNode, line: SnapshotLine): boolean {
  return !hasDetails(node) && !node.ref && !line.ref && !node.actions?.length;
}

function emptyNeutral(node: SnapshotNode, line: SnapshotLine): boolean {
  if (!neutralRoles.has(node.role) || normalize(node.name ?? "") || hasDetails(node)) return false;
  // A zero-area element can still receive events from painted overflow. Its
  // action/state semantics cannot be replaced by a descendant image.
  return passive(node, line);
}

/**
 * Compact verified content without inferring groups, visual order or names.
 * Internal identities and unstructured rows survive unchanged. Each plain
 * text leaf belongs to at most one named parent, so deep wrappers do not copy
 * descendant lists or repeatedly walk ancestor chains.
 */
export function compactSnapshot(lines: readonly SnapshotLine[]): SnapshotLine[] {
  const entries: Array<{
    line: SnapshotLine; node: SnapshotNode; parent: number; children: number[];
    remove: boolean; owner: number; depth: number;
  } | undefined> = [];
  const stack: number[] = [];
  const labels = new Map<number, { text: string; leaves: number[]; blocked: boolean }>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!, node = line.node;
    if (!node) { entries.push(undefined); stack.length = 0; continue; }
    while (stack.length && entries[stack[stack.length - 1]!]!.node.depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1] ?? -1;
    const entry = { line, node, parent, children: [] as number[], remove: false, owner: -1, depth: node.depth };
    entries.push(entry);
    if (parent !== -1) entries[parent]!.children.push(index);
    stack.push(index);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const { node, line, parent } = entry;
    const neutral = emptyNeutral(node, line);
    const paragraph = node.role === "paragraph" && !normalize(node.name ?? "") && passive(node, line)
      && entry.children.length === 1 && entries[entry.children[0]!]!.node.role === "StaticText";
    // The first row of a selected region may itself be a neutral wrapper.
    entry.remove = parent !== -1 && (neutral || paragraph);

    const inherited = parent === -1 ? -1 : entries[parent]!.owner;
    const label = normalize(node.name ?? "");
    const namedOwner = namedRoles.has(node.role) || node.role === "generic" && Boolean(node.ref || line.ref) && !node.state?.editable;
    if (namedOwner && label && !node.nameUnknown && !node.preserveTextWhitespace) {
      if (inherited !== -1) labels.get(inherited)!.blocked = true;
      labels.set(index, { text: label, leaves: [], blocked: false });
      entry.owner = index;
      continue;
    }
    if (inherited === -1) continue;
    if (node.role === "StaticText" && (label || node.textWhitespaceProven && node.name) && passive(node, line) && !entry.children.length) {
      // Raw layout.text may still contain source indentation. A repeated
      // normalized label does not prove those fragment boundaries were painted.
      if (!node.textWhitespaceProven && node.name !== normalize(node.name!)) labels.get(inherited)!.blocked = true;
      labels.get(inherited)!.leaves.push(index);
    } else if (neutral) {
      entry.owner = inherited;
    } else if (node.role !== "image" || entry.children.length || node.ref || line.ref || node.actions?.length) {
      // A named child control, paragraph break, unknown/preformatted text or
      // other semantic row is not part of a plain repeated parent label.
      labels.get(inherited)!.blocked = true;
    }
  }

  for (const [owner, label] of labels) {
    if (label.blocked || !label.leaves.length) continue;
    const texts = label.leaves.map((index) => entries[index]!.node.name!);
    if (normalize(texts.join("")) === label.text) {
      // Fold evidence into the parent rather than discarding it: depth-limited
      // output still contains all label text, and movement relative to images
      // or other fragments changes the parent row even if its box is unchanged.
      const parent = entries[owner]!;
      parent.node = { ...parent.node, textFragments: label.leaves.map((index) => {
        const node = entries[index]!.node;
        return { text: node.name!, ...(node.bounds ? { bounds: node.bounds } : {}) };
      }) };
      parent.line = { ...parent.line, node: parent.node, line: renderSnapshotNode(parent.node).line };
      for (const index of label.leaves) entries[index]!.remove = true;
    }
  }

  const result: SnapshotLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const entry = entries[index];
    if (!entry) { result.push(lines[index]!); continue; }
    if (entry.parent !== -1) {
      const parent = entries[entry.parent]!;
      entry.depth = entry.node.depth + parent.depth - parent.node.depth - (parent.remove ? 1 : 0);
    }
    if (entry.remove) continue;
    const node = entry.depth === entry.node.depth ? entry.node : { ...entry.node, depth: entry.depth };
    const removedParent = entry.parent !== -1 && entries[entry.parent]!.remove;
    result.push({ ...entry.line, ...(removedParent ? { sourceParent: entries[entry.parent]!.line.id } : {}), node,
      line: renderSnapshotNode(node, { fields: ["text", "state"] }).line });
  }
  return packSnapshot(result);
}
