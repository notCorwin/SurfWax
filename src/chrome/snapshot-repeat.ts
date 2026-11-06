import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode, type SnapshotBounds } from "./snapshot-render";
import { normalizeSnapshotText } from "./snapshot-preformatted";

type RenderOptions = Parameters<typeof renderSnapshotNode>[1];
const rounded = (bounds: SnapshotBounds) => bounds.map((value) => Math.round(value * 10));
const tuple = (values: readonly number[]) => `(${values.map((value) => value / 10).join(",")})`;

/** Encode every measured extent, including irregular gaps and visual reordering. */
function boxes(members: readonly SnapshotLine[]): string {
  const values = members.map((member) => rounded(member.node!.bounds!));
  const parts: string[] = [];
  for (let index = 0; index < values.length;) {
    const first = values[index]!, next = values[index + 1];
    const step = next?.map((value, coordinate) => value - first[coordinate]!);
    let end = index + 1;
    if (step) while (end < values.length && values[end]!.every((value, coordinate) =>
      value === first[coordinate]! + step[coordinate]! * (end - index))) end += 1;
    if (end - index >= 3) {
      parts.push(`${tuple(first)} step=${tuple(step!)} count=${end - index}`);
      index = end;
    } else {
      parts.push(tuple(first));
      index += 1;
    }
  }
  return parts.join("; ");
}

export function renderSnapshotLine(row: SnapshotLine, options?: RenderOptions): ReturnType<typeof renderSnapshotNode> {
  if (!row.node) return { id: row.id, line: row.line, ...(row.ref ? { ref: row.ref } : {}) };
  if (!row.members) return renderSnapshotNode(row.node, options);
  if (row.members.some((member) => member.node!.depth !== row.node!.depth)) {
    // Batch a single-child path without changing any displayed tree line.
    // Row IDs remain patch transport, never handles for the contained nodes.
    return { id: row.id, line: row.members.map(({ node }) => renderSnapshotNode({ ...node!, ref: undefined, actions: undefined },
      options ?? { fields: ["text", "state"] }).line).join("\n") };
  }
  const textParts = row.node.role === "StaticText" && !row.node.nameUnknown;
  const rendered = renderSnapshotNode({ ...row.node, ...(textParts ? { name: undefined } : {}), bounds: undefined, ref: undefined, actions: undefined }, options);
  const showGeometry = !options?.fields || options.fields.includes("text");
  if (textParts && showGeometry) return { id: row.id, line: `${rendered.line} [text-parts=${row.members.map(({ node }) =>
    `${JSON.stringify(node!.preserveTextWhitespace || node!.textWhitespaceProven ? node!.name ?? "" : normalizeSnapshotText(node!.name ?? ""))} @${tuple(rounded(node!.bounds!))}`).join("; ")}]` };
  return { id: row.id, line: `${rendered.line} [count=${row.members.length}]${showGeometry ? ` [boxes=${boxes(row.members)}]` : ""}` };
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
