import { describe, expect, it } from "vitest";
import { axEllipsisCandidate, confirmAxEllipsis } from "./snapshot-ax-ellipsis";

function fixture(sourceText = "Next TASK-746F9DB6E6FB", prefix = "Next TASK-7") {
  const node = { nodeId: "text", backendDOMNodeId: 7, role: { value: "StaticText" }, name: { value: sourceText }, childIds: ["full", "prefix", "marker"] };
  const children = [
    { nodeId: "full", parentId: "text", role: { value: "InlineTextBox" }, name: { value: sourceText }, childIds: [] },
    { nodeId: "prefix", parentId: "text", role: { value: "InlineTextBox" }, name: { value: prefix }, childIds: [] },
    { nodeId: "marker", parentId: "text", role: { value: "InlineTextBox" }, name: { value: "…" }, childIds: [] },
  ];
  const nodesById = new Map([node, ...children].map((item) => [item.nodeId, item]));
  const input = { node, nodesById, frameId: "root", expectedFrameId: "root", backendNodeId: 7, sourceText, layoutText: sourceText,
    textBoxes: [{ start: 0, length: sourceText.length, bounds: [10, 10, 220, 20] }],
    direction: "ltr", writingMode: "horizontal-tb", textTransform: "none", textSecurity: "none" };
  const proof = { clip: { x: 10, y: 10, width: 150, height: 24 }, prefixBounds: { x: 10, y: 10, width: 110, height: 20 },
    ellipsisWidth: 12, singleTextNode: true, singleLine: true, paintProven: true };
  return { node, children, nodesById, input, proof };
}

describe("AX ellipsis evidence", () => {
  it("requires both the clipped inline-box pattern and independently confirmed geometry", () => {
    const { input, proof } = fixture();
    const candidate = axEllipsisCandidate(input);
    expect(candidate).toEqual({ prefix: "Next TASK-7", marker: "…", end: 11 });
    expect(confirmAxEllipsis(candidate!, proof)).toBe("Next TASK-7…");
  });

  it("fails closed for tiny clips, missing paint proof and unsafe layout", () => {
    const { input, proof } = fixture(), candidate = axEllipsisCandidate(input)!;
    expect(confirmAxEllipsis(candidate, { ...proof, clip: { ...proof.clip, width: 5 } })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, clip: { ...proof.clip, width: 115 } })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, prefixBounds: { ...proof.prefixBounds, x: 9 } })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, prefixBounds: { ...proof.prefixBounds, height: 25 } })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, ellipsisWidth: Number.NaN })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, singleTextNode: false })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, singleLine: false })).toBeUndefined();
    expect(confirmAxEllipsis(candidate, { ...proof, paintProven: false })).toBeUndefined();
  });

  it("rejects mismatched frame, backend and inline-box ownership", () => {
    const { input, children } = fixture();
    expect(axEllipsisCandidate({ ...input, expectedFrameId: "child" })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, backendNodeId: 8 })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, node: { ...input.node } })).toBeUndefined();
    children[1]!.parentId = "other";
    expect(axEllipsisCandidate(input)).toBeUndefined();
  });

  it("does not infer a clipped name from a complete or ambiguous AX pattern", () => {
    const { input, node, children } = fixture();
    children[2]!.name.value = ".";
    expect(axEllipsisCandidate(input)).toBeUndefined();
    children[2]!.name.value = "…";
    children[1]!.name.value = "TASK";
    expect(axEllipsisCandidate(input)).toBeUndefined();
    children[1]!.name.value = input.sourceText;
    expect(axEllipsisCandidate(input)).toBeUndefined();
    node.childIds.push("extra");
    expect(axEllipsisCandidate(input)).toBeUndefined();
  });

  it("supports complete CJK and emoji graphemes but not split graphemes or bidi", () => {
    const valid = fixture("一二😀😁三四", "一二😀");
    expect(axEllipsisCandidate(valid.input)?.prefix).toBe("一二😀");
    const split = fixture("a👨‍👩‍👧‍👦bc", "a👨");
    expect(axEllipsisCandidate(split.input)).toBeUndefined();
    const rtl = fixture("ABC אבג DEF", "ABC ");
    expect(axEllipsisCandidate(rtl.input)).toBeUndefined();
  });

  it("does not map transformed, masked, multi-line or multi-box text by guesswork", () => {
    const { input } = fixture();
    expect(axEllipsisCandidate({ ...input, layoutText: input.sourceText.toUpperCase() })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, textTransform: "uppercase" })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, textSecurity: "disc" })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, direction: "rtl" })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, writingMode: "vertical-rl" })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, textBoxes: [...input.textBoxes, input.textBoxes[0]!] })).toBeUndefined();
    expect(axEllipsisCandidate({ ...input, textBoxes: [{ ...input.textBoxes[0]!, length: 1 }] })).toBeUndefined();
  });
});
