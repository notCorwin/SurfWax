import { describe, expect, it } from "vitest";
import { applySnapshotOcclusion } from "./snapshot-occlusion";

function capture() {
  const strings: string[] = [];
  const intern = (value: string) => { const index = strings.indexOf(value); return index < 0 ? strings.push(value) - 1 : index; };
  const style = (background = "rgba(0, 0, 0, 0)", position = "static") => {
    const fields = Array(42).fill("");
    fields[0] = "1"; fields[1] = fields[2] = fields[3] = "visible"; fields[5] = position;
    for (const index of [6, 7, 8, 11, 12, 13, 14, 15, 29, 30]) fields[index] = "none";
    fields[9] = "none"; fields[10] = "auto"; fields[16] = "auto"; fields[22] = "none"; fields[23] = "0px"; fields[24] = "border-box"; fields[34] = background; fields[35] = "0px"; fields[36] = "normal"; fields[37] = fields[38] = "none"; fields[39] = position === "absolute" ? "1" : "auto"; fields[40] = "auto"; fields[41] = "normal";
    return fields.map(intern);
  };
  return { strings, documents: [{ nodes: { backendNodeId: [1, 2, 3, 4, 5], nodeType: [9, 1, 1, 3, 1], parentIndex: [-1, 0, 1, 2, 1] },
    layout: { nodeIndex: [0, 1, 2, 3, 4], bounds: [[0, 0, 800, 600], [0, 0, 800, 600], [20, 120, 100, 24], [22, 122, 90, 20], [0, 100, 400, 160]],
      paintOrders: [0, 1, 2, 2, 3], styles: [[], style(), style(), style(), style("rgb(22, 22, 22)", "absolute")] } }] };
}

describe("snapshot opaque coverage", () => {
  it("withholds a partially covered text node without hiding its partially visible control", () => {
    const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
    snapshot.documents[0]!.layout.bounds[4] = [0, 100, 60, 160];
    applySnapshotOcclusion(snapshot, visible);
    expect(visible.get(3)).toBe(true);
    expect(visible.get(4)).toBe(false);
  });
  it("detects a partial cover in a different spatial cell from the text's start", () => {
    const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
    snapshot.documents[0]!.layout.bounds[3] = [22, 122, 240, 20];
    snapshot.documents[0]!.layout.bounds[4] = [200, 100, 30, 160];
    applySnapshotOcclusion(snapshot, visible);
    expect(visible.get(4)).toBe(false);
  });
  it.each(["cover", "ancestor"])("does not mistake a negative %s stacking context for foreground paint", (where) => {
    const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
    const styles = snapshot.documents[0]!.layout.styles;
    const negative = snapshot.strings.push("-1") - 1;
    if (where === "cover") styles[4]![39] = negative;
    else { styles[1]![5] = snapshot.strings.push("relative") - 1; styles[1]![39] = negative; }
    applySnapshotOcclusion(snapshot, visible);
    expect(visible.get(3)).toBe(true);
    expect(visible.get(4)).toBe(true);
  });

  it("retains a target in a higher stacking context even if its paint-order number is smaller", () => {
    const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
    const styles = snapshot.documents[0]!.layout.styles;
    styles[2]![5] = snapshot.strings.push("relative") - 1;
    styles[2]![39] = snapshot.strings.push("5") - 1;
    applySnapshotOcclusion(snapshot, visible);
    expect(visible.get(3)).toBe(true);
    expect(visible.get(4)).toBe(true);
  });
  it("omits a button and its text only when both are completely covered by later opaque paint", () => {
    const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
    applySnapshotOcclusion(snapshot, visible);
    expect([...visible.values()]).toEqual([true, true, false, false, true]);
  });

  it("retains targets when paint order, opacity, geometry, or clipping cannot prove full coverage", () => {
    for (const change of [
      (snapshot: any) => { snapshot.documents[0].layout.paintOrders[4] = 1; },
      (snapshot: any) => { snapshot.documents[0].layout.styles[4][0] = snapshot.strings.push("0.5") - 1; },
      (snapshot: any) => { snapshot.documents[0].layout.bounds[4] = [0, 100, 60, 160]; },
      (snapshot: any) => { snapshot.documents[0].layout.styles[1][1] = snapshot.strings.push("hidden") - 1; },
      (snapshot: any) => { snapshot.documents[0].layout.styles[2][37] = snapshot.strings.push("rgb(0, 0, 0) 8px 0px 0px") - 1; },
    ]) {
      const snapshot = capture(), visible = new Map([[1, true], [2, true], [3, true], [4, true], [5, true]]);
      change(snapshot); applySnapshotOcclusion(snapshot, visible);
      expect(visible.get(3)).toBe(true);
    }
  });
});
