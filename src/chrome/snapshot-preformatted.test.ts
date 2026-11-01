import { describe, expect, it } from "vitest";
import { snapshotPreformattedText } from "./snapshot-preformatted";

function fixture(mode: string, source = "A    B\nC", rendered = source) {
  const strings = ["root", "#document", "#text", source, rendered, "none", mode];
  const style = Array<number>(33).fill(5);
  style[32] = 6;
  const document = { frameId: 0, nodes: { backendNodeId: [1, 2], nodeType: [9, 3], nodeValue: [-1, 3] },
    layout: { nodeIndex: [0, 1], styles: [style.slice(), style.slice()], text: [-1, 4] } };
  return { strings, documents: [document] };
}

describe("preformatted snapshot text evidence", () => {
  it.each(["pre", "pre-wrap", "break-spaces"])("retains only equal source and layout text for %s", (mode) => {
    const snapshot = fixture(mode);
    expect(snapshotPreformattedText(snapshot, "root").get(2)).toBe("A    B\nC");
    expect(snapshotPreformattedText(fixture(mode, "A    B\nC", "A B C"), "root").has(2)).toBe(false);
  });

  it.each(["normal", "nowrap", "pre-line"])("does not preserve raw whitespace for %s", (mode) => {
    expect(snapshotPreformattedText(fixture(mode), "root").size).toBe(0);
  });

  it("rejects ambiguous layout rows and transformed or masked text", () => {
    const repeated = fixture("pre");
    repeated.documents[0]!.layout.nodeIndex.push(1);
    repeated.documents[0]!.layout.styles.push(repeated.documents[0]!.layout.styles[1]!.slice());
    repeated.documents[0]!.layout.text.push(4);
    expect(snapshotPreformattedText(repeated, "root").size).toBe(0);
    const transformed = fixture("pre");
    transformed.strings.push("uppercase"); transformed.documents[0]!.layout.styles[1]![25] = transformed.strings.length - 1;
    expect(snapshotPreformattedText(transformed, "root").size).toBe(0);
    const masked = fixture("pre");
    masked.strings.push("disc"); masked.documents[0]!.layout.styles[1]![26] = masked.strings.length - 1;
    expect(snapshotPreformattedText(masked, "root").size).toBe(0);
  });

  it("handles empty documents and rejects malformed evidence", () => {
    expect(snapshotPreformattedText({ strings: ["root"], documents: [{ frameId: 0,
      nodes: { backendNodeId: [], nodeType: [] }, layout: { nodeIndex: [], styles: [] } }] }, "root").size).toBe(0);
    expect(() => snapshotPreformattedText(fixture("pre"), "other")).toThrow("Invalid DOM snapshot frame");
    const invalid = fixture("pre"); invalid.documents[0]!.layout.nodeIndex[1] = 5;
    expect(() => snapshotPreformattedText(invalid, "root")).toThrow("Invalid DOM snapshot layout index");
  });
});
