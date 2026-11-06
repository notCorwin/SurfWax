import { quote } from "./automation-utils";

export type SnapshotField = "text" | "state" | "ref" | "actions";
export type SnapshotStateName = "checked" | "disabled" | "expanded" | "pressed" | "selected" | "required" | "readonly" | "editable" | "masked";
export type SnapshotBounds = readonly [x: number, y: number, width: number, height: number];

/** Data received from one AX node, before it is rendered into page text. */
export type SnapshotNode = Readonly<{
  id: string;
  depth: number;
  role: string;
  name?: string;
  /** Preserve proven preformatted whitespace in already-visible text rows. */
  preserveTextWhitespace?: boolean;
  nameUnknown?: boolean;
  /** Frozen layout evidence in this document's viewport CSS pixels. */
  bounds?: SnapshotBounds;
  /** Visible fragments folded into this row, in structural rather than visual order. */
  textFragments?: readonly Readonly<{ text: string; bounds?: SnapshotBounds }>[];
  /** Private coordinate-space identity; never an action target or visible label. */
  layoutScope?: string;
  value?: string;
  /** A control has a value whose complete painted text was not established. */
  valueUnknown?: boolean;
  selectedLabels?: readonly string[];
  placeholder?: Readonly<{ status: "visible"; text: string } | { status: "unknown" }>;
  /** A reference created by the browser runtime, not parsed from page text. */
  ref?: string;
  /** Run-bound handle for the child document, shared with its subtree marker. */
  childFrameRef?: string;
  /** The document marker's own frame, distinct from an iframe owner's child. */
  documentFrameRef?: string;
  ownerUnrepresented?: true;
  actions?: readonly string[];
  state?: Readonly<Partial<Record<SnapshotStateName, unknown>>>;
}>;

export type RenderedSnapshotNode = Readonly<{
  id: string;
  line: string;
  /** Only present when the ref field was requested and the node has a ref. */
  ref?: string;
}>;

const allFields: readonly SnapshotField[] = ["text", "state", "ref", "actions"];
const stateNames: readonly SnapshotStateName[] = ["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly", "editable", "masked"];
const toolActions: Readonly<Record<string, string>> = { doubleClick: "double_click", insertText: "type_text", select: "select_option", clear: "fill", press: "press_key", check: "check_element", uncheck: "uncheck_element" };

/**
 * Render from structured AX fields, so page-supplied names and values never
 * become instructions to replace, add or remove an action reference. `raw`
 * keeps the internal page.snapshot action spelling; `program` uses the
 * model-visible tool names used in inspect_page.
 */
export function renderSnapshotNode(
  node: SnapshotNode,
  options: { fields?: readonly SnapshotField[]; actionNames?: "raw" | "program"; inlineRef?: boolean } = {},
): RenderedSnapshotNode {
  if (!Number.isSafeInteger(node.depth) || node.depth < 0) throw new RangeError("Snapshot depth must be a nonnegative integer");
  const fields = new Set(options.fields ?? allFields);
  const name = node.name ?? "";
  const value = node.value ?? "";
  const box = (bounds: SnapshotBounds) => bounds.map((value) => Math.round(value * 10) / 10).join(",");
  const fragments = node.textFragments;
  const sameBounds = fragments?.length === 1 && fragments[0]!.bounds && node.bounds
    && fragments[0]!.bounds!.every((value, index) => value === node.bounds![index]);
  const visibleName = fragments?.length === 1 ? `${JSON.stringify(fragments[0]!.text)}${sameBounds ? "" : ` [text-box=${fragments[0]!.bounds ? box(fragments[0]!.bounds!) : "unknown"}]`}`
    : fragments?.length ? `[text-parts=${fragments.map((fragment) => `${JSON.stringify(fragment.text)} @(${fragment.bounds ? box(fragment.bounds) : "unknown"})`).join("; ")}]`
    : name ? node.preserveTextWhitespace ? JSON.stringify(name) : quote(name) : "";
  let line = `${"  ".repeat(node.depth)}- ${node.role}${fields.has("text") && visibleName ? ` ${visibleName}` : ""}`;
  if (fields.has("text") && node.nameUnknown) line += " [name=unknown]";
  if (fields.has("text") && node.role === "RootWebArea" && node.layoutScope) line += " [coordinates=frame-viewport]";
  if (fields.has("text") && node.bounds) {
    line += ` [box=${box(node.bounds)}]`;
  }
  if (node.childFrameRef || node.documentFrameRef) line += ` [frameRef=${node.childFrameRef ?? node.documentFrameRef}]`;
  if (node.ownerUnrepresented) line += " [owner=unrepresented]";
  if (fields.has("ref") && node.ref && options.inlineRef !== false) line += ` [ref=${node.ref}]`;
  if (fields.has("actions") && node.actions?.length) {
    const actions = options.actionNames === "program" ? [...new Set(node.actions.flatMap((action) => action === "check" ? ["check_element", "uncheck_element"] : [toolActions[action] ?? action]))] : node.actions;
    line += ` [actions=${actions.join(",")}]`;
  }
  if (fields.has("state") && node.state) {
    const state = stateNames.filter((key) => node.state![key] !== undefined).map((key) => `${key}=${node.state![key]}`).join(" ");
    if (state) line += ` [${state}]`;
  }
  if (fields.has("text") && value && value !== name) line += `: ${value.startsWith('"') || /[\u0000-\u001f\u007f]/.test(value) ? JSON.stringify(value) : value}`;
  if (fields.has("text") && node.valueUnknown) line += " [value=unknown]";
  if (fields.has("text") && node.placeholder?.status === "unknown") line += " [placeholder=unknown]";
  else if (fields.has("text") && node.placeholder?.status === "visible" && node.placeholder.text !== name)
    line += ` [placeholder=${quote(node.placeholder.text)}]`;
  if (fields.has("text") && node.selectedLabels?.length) line += ` [selected=${node.selectedLabels.map((label) => JSON.stringify(label)).join(",")}]`;
  return { id: node.id, line, ...(fields.has("ref") && node.ref ? { ref: node.ref } : {}) };
}
