import { normalizeSnapshotText } from "./snapshot-preformatted";

export type SnapshotField = "text" | "state" | "ref" | "actions";
export type SnapshotStateName = "checked" | "disabled" | "expanded" | "pressed" | "selected" | "required" | "readonly" | "editable" | "masked" | "current" | "level";
export type SnapshotBounds = readonly [x: number, y: number, width: number, height: number];

/** Data received from one AX node, before it is projected into a wire item. */
export type SnapshotNode = Readonly<{
  id: string;
  depth: number;
  role: string;
  name?: string;
  /** Preserve proven preformatted whitespace in already-visible text rows. */
  preserveTextWhitespace?: boolean;
  /** Static text boundaries established by captured CSS and DOMSnapshot evidence.
   * Unproven text must not be folded verbatim as a label fragment. */
  textWhitespaceProven?: true;
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

export type SnapshotBoxRun =
  | Readonly<{ box: SnapshotBounds }>
  | Readonly<{ first: SnapshotBounds; step: SnapshotBounds; count: number }>;

export type SnapshotTextPart = Readonly<{ text: string; box?: SnapshotBounds }>;

/** Structured wire/projection row. Removed deltas omit role/depth. */
export type ProjectedSnapshotNode = Readonly<{
  id: string;
  actionable?: true;
  depth?: number;
  role?: string;
  name?: string;
  nameUnknown?: true;
  box?: SnapshotBounds;
  textBox?: SnapshotBounds;
  textParts?: readonly SnapshotTextPart[];
  coordinates?: "frame-viewport";
  value?: string;
  valueUnknown?: true;
  placeholder?: string | "unknown";
  selected?: readonly string[];
  frameRef?: string;
  ownerUnrepresented?: true;
  ref?: string;
  actions?: readonly string[];
  state?: Readonly<Partial<Record<SnapshotStateName, unknown>>>;
  count?: number;
  boxes?: readonly SnapshotBoxRun[];
  /** Single-child ancestry packed into one transport row. */
  path?: readonly Omit<ProjectedSnapshotNode, "id" | "path">[];
}>;

/** @deprecated Prefer ProjectedSnapshotNode; kept for call sites that still expect a line. */
export type RenderedSnapshotNode = Readonly<{
  id: string;
  line: string;
  ref?: string;
}>;

const allFields: readonly SnapshotField[] = ["text", "state", "ref", "actions"];
const stateNames: readonly SnapshotStateName[] = ["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly", "editable", "masked", "current", "level"];
const toolActions: Readonly<Record<string, string>> = { doubleClick: "double_click", insertText: "type_text", select: "select_option", clear: "fill", press: "press_key", check: "check_element", uncheck: "uncheck_element" };

const roundBox = (bounds: SnapshotBounds): SnapshotBounds =>
  bounds.map((value) => Math.round(value * 10) / 10) as unknown as SnapshotBounds;

const boxText = (bounds: SnapshotBounds) => roundBox(bounds).join(",");

function displayName(node: SnapshotNode): string | undefined {
  if (node.name === undefined) return undefined;
  return node.preserveTextWhitespace || node.textWhitespaceProven ? node.name : normalizeSnapshotText(node.name);
}

/**
 * Project structured AX fields for wire delivery. Page-supplied names and
 * values never become instructions to replace, add or remove an action ref.
 */
export function projectSnapshotNode(
  node: SnapshotNode,
  options: { fields?: readonly SnapshotField[]; actionNames?: "raw" | "program"; inlineRef?: boolean } = {},
): ProjectedSnapshotNode {
  if (!Number.isSafeInteger(node.depth) || node.depth < 0) throw new RangeError("Snapshot depth must be a nonnegative integer");
  const fields = new Set(options.fields ?? allFields);
  const text = fields.has("text");
  const item: ProjectedSnapshotNode = {
    id: node.id,
    depth: node.depth,
    role: node.role,
    ...(text && node.nameUnknown ? { nameUnknown: true as const } : {}),
    ...(text && node.role === "RootWebArea" && node.layoutScope ? { coordinates: "frame-viewport" as const } : {}),
    ...(text && node.bounds ? { box: roundBox(node.bounds) } : {}),
    ...(node.childFrameRef || node.documentFrameRef ? { frameRef: node.childFrameRef ?? node.documentFrameRef } : {}),
    ...(node.ownerUnrepresented ? { ownerUnrepresented: true as const } : {}),
    ...(fields.has("ref") && node.ref ? { ref: node.ref } : {}),
  };

  if (text) {
    const fragments = node.textFragments;
    const sameBounds = fragments?.length === 1 && fragments[0]!.bounds && node.bounds
      && fragments[0]!.bounds!.every((value, index) => value === node.bounds![index]);
    if (fragments?.length === 1) {
      Object.assign(item, {
        name: fragments[0]!.text,
        ...(!sameBounds && fragments[0]!.bounds ? { textBox: roundBox(fragments[0]!.bounds!) } : {}),
      });
    } else if (fragments?.length) {
      Object.assign(item, {
        textParts: fragments.map((fragment) => ({
          text: fragment.text,
          ...(fragment.bounds ? { box: roundBox(fragment.bounds) } : {}),
        })),
      });
    } else {
      const name = displayName(node);
      if (name) Object.assign(item, { name });
    }
    if (node.value !== undefined) Object.assign(item, { value: node.value });
    if (node.valueUnknown) Object.assign(item, { valueUnknown: true as const });
    if (node.placeholder?.status === "unknown") Object.assign(item, { placeholder: "unknown" as const });
    else if (node.placeholder?.status === "visible") Object.assign(item, { placeholder: node.placeholder.text });
    if (node.selectedLabels?.length) Object.assign(item, { selected: [...node.selectedLabels] });
  }

  if (fields.has("actions") && node.actions?.length) {
    const actions = options.actionNames === "program"
      ? [...new Set(node.actions.flatMap((action) => action === "check" ? ["check_element", "uncheck_element"] : [toolActions[action] ?? action]))]
      : [...node.actions];
    Object.assign(item, { actions });
  }
  if (fields.has("state") && node.state) {
    const state: Partial<Record<SnapshotStateName, unknown>> = {};
    for (const key of stateNames) if (node.state[key] !== undefined) state[key] = node.state[key];
    if (Object.keys(state).length) Object.assign(item, { state });
  }
  return item;
}

/** Format a projected item as the legacy tree line for observe/snapshot strings. */
export function formatSnapshotItem(item: ProjectedSnapshotNode): string {
  if (item.path?.length) {
    return item.path.map((step) => formatSnapshotItem({ id: item.id, ...step })).join("\n");
  }
  const depth = item.depth ?? 0;
  const role = item.role ?? "generic";
  let line = `${"  ".repeat(depth)}- ${role}`;
  if (item.name !== undefined) {
    line += ` ${JSON.stringify(item.name)}`;
    if (item.textBox) line += ` [text-box=${boxText(item.textBox)}]`;
  } else if (item.textParts?.length) {
    line += ` [text-parts=${item.textParts.map((part) =>
      `${JSON.stringify(part.text)} @(${part.box ? boxText(part.box) : "unknown"})`).join("; ")}]`;
  }
  if (item.nameUnknown) line += " [name=unknown]";
  if (item.coordinates) line += " [coordinates=frame-viewport]";
  if (item.box) line += ` [box=${boxText(item.box)}]`;
  if (item.frameRef) line += ` [frameRef=${item.frameRef}]`;
  if (item.ownerUnrepresented) line += " [owner=unrepresented]";
  if (item.ref) line += ` [ref=${item.ref}]`;
  if (item.actions?.length) line += ` [actions=${item.actions.join(",")}]`;
  if (item.state) {
    const state = stateNames.filter((key) => item.state![key] !== undefined).map((key) => `${key}=${item.state![key]}`).join(" ");
    if (state) line += ` [${state}]`;
  }
  if (item.value !== undefined) line += `: ${JSON.stringify(item.value)}`;
  if (item.valueUnknown) line += " [value=unknown]";
  if (item.placeholder === "unknown") line += " [placeholder=unknown]";
  else if (item.placeholder !== undefined) line += ` [placeholder=${JSON.stringify(item.placeholder)}]`;
  if (item.selected?.length) line += ` [selected=${item.selected.map((label) => JSON.stringify(label)).join(",")}]`;
  if (item.count !== undefined) line += ` [count=${item.count}]`;
  if (item.boxes?.length) {
    const parts = item.boxes.map((run) => "box" in run
      ? `(${boxText(run.box)})`
      : `(${boxText(run.first)}) step=(${boxText(run.step)}) count=${run.count}`);
    line += ` [boxes=${parts.join("; ")}]`;
  }
  return line;
}

/**
 * Render from structured AX fields into a legacy line. Prefer
 * `projectSnapshotNode` for wire delivery.
 */
export function renderSnapshotNode(
  node: SnapshotNode,
  options: { fields?: readonly SnapshotField[]; actionNames?: "raw" | "program"; inlineRef?: boolean } = {},
): RenderedSnapshotNode {
  const projected = projectSnapshotNode(node, options);
  const forLine = options.inlineRef === false && projected.ref
    ? (({ ref: _ref, ...rest }) => rest)(projected)
    : projected;
  return { id: node.id, line: formatSnapshotItem(forLine), ...(projected.ref ? { ref: projected.ref } : {}) };
}
