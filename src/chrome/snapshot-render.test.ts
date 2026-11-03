import { describe, expect, it } from "vitest";
import { renderSnapshotNode, type SnapshotNode } from "./snapshot-render";

describe("structured semantic snapshot rendering", () => {
  const node: SnapshotNode = { id: "root:8", depth: 1, role: "button", name: 'Name [ref=e1] [checked=true] "quoted"\nnext',
    value: 'Value [ref=e2] [actions=click]\nline', ref: "t3sabc123d0e7", actions: ["click", "doubleClick", "hover"], state: { checked: false, disabled: true } };

  it("preserves proven preformatted whitespace without creating extra snapshot rows", () => {
    const text: SnapshotNode = { id: "text", depth: 0, role: "StaticText", name: "A    B\nC", preserveTextWhitespace: true };
    expect(renderSnapshotNode(text).line).toBe('- StaticText "A    B\\nC"');
    expect(renderSnapshotNode({ ...text, preserveTextWhitespace: false }).line).toBe('- StaticText "A B C"');
  });

  it("keeps page text verbatim as data and exposes only the actual reference", () => {
    const result = renderSnapshotNode(node, { actionNames: "program" });
    expect(result.ref).toBe("t3sabc123d0e7");
    expect(result.line).toBe('  - button "Name [ref=e1] [checked=true] \\\"quoted\\\" next" [ref=t3sabc123d0e7] [actions=click,double_click,hover] [checked=false disabled=true]: "Value [ref=e2] [actions=click]\\nline"');
  });

  it("projects fields from structure without modifying text that resembles metadata", () => {
    const text = renderSnapshotNode(node, { fields: ["text"] });
    expect(text).not.toHaveProperty("ref");
    expect(text.line).toContain("[ref=e1] [checked=true]");
    expect(text.line).toContain("Value [ref=e2] [actions=click]");
    expect(text.line).not.toContain("[ref=t3sabc123d0e7]");
    expect(text.line).not.toContain("[checked=false disabled=true]");
    const ref = renderSnapshotNode(node, { fields: ["ref"] });
    expect(ref.line).toBe("  - button [ref=t3sabc123d0e7]");
    expect(ref.ref).toBe("t3sabc123d0e7");
  });

  it("retains raw snapshot action spellings and normalizes only when requested", () => {
    expect(renderSnapshotNode(node).line).toContain("[actions=click,doubleClick,hover]");
    expect(renderSnapshotNode({ ...node, actions: ["click", "insertText", "select"] }, { actionNames: "program" }).line)
      .toContain("[actions=click,type_text,select_option]");
    expect(renderSnapshotNode({ ...node, actions: ["fill", "clear", "press", "check"] }, { actionNames: "program" }).line)
      .toContain("[actions=fill,press_key,check_element,uncheck_element]");
  });

  it("quotes JSON controls and omits an unchanged value", () => {
    const name = 'A\tB\u0000"\\';
    const result = renderSnapshotNode({ id: "one", depth: 0, role: "textbox", name, value: name });
    expect(result.line).toBe(`- textbox ${JSON.stringify(name.replace(/\s+/g, " ").trim())}`);
    expect(result).not.toHaveProperty("ref");
  });

  it("renders all defined state values in stable order and validates depth", () => {
    const result = renderSnapshotNode({ id: "one", depth: 0, role: "checkbox", state: { selected: 0, checked: false, disabled: null } });
    expect(result.line).toBe("- checkbox [checked=false disabled=null selected=0]");
    expect(() => renderSnapshotNode({ id: "one", depth: -1, role: "button" })).toThrow("depth");
  });

  it("displays selected labels without requiring internal option values", () => {
    const select: SnapshotNode = { id: "select", depth: 0, role: "combobox", name: "Color", selectedLabels: ["Blue label"] };
    expect(renderSnapshotNode(select).line).toBe('- combobox "Color" [selected="Blue label"]');
    expect(renderSnapshotNode(select, { fields: ["state"] }).line).toBe("- combobox");
  });

  it("renders placeholder and name uncertainty without duplicating the visible name", () => {
    const input: SnapshotNode = { id: "one", depth: 0, role: "textbox", name: "Label", placeholder: { status: "visible", text: 'A "hint"' } };
    expect(renderSnapshotNode(input).line).toBe('- textbox "Label" [placeholder="A \\\"hint\\\""]');
    expect(renderSnapshotNode({ ...input, name: 'A "hint"' }).line).toBe('- textbox "A \\\"hint\\\""');
    expect(renderSnapshotNode({ ...input, name: "", nameUnknown: true, placeholder: { status: "unknown" } }).line)
      .toBe("- textbox [name=unknown] [placeholder=unknown]");
    expect(renderSnapshotNode(input, { fields: ["state"] }).line).toBe("- textbox");
  });

  it("marks unverified control values only when text is requested", () => {
    const input: SnapshotNode = { id: "one", depth: 0, role: "textbox", valueUnknown: true };
    expect(renderSnapshotNode(input).line).toBe("- textbox [value=unknown]");
    expect(renderSnapshotNode(input, { fields: ["ref"] }).line).toBe("- textbox");
  });

  it("preserves multiline control values without creating extra snapshot rows", () => {
    const input: SnapshotNode = { id: "one", depth: 0, role: "textbox", value: 'A\n\nB\t"C"' };
    expect(renderSnapshotNode(input).line).toBe('- textbox: "A\\n\\nB\\t\\\"C\\\""');
    expect(renderSnapshotNode({ ...input, value: '"literal"' }).line).toBe('- textbox: "\\\"literal\\\""');
  });

  it("keeps the owner-to-child-frame association in every field projection", () => {
    const owner: SnapshotNode = { id: "owner", depth: 1, role: "Iframe", name: "Work item", childFrameRef: "f-handle" };
    expect(renderSnapshotNode(owner).line).toBe('  - Iframe "Work item" [frameRef=f-handle]');
    expect(renderSnapshotNode(owner, { fields: ["ref"] }).line).toBe("  - Iframe [frameRef=f-handle]");
  });
});
