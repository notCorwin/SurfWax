import { describe, expect, it } from "vitest";
import { renderSnapshotNode, type SnapshotNode } from "./snapshot-render";

describe("structured semantic snapshot rendering", () => {
  const node: SnapshotNode = { id: "root:8", depth: 1, role: "button", name: 'Name [ref=e1] [checked=true] "quoted"\nnext',
    value: 'Value [ref=e2] [actions=click]\nline', ref: "t3sabc123d0e7", actions: ["click", "doubleClick", "hover"], state: { checked: false, disabled: true } };

  it("keeps page text verbatim as data and exposes only the actual reference", () => {
    const result = renderSnapshotNode(node, { actionNames: "program" });
    expect(result.ref).toBe("t3sabc123d0e7");
    expect(result.line).toBe('  - button "Name [ref=e1] [checked=true] \\\"quoted\\\" next" [ref=t3sabc123d0e7] [actions=click,dblclick,hover] [checked=false disabled=true]: Value [ref=e2] [actions=click]\nline');
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
      .toContain("[actions=click,pressSequentially,selectOption]");
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
});
