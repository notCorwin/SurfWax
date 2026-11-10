import { describe, expect, it } from "vitest";
import { diffSnapshot } from "./snapshot-pagination";
import { expandSnapshot, packSnapshot, projectSnapshotLine, renderSnapshotLine } from "./snapshot-repeat";
import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode, type SnapshotBounds, type SnapshotBoxRun, type SnapshotNode } from "./snapshot-render";

const row = (node: SnapshotNode) => ({ ...renderSnapshotNode(node), node });
const project = (rows: readonly SnapshotLine[]) => rows.map((item) => projectSnapshotLine(item, { fields: ["text", "state"] }));
const cells = (bounds: readonly SnapshotBounds[]) => bounds.map((box, index) => row({
  id: `cell-${index}`, depth: 1, role: "gridcell", nameUnknown: true,
  bounds: box, layoutScope: "document", ref: `ref-${index}`, actions: ["click"], state: { readonly: false },
}));

function decodeBoxes(runs: readonly SnapshotBoxRun[] | undefined): number[][] {
  return (runs ?? []).flatMap((run) => {
    if ("box" in run) return [[...run.box]];
    return Array.from({ length: run.count }, (_, index) => run.first.map((value, coordinate) =>
      Math.round((value + run.step[coordinate]! * index) * 10) / 10));
  });
}

describe("lossless repeated leaf presentation", () => {
  it("batches a single-child tree path without changing its displayed text or independent targets", () => {
    const input = [row({ id: "heading", depth: 1, role: "heading", name: "Models", bounds: [10, 20, 80, 30] }),
      row({ id: "link", depth: 2, role: "link", name: "Models", ref: "target", bounds: [10, 20, 80, 30] }),
      row({ id: "button", depth: 3, role: "button", name: "Models", ref: "other-target", bounds: [10, 20, 80, 30], state: { pressed: false } })];
    const packed = packSnapshot(input);
    expect(packed).toHaveLength(1);
    expect(packed[0]!.line).toBe(input.map(({ node }) => renderSnapshotNode(node, { fields: ["text", "state"] }).line).join("\n"));
    expect(expandSnapshot(packed)).toEqual(input);
    const changed = [input[0]!, input[1]!, row({ ...input[2]!.node!, state: { pressed: true } })];
    const delta = diffSnapshot(project(packed), project(packSnapshot(changed)));
    expect(delta).toMatchObject([{ id: "heading", change: "updated", path: [expect.anything(), expect.anything(), expect.objectContaining({ state: { pressed: true } })] }]);
  });

  it("keeps separate text boundaries and layout when joining adjacent text rows", () => {
    const input = ["A", " ", "B\u00a0C"].map((name, index) => row({ id: `text-${index}`, depth: 1,
      role: "StaticText", name, textWhitespaceProven: true, bounds: [10 + index * 20, 30, 18, 15] }));
    const packed = packSnapshot(input);
    expect(packed).toHaveLength(1);
    expect(packed[0]!.line).toContain('[text-parts="A" @(10,30,18,15); " " @(30,30,18,15); "B\u00a0C" @(50,30,18,15)]');
    expect(projectSnapshotLine(packed[0]!).textParts).toEqual([
      { text: "A", box: [10, 30, 18, 15] },
      { text: " ", box: [30, 30, 18, 15] },
      { text: "B\u00a0C", box: [50, 30, 18, 15] },
    ]);
    expect(expandSnapshot(packed)).toEqual(input);
  });

  it("preserves all extents, separate targets and a changed member through compact output", () => {
    const input = cells([[10, 20, 11, 11], [25, 20, 11, 11], [40, 20, 11, 11], [60, 20, 11, 11], [45, 20, 11, 11]]);
    const packed = packSnapshot(input);
    expect(packed).toHaveLength(1);
    expect(packed[0]!.line).toContain("[count=5]");
    expect(packed[0]!.line).not.toContain("[ref=");
    const projected = projectSnapshotLine(packed[0]!);
    expect(decodeBoxes(projected.boxes)).toEqual(input.map((item) => item.node!.bounds));
    expect(expandSnapshot(packed)).toEqual(input);
    const moved = input.map((item, index) => index === 3 ? row({ ...item.node!, bounds: [60, 30, 11, 11] }) : item);
    const delta = diffSnapshot(project(packed), project(packSnapshot(moved)));
    expect(delta).toMatchObject([{ id: input[0]!.id, change: "updated" }]);
    expect(decodeBoxes(delta[0]!.boxes)[3]).toEqual([60, 30, 11, 11]);
    expect(renderSnapshotLine(packed[0]!, { fields: ["state"] }).line).not.toContain("boxes=");
  });

  it("does not combine different states, documents, parents or nodes with descendants", () => {
    const input = cells(Array.from({ length: 9 }, (_, index) => [index * 15, 20, 11, 11]));
    input[2] = row({ ...input[2]!.node!, state: { readonly: true } });
    input[5] = row({ ...input[5]!.node!, layoutScope: "child-document" });
    const nested = [row({ id: "left", depth: 0, role: "listitem" }), ...input.slice(0, 2),
      row({ id: "right", depth: 0, role: "listitem" }), ...input.slice(2, 5),
      row({ id: "text", depth: 2, role: "StaticText", name: "Independent label" }), ...input.slice(5)];
    const packed = packSnapshot(nested);
    expect(expandSnapshot(packed)).toEqual(nested);
    expect(packed.find((item) => item.id === input[4]!.id)?.members).toBeUndefined();
    expect(packed.find((item) => item.id === input[5]!.id)?.members).toBeUndefined();
  });
});
