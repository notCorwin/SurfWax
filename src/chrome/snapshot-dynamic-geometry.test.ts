import { describe, expect, it } from "vitest";
import { changedTextNodes } from "./snapshot-consistency";

function fixture() {
  const strings = ["root", "#document", "BODY", "SPAN", "#text", "BUTTON", "short", "longer text", "visible", "hidden", "static", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "0px", "clip", "1", "normal"];
  const id = (s: string) => strings.indexOf(s);
  const style = ["1", "visible", "visible", "visible", "visible", "static", "none", "none", "none", "none", "auto", "none", "none", "none", "none", "none", "auto", "ltr", "horizontal-tb", "block", "16px", "rgb(0, 0, 0)", "none", "0px", "none", "none", "none", "clip", "none", "none", "none", "none"].map(id);
  while (style.length < 39) style.push(id("none")); style[36] = id("normal");
  const clipped = [...style]; clipped[1] = id("hidden"); clipped[2] = id("hidden");
  return { strings, documents: [{ frameId: id("root"), contentWidth: 300, contentHeight: 100, scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { backendNodeId: [1, 2, 3, 4, 5], parentIndex: [-1, 0, 1, 2, 1], nodeType: [9, 1, 1, 3, 1], nodeName: [id("#document"), id("BODY"), id("SPAN"), id("#text"), id("BUTTON")], nodeValue: [-1, -1, -1, id("short"), -1], attributes: [[], [], [], [], []] },
    layout: { nodeIndex: [0, 1, 2, 3, 4], bounds: [[0, 0, 300, 100], [0, 0, 300, 100], [10, 10, 120, 20], [10, 10, 40, 20], [180, 10, 80, 20]], styles: [style, style, clipped, style, style], text: [-1, -1, -1, id("short"), -1] },
    textBoxes: { layoutIndex: [3], start: [0], length: [5], bounds: [[10, 10, 40, 20]] },
  }] };
}
function changed() {
  const a = fixture(), b = fixture(), doc = b.documents[0]!;
  doc.nodes.nodeValue[3] = b.strings.indexOf("longer text");
  doc.layout.text[3] = b.strings.indexOf("longer text");
  doc.layout.bounds[3] = [10, 10, 90, 20];
  doc.textBoxes.length[0] = 11; doc.textBoxes.bounds[0] = [10, 10, 90, 20];
  return { a, b };
}

describe("isolated dynamic text geometry", () => {
  it("accepts text geometry changes confined to an isolated clipped container", () => {
    const { a, b } = changed();
    expect(changedTextNodes(a, b)).toEqual(new Set([3]));
  });
  it("rejects geometry changes affecting a neighboring node or an overlapping control", () => {
    const first = changed(); first.b.documents[0]!.layout.bounds[4]![0]--;
    expect(changedTextNodes(first.a, first.b)).toBeUndefined();
    const second = changed(); second.a.documents[0]!.layout.bounds[4]![0] = 100; second.b.documents[0]!.layout.bounds[4]![0] = 100;
    expect(changedTextNodes(second.a, second.b)).toBeUndefined();
  });
  it("rejects uncontained text and a container without clipping", () => {
    const first = changed(); first.b.documents[0]!.layout.bounds[3] = [10, 10, 140, 20];
    expect(changedTextNodes(first.a, first.b)).toBeUndefined();
    const second = changed(); second.a.documents[0]!.layout.styles[2]![1] = second.a.strings.indexOf("visible");
    expect(changedTextNodes(second.a, second.b)).toBeUndefined();
  });
  it("rejects visual effects that may extend beyond an element's layout bounds", () => {
    const { a, b } = changed();
    a.strings.push("2px 2px black"); b.strings.push("2px 2px black");
    a.documents[0]!.layout.styles[4]![37] = a.strings.length - 1;
    b.documents[0]!.layout.styles[4]![37] = b.strings.length - 1;
    expect(changedTextNodes(a, b)).toBeUndefined();
  });
});
