import { describe, expect, it } from "vitest";
import { createPreformattedTextCollector } from "./snapshot-preformatted";

function fixture(mode: string, source = "A    B\nC", rendered = source) {
  const strings = ["root", "#document", "#text", source, rendered, "none", mode];
  const style = Array<number>(33).fill(5);
  style[32] = 6;
  const document = { frameId: 0, nodes: { backendNodeId: [1, 2], nodeType: [9, 3], nodeValue: [-1, 3] },
    layout: { nodeIndex: [0, 1], styles: [style.slice(), style.slice()], text: [-1, 4] } };
  return { strings, documents: [document] };
}

function collect(snapshot: ReturnType<typeof fixture>) {
  const document = snapshot.documents[0]!;
  const collector = createPreformattedTextCollector(snapshot.strings, document.nodes, document.layout);
  const rows = new Set<number>();
  document.layout.nodeIndex.forEach((index, row) => {
    collector.observe(row, rows.has(index));
    rows.add(index);
  });
  return collector.result;
}

describe("preformatted snapshot text evidence", () => {
  it.each(["pre", "pre-wrap", "break-spaces"])("retains only equal source and layout text for %s", (mode) => {
    const snapshot = fixture(mode);
    expect(collect(snapshot).get(2)).toEqual({ source: "A    B\nC", text: "A    B\nC" });
    expect(collect(fixture(mode, "A    B\nC", "A B C")).has(2)).toBe(false);
  });

  it.each(["normal", "nowrap"])("does not preserve raw whitespace for %s", (mode) => {
    expect(collect(fixture(mode)).size).toBe(0);
  });

  it("collapses pre-line spaces and tabs while retaining internal line breaks", () => {
    const source = "A    B \n C\t\tD\n\nE";
    expect(collect(fixture("pre-line", source)).get(2)).toEqual({ source, text: "A B\nC D\n\nE" });
    expect(collect(fixture("pre-line", "A\nB")).get(2)).toEqual({ source: "A\nB", text: "A\nB" });
    expect(collect(fixture("pre-line", "中 \n 日")).get(2)).toEqual({ source: "中 \n 日", text: "中\n日" });
    expect(collect(fixture("pre-line", source, "A B")).size).toBe(0);
  });

  it.each([" A\nB", "A\nB ", "\nA\nB", "A\nB\n", "A\r\nB", "A\fB\nC", "A B"])(
    "does not guess pre-line text when boundary or segment-break behavior needs context: %j", (source) => {
      expect(collect(fixture("pre-line", source)).size).toBe(0);
    },
  );

  it("rejects ambiguous layout rows and transformed or masked text", () => {
    const repeated = fixture("pre");
    repeated.documents[0]!.layout.nodeIndex.push(1);
    repeated.documents[0]!.layout.styles.push(repeated.documents[0]!.layout.styles[1]!.slice());
    repeated.documents[0]!.layout.text.push(4);
    expect(collect(repeated).size).toBe(0);
    const transformed = fixture("pre");
    transformed.strings.push("uppercase"); transformed.documents[0]!.layout.styles[1]![25] = transformed.strings.length - 1;
    expect(collect(transformed).size).toBe(0);
    const masked = fixture("pre");
    masked.strings.push("disc"); masked.documents[0]!.layout.styles[1]![26] = masked.strings.length - 1;
    expect(collect(masked).size).toBe(0);
  });

  it("handles empty documents and rejects malformed evidence", () => {
    expect(createPreformattedTextCollector(["root"], { backendNodeId: [], nodeType: [] }, { nodeIndex: [], styles: [] }).result.size).toBe(0);
    expect(() => createPreformattedTextCollector(["root"], { backendNodeId: [1], nodeType: [3] }, { nodeIndex: [], styles: [] })).toThrow("Invalid DOM snapshot text layout");
    const invalid = fixture("pre"); invalid.documents[0]!.layout.nodeIndex[1] = 5;
    expect(() => collect(invalid)).toThrow("Invalid DOM snapshot layout index");
    const outOfOrder = fixture("pre"), document = outOfOrder.documents[0]!;
    const collector = createPreformattedTextCollector(outOfOrder.strings, document.nodes, document.layout);
    expect(() => collector.observe(1, false)).toThrow("Invalid DOM snapshot layout row");
  });
});
