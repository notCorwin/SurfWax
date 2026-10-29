import { quote } from "./automation-utils";

export type SnapshotField = "text" | "state" | "ref" | "actions";
export type SnapshotStateName = "checked" | "disabled" | "expanded" | "pressed" | "selected" | "required" | "readonly";

/** Data received from one AX node, before it is rendered into page text. */
export type SnapshotNode = Readonly<{
  id: string;
  depth: number;
  role: string;
  name?: string;
  value?: string;
  /** A reference created by the browser runtime, not parsed from page text. */
  ref?: string;
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
const stateNames: readonly SnapshotStateName[] = ["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly"];
const programActions: Readonly<Record<string, string>> = { doubleClick: "dblclick", insertText: "pressSequentially", select: "selectOption" };

/**
 * Render from structured AX fields, so page-supplied names and values never
 * become instructions to replace, add or remove an action reference. `raw`
 * keeps the historical page.snapshot action spelling; `program` uses the
 * execute_program API spellings used in inspect_page.
 */
export function renderSnapshotNode(
  node: SnapshotNode,
  options: { fields?: readonly SnapshotField[]; actionNames?: "raw" | "program" } = {},
): RenderedSnapshotNode {
  if (!Number.isSafeInteger(node.depth) || node.depth < 0) throw new RangeError("Snapshot depth must be a nonnegative integer");
  const fields = new Set(options.fields ?? allFields);
  const name = node.name ?? "";
  const value = node.value ?? "";
  let line = `${"  ".repeat(node.depth)}- ${node.role}${fields.has("text") && name ? ` ${quote(name)}` : ""}`;
  if (fields.has("ref") && node.ref) line += ` [ref=${node.ref}]`;
  if (fields.has("actions") && node.actions?.length) {
    const actions = options.actionNames === "program" ? node.actions.map((action) => programActions[action] ?? action) : node.actions;
    line += ` [actions=${actions.join(",")}]`;
  }
  if (fields.has("state") && node.state) {
    const state = stateNames.filter((key) => node.state![key] !== undefined).map((key) => `${key}=${node.state![key]}`).join(" ");
    if (state) line += ` [${state}]`;
  }
  if (fields.has("text") && value && value !== name) line += `: ${value}`;
  return { id: node.id, line, ...(fields.has("ref") && node.ref ? { ref: node.ref } : {}) };
}
