import type { SnapshotLine } from "./snapshot-frame-tree";
import {
  formatSnapshotItem,
  projectSnapshotNode,
  type ProjectedSnapshotNode,
  type SnapshotBounds,
  type SnapshotBoxRun,
} from "./snapshot-render";
import { normalizeSnapshotText } from "./snapshot-preformatted";

type RenderOptions = Parameters<typeof projectSnapshotNode>[1];
const rounded = (bounds: SnapshotBounds) => bounds.map((value) => Math.round(value * 10) / 10) as unknown as SnapshotBounds;

/** Encode every measured extent, including irregular gaps and visual reordering. */
function boxRuns(members: readonly SnapshotLine[]): SnapshotBoxRun[] {
  const values = members.map((member) => rounded(member.node!.bounds!));
  const parts: SnapshotBoxRun[] = [];
  for (let index = 0; index < values.length;) {
    const first = values[index]!, next = values[index + 1];
    const step = next
      ? ([0, 1, 2, 3] as const).map((coordinate) => next[coordinate]! - first[coordinate]!) as unknown as SnapshotBounds
      : undefined;
    let end = index + 1;
    if (step) while (end < values.length && values[end]!.every((value, coordinate) =>
      value === first[coordinate]! + step[coordinate]! * (end - index))) end += 1;
    if (end - index >= 3) {
      parts.push({ first, step: step!, count: end - index });
      index = end;
    } else {
      parts.push({ box: first });
      index += 1;
    }
  }
  return parts;
}

export function projectSnapshotLine(row: SnapshotLine, options?: RenderOptions): ProjectedSnapshotNode {
  if (!row.node) {
    return { id: row.id, depth: 0, role: "generic", ...(row.line ? { name: row.line } : {}), ...(row.ref ? { ref: row.ref } : {}) };
  }
  if (!row.members) return projectSnapshotNode(row.node, options);
  if (row.members.some((member) => member.node!.depth !== row.node!.depth)) {
    // Batch a single-child path without changing transport identity.
    const fields = options?.fields ?? ["text", "state"];
    return {
      id: row.id,
      path: row.members.map(({ node }) => {
        const { id: _id, ...rest } = projectSnapshotNode({ ...node!, ref: undefined, actions: undefined }, options ?? { fields });
        return rest;
      }),
    };
  }
  const textParts = row.node.role === "StaticText" && !row.node.nameUnknown;
  const projected = projectSnapshotNode({
    ...row.node,
    ...(textParts ? { name: undefined } : {}),
    bounds: undefined,
    ref: undefined,
    actions: undefined,
  }, options);
  const showGeometry = !options?.fields || options.fields.includes("text");
  if (textParts && showGeometry) {
    return {
      ...projected,
      textParts: row.members.map(({ node }) => ({
        text: node!.preserveTextWhitespace || node!.textWhitespaceProven ? node!.name ?? "" : normalizeSnapshotText(node!.name ?? ""),
        box: rounded(node!.bounds!),
      })),
    };
  }
  return {
    ...projected,
    count: row.members.length,
    ...(showGeometry ? { boxes: boxRuns(row.members) } : {}),
  };
}

export function renderSnapshotLine(row: SnapshotLine, options?: RenderOptions): { id: string; line: string; ref?: string } {
  const projected = projectSnapshotLine(row, options);
  return { id: projected.id, line: formatSnapshotItem(projected), ...(projected.ref ? { ref: projected.ref } : {}) };
}

/** Explicit targeting fields expose the original independently validated nodes. */
export function expandSnapshot(lines: readonly SnapshotLine[]): SnapshotLine[] {
  return lines.flatMap((line) => line.members ? [...line.members] : [line]);
}

/** Factor only contiguous sibling leaves. No business grouping or reading order is inferred. */
export function packSnapshot(lines: readonly SnapshotLine[]): SnapshotLine[] {
  const parents: number[] = [], stack: number[] = [], children: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const node = lines[index]!.node;
    if (!node) { parents.push(-1); children.push(0); stack.length = 0; continue; }
    while (stack.length && lines[stack.at(-1)!]!.node!.depth >= node.depth) stack.pop();
    parents.push(stack.at(-1) ?? -1);
    children.push(0);
    if (stack.length) children[stack.at(-1)!]! += 1;
    stack.push(index);
  }
  const key = (index: number): string | undefined => {
    const row = lines[index]!, node = row.node;
    if (!node?.bounds || row.members || node.textFragments || node.childFrameRef || node.documentFrameRef
      || lines[index + 1]?.node && lines[index + 1]!.node!.depth > node.depth) return undefined;
    if (node.role === "StaticText" && !node.nameUnknown && !node.textWhitespaceProven && !node.preserveTextWhitespace
      && node.name !== undefined && node.name !== normalizeSnapshotText(node.name)) return undefined;
    const { id: _id, ref: _ref, bounds: _bounds, name, ...fields } = node;
    if (node.role !== "StaticText" || node.nameUnknown) return JSON.stringify([parents[index], row.sourceParent, fields, name]);
    const { preserveTextWhitespace: _preserve, textWhitespaceProven: _proven, ...common } = fields;
    return JSON.stringify([parents[index], row.sourceParent, common]);
  };
  const result: SnapshotLine[] = [];
  for (let index = 0; index < lines.length;) {
    let endOfChain = index;
    while (children[endOfChain] === 1 && parents[endOfChain + 1] === endOfChain) {
      const current = lines[endOfChain]!, next = lines[endOfChain + 1]!, node = current.node, child = next.node;
      if (!node || !child || current.members || next.members || node.role === "RootWebArea" || child.role === "RootWebArea"
        || node.childFrameRef || node.documentFrameRef || child.childFrameRef || child.documentFrameRef
        || node.layoutScope !== child.layoutScope) break;
      endOfChain += 1;
    }
    if (endOfChain > index) {
      const row = { ...lines[index]!, members: lines.slice(index, endOfChain + 1) };
      result.push({ ...row, line: renderSnapshotLine(row, { fields: ["text", "state"] }).line });
      index = endOfChain + 1; continue;
    }
    const signature = key(index);
    let end = index + 1;
    if (signature !== undefined) while (end < lines.length && key(end) === signature) end += 1;
    const minimum = lines[index]!.node?.role === "StaticText" ? 2 : 3;
    if (end - index < minimum) {
      result.push(lines[index]!); index += 1; continue;
    }
    const row = { ...lines[index]!, members: lines.slice(index, end) };
    result.push({ ...row, line: renderSnapshotLine(row, { fields: ["text", "state"] }).line });
    index = end;
  }
  return result;
}
