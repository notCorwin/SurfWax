import { describe, expect, it } from "vitest";
import { createPreformattedTextCollector, normalizeSnapshotText } from "./snapshot-preformatted";

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

  it("rejects ambiguous layout rows and masked text while preserving transformed layout text", () => {
    const repeated = fixture("pre");
    repeated.documents[0]!.layout.nodeIndex.push(1);
    repeated.documents[0]!.layout.styles.push(repeated.documents[0]!.layout.styles[1]!.slice());
    repeated.documents[0]!.layout.text.push(4);
    expect(collect(repeated).size).toBe(0);
    const transformed = fixture("pre", "a  b", "A  B");
    transformed.strings.push("uppercase"); transformed.documents[0]!.layout.styles[1]![25] = transformed.strings.length - 1;
    expect(collect(transformed).get(2)).toEqual({ source: "A  B", text: "A  B" });
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

  it("uses text box offsets to distinguish indentation, boundary spaces and soft wrapping", () => {
    const get = (source: string, boxes: Array<[number, number]>, mode = "normal") => {
      const snapshot = fixture(mode, source), document = snapshot.documents[0]!;
      const textBoxes = { layoutIndex: boxes.map(() => 1), start: boxes.map(([start]) => start), length: boxes.map(([, length]) => length),
        bounds: boxes.map(() => [0, 0, 10, 10]) };
      const collector = createPreformattedTextCollector(snapshot.strings, document.nodes, document.layout, textBoxes);
      document.layout.nodeIndex.forEach((_, row) => collector.observe(row, false));
      return collector.painted.get(2);
    };
    expect(get("\n    1\n  ", [[5, 1]])?.text).toBe("1");
    expect(get("Save  ", [[0, 5]])?.text).toBe("Save ");
    expect(get(" changes", [[1, 7]])?.text).toBe("changes");
    expect(get("A B C", [[0, 1], [2, 1], [4, 1]])?.text).toBe("A B C");
    expect(get("   ", [[0, 1]])?.text).toBe(" ");
    expect(get("A\u00a0 B", [[0, 4]])?.text).toBe("A\u00a0 B");
    expect(normalizeSnapshotText(" \u00a0  A\tB \u00a0 ")).toBe("\u00a0 A B \u00a0");
    // No proof if a non-collapsible character or glyph is omitted, or the
    // offsets are malformed. Raw evidence must remain available to callers.
    expect(get("A\u00a0B", [[0, 1], [2, 1]])).toBeUndefined();
    expect(get("abc", [[0, 1], [2, 1]])).toBeUndefined();
    expect(get("abc", [[0, 4]])).toBeUndefined();
  });

  it("reconstructs pre-line newlines from their zero-width text boxes", () => {
    const source = " A  B \n C ", snapshot = fixture("pre-line", source), document = snapshot.documents[0]!;
    const textBoxes = { layoutIndex: [1, 1, 1, 1], start: [1, 4, 6, 8], length: [2, 1, 1, 1],
      bounds: [[0, 0, 10, 10], [10, 0, 10, 10], [20, 0, 0, 10], [0, 10, 10, 10]] };
    const collector = createPreformattedTextCollector(snapshot.strings, document.nodes, document.layout, textBoxes);
    document.layout.nodeIndex.forEach((_, row) => collector.observe(row, false));
    expect(collector.painted.get(2)).toEqual({ source, text: "A B\nC", preformatted: true });
    textBoxes.start[2] = 7; // A missing preserved newline is not proof.
    const incomplete = createPreformattedTextCollector(snapshot.strings, document.nodes, document.layout, textBoxes);
    document.layout.nodeIndex.forEach((_, row) => incomplete.observe(row, false));
    expect(incomplete.painted.has(2)).toBe(false);
  });

  it("preserves transformed generated text after an empty pseudo geometry row", () => {
    const snapshot = fixture("pre", "", "   E"), document = snapshot.documents[0]!;
    document.nodes.nodeType[1] = 1;
    Object.assign(document.nodes, { nodeName: [-1, snapshot.strings.push("::first-letter") - 1] });
    document.layout.nodeIndex.splice(1, 0, 1);
    document.layout.text.splice(1, 0, -1);
    document.layout.styles.splice(1, 0, document.layout.styles[1]!.slice());
    const transform = snapshot.strings.push("uppercase") - 1;
    document.layout.styles[2]![25] = transform;
    expect(collect(snapshot).get(2)).toEqual({ source: "   E", text: "   E" });
  });

  it("maps Unicode case expansion only when it reproduces the captured complete layout text", () => {
    const snapshot = fixture("normal", "a ß ", "A SS "), document = snapshot.documents[0]!;
    document.layout.styles[1]![25] = snapshot.strings.push("uppercase") - 1;
    const collector = createPreformattedTextCollector(snapshot.strings, document.nodes, document.layout,
      { layoutIndex: [1], start: [0], length: [5], bounds: [[0, 0, 50, 18]] });
    document.layout.nodeIndex.forEach((_, row) => collector.observe(row, false));
    expect(collector.painted.get(2)?.text).toBe("A SS ");
    const preLine = fixture("pre-line", "aa ß\nbb", "AA SS\nBB");
    preLine.documents[0]!.layout.styles[1]![25] = preLine.strings.push("uppercase") - 1;
    expect(collect(preLine).get(2)?.text).toBe("AA SS\nBB");
  });

  it.each([
    ["uppercase", "ii i\nbb", "İİ İ\nBB"],
    ["capitalize", "aa b\ncc", "Aa B\nCc"],
  ])("preserves pre-line breaks independently of %s character offsets", (transform, source, rendered) => {
    const snapshot = fixture("pre-line", source, rendered);
    snapshot.documents[0]!.layout.styles[1]![25] = snapshot.strings.push(transform) - 1;
    expect(collect(snapshot).get(2)?.text).toBe(rendered);
    snapshot.strings[4] = rendered.replace(" ", "\u3000");
    expect(collect(snapshot).has(2)).toBe(false);
  });
});
