import { describe, expect, it } from "vitest";
import { compactSnapshot } from "./snapshot-presentation";
import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode, type SnapshotNode } from "./snapshot-render";
import { expandSnapshot } from "./snapshot-repeat";

function rows(nodes: SnapshotNode[]): SnapshotLine[] {
  return nodes.map((node) => ({ ...renderSnapshotNode(node), node }));
}

describe("compact visible snapshot presentation", () => {
  it("keeps list grouping and folds complete label evidence into the parent", () => {
    const input = rows([
      { id: "root", depth: 0, role: "RootWebArea" },
      { id: "list", depth: 1, role: "list" },
      { id: "item", depth: 2, role: "listitem" },
      { id: "link", depth: 3, role: "link", name: "Repositories 7", ref: "owned-link", actions: ["click"] },
      { id: "wrapper", depth: 4, role: "generic" },
      { id: "label", depth: 5, role: "StaticText", name: "Repositories ", textWhitespaceProven: true },
      { id: "count", depth: 5, role: "StaticText", name: "7" },
      { id: "paragraph", depth: 3, role: "paragraph" },
      { id: "description", depth: 4, role: "StaticText", name: "Repository description" },
    ]);
    const result = expandSnapshot(compactSnapshot(input));
    expect(result.map(({ id }) => id)).toEqual(["root", "list", "item", "link", "description"]);
    expect(result.find(({ id }) => id === "description")?.line).toBe('      - StaticText "Repository description"');
    expect(result.find(({ id }) => id === "link")).toMatchObject({ ref: "owned-link", node: { depth: 3, actions: ["click"] } });
    expect(result.find(({ id }) => id === "link")?.node?.textFragments).toEqual([{ text: "Repositories " }, { text: "7" }]);
    expect(result.find(({ id }) => id === "link")?.line).toContain('"Repositories "');
    expect(input.find(({ id }) => id === "description")?.node?.depth).toBe(4);
  });

  it("retains independent controls, anonymous images and text not covered by a complete label", () => {
    const result = expandSnapshot(compactSnapshot(rows([
      { id: "root", depth: 0, role: "RootWebArea" },
      { id: "badge", depth: 1, role: "link", name: "x2" },
      { id: "image", depth: 2, role: "image", nameUnknown: true },
      { id: "count", depth: 2, role: "StaticText", name: "x2" },
      { id: "control", depth: 1, role: "button", name: "Save More" },
      { id: "save", depth: 2, role: "StaticText", name: "Save" },
      { id: "more", depth: 2, role: "button", name: "More", state: { expanded: false } },
      { id: "more-text", depth: 3, role: "StaticText", name: "More" },
      { id: "partial", depth: 1, role: "link", name: "Only" },
      { id: "uncovered", depth: 2, role: "StaticText", name: "Only part" },
    ])));
    expect(result.map(({ id }) => id)).toEqual(["root", "badge", "image", "control", "save", "more", "partial", "uncovered"]);
    expect(result.find(({ id }) => id === "image")?.node?.nameUnknown).toBe(true);
    expect(result.find(({ id }) => id === "more")?.node?.state).toEqual({ expanded: false });
  });

  it("does not promote unverified source whitespace to visible label fragments", () => {
    const input = rows([
      { id: "button", depth: 0, role: "button", name: "Save changes" },
      { id: "source", depth: 1, role: "StaticText", name: "\n  Save changes\n " },
    ]);
    const result = expandSnapshot(compactSnapshot(input));
    expect(result).toHaveLength(2);
    expect(result[0]!.node?.textFragments).toBeUndefined();
    expect(result[1]!.line).toBe('  - StaticText "Save changes"');
  });

  it("preserves nested text fragment positions when folding a complete label", () => {
    const label: SnapshotNode = { id: "label", depth: 1, role: "StaticText", name: "One Two", bounds: [0, 0, 100, 20],
      textFragments: [{ text: "One ", bounds: [0, 0, 30, 20] }, { text: "Two", bounds: [30, 0, 30, 20] }] };
    const fold = (node: SnapshotNode) => expandSnapshot(compactSnapshot(rows([
      { id: "button", depth: 0, role: "button", name: "One Two", bounds: [0, 0, 100, 20] }, node,
    ])));
    const first = fold(label);
    expect(first).toHaveLength(1);
    expect(first[0]!.node?.textFragments).toEqual(label.textFragments);
    expect(fold({ ...label, textFragments: [label.textFragments![0]!, { text: "Two", bounds: [60, 0, 30, 20] }] })[0]!.line)
      .not.toBe(first[0]!.line);
    // A stale name is insufficient proof that these fragments equal the label.
    expect(fold({ ...label, textFragments: [{ text: "Changed", bounds: [0, 0, 100, 20] }] })).toHaveLength(2);
  });

  it("keeps distinct source paragraphs separate after their passive wrappers are flattened", () => {
    const result = compactSnapshot(rows([
      { id: "root", depth: 0, role: "RootWebArea" },
      { id: "first", depth: 1, role: "paragraph" },
      { id: "one", depth: 2, role: "StaticText", name: "PARAONE", bounds: [0, 0, 60, 15] },
      { id: "second", depth: 1, role: "paragraph" },
      { id: "two", depth: 2, role: "StaticText", name: "PARATWO", bounds: [0, 40, 60, 15] },
    ]));
    expect(result.map(({ id }) => id)).toEqual(["root", "one", "two"]);
    expect(result.every((line) => !line.members)).toBe(true);
  });

  it("folds a sole paragraph label while preserving its geometry and sibling boundaries", () => {
    const input: SnapshotNode[] = [
      { id: "link", depth: 0, role: "link", name: "One Two", bounds: [0, 0, 100, 50] },
      { id: "wrapper", depth: 1, role: "generic" },
      { id: "paragraph", depth: 2, role: "paragraph" },
      { id: "text", depth: 3, role: "StaticText", name: "One Two", bounds: [2, 5, 90, 40],
        textFragments: [{ text: "One ", bounds: [2, 5, 30, 15] }, { text: "Two", bounds: [2, 25, 30, 15] }] },
    ];
    const folded = expandSnapshot(compactSnapshot(rows(input)));
    expect(folded).toHaveLength(1);
    expect(folded[0]!.node?.textFragments).toEqual(input[3]!.textFragments);
    // Even one additional child makes this a paragraph boundary, not merely
    // the named control's single label path.
    const siblings = [...input, { id: "sibling", depth: 1, role: "StaticText", name: "Other" }];
    expect(expandSnapshot(compactSnapshot(rows(siblings))).some(({ id }) => id === "text")).toBe(true);
    const paragraphs = [...input, { id: "second", depth: 1, role: "paragraph" },
      { id: "second-text", depth: 2, role: "StaticText", name: "Other" }];
    expect(expandSnapshot(compactSnapshot(rows(paragraphs))).some(({ id }) => id === "text")).toBe(true);
  });

  it("preserves uncertainty, formatting, frame associations and selected region roots", () => {
    const input = rows([
      { id: "region", depth: 2, role: "generic" },
      { id: "heading", depth: 3, role: "heading", name: "A B" },
      { id: "pre", depth: 4, role: "StaticText", name: "A  B", preserveTextWhitespace: true },
      { id: "unknown", depth: 4, role: "StaticText", nameUnknown: true },
      { id: "frame", depth: 3, role: "generic", childFrameRef: "child-document" },
      { id: "value", depth: 3, role: "generic", value: "independent value" },
      { id: "editable", depth: 3, role: "generic", state: { editable: "richtext" } },
    ]);
    expect(compactSnapshot(input)).toEqual(input);
  });

  it("does not retarget interactive wrappers when reparenting", () => {
    const input = rows([
      { id: "root", depth: 0, role: "RootWebArea" },
      { id: "wrapper", depth: 1, role: "generic" },
      { id: "interactive", depth: 2, role: "generic", ref: "independent-control", actions: ["click"] },
      { id: "document", depth: 3, role: "RootWebArea" },
    ]);
    const result = compactSnapshot(input);
    expect(result.map(({ id }) => id)).toEqual(["root", "interactive", "document"]);
    expect(result[1]).toMatchObject({ ref: "independent-control", node: { depth: 1 } });
    expect(result[2]!.line).toBe("    - RootWebArea");
  });
});
