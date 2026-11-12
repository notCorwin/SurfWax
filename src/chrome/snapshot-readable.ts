import type { SnapshotLine } from "./snapshot-frame-tree";
import type { SnapshotBounds, SnapshotNode } from "./snapshot-render";
import { renderSnapshotNode } from "./snapshot-render";
import { compactSnapshot } from "./snapshot-presentation";

export type SnapshotCoverageGap = {
  reason: string;
  bounds?: SnapshotBounds;
  role?: string;
  count: number;
};
export type SampledSnapshotNode = {
  /** Document-bound transport identity. Never an action target. */
  key: number;
  target?: true;
  targetShadow?: true;
  parentKey?: number;
  role: string;
  text?: string;
  nameUnknown?: true;
  bounds?: SnapshotBounds;
  textFragments?: SnapshotNode["textFragments"];
  state?: SnapshotNode["state"];
  value?: string;
  valueUnknown?: true;
  selectedLabels?: SnapshotNode["selectedLabels"];
  placeholder?: SnapshotNode["placeholder"];
  depth: number;
};
/** Internal same-read evaluators supplied by the CDP caller, never tool parameters. */
export type NativeSnapshotProofs = {
  /** Same-query native ink bounds bound to the live marker owner; not text. */
  markerRects?: ReadonlyMap<Element, readonly { left: number; top: number; right: number; bottom: number }[]>;
  /** Complete CDP census of live roots, guarded against shadow-tree mutation. */
  shadowRoots?: readonly ShadowRoot[];
  placeholder: (this: HTMLInputElement | HTMLTextAreaElement, text: Text | null, expected: string) => unknown;
  controls: (this: Document, groups: { native: Array<{ expected: string }>; selects: Array<{ expected: string }>; selectHosts: object[] },
    frameUnobscured: boolean, noAuthorShadowRoots: boolean, ...objects: Node[]) => unknown;
};
export type ReadableSnapshot = {
  targetToken?: string;
  url: string;
  title: string;
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  rows: SampledSnapshotNode[];
  gaps: SnapshotCoverageGap[];
};

export { sampleReadableSnapshot } from "./snapshot-readable-source.js";

/** Preserve semantic nodes from the same synchronous read, then share presentation. */
export function readableSnapshot(value: ReadableSnapshot, elementId?: (key: number, token: string, shadow: boolean) => string): SnapshotLine[] {
  if (!value || !Array.isArray(value.rows) || !Array.isArray(value.gaps) || typeof value.url !== "string" || typeof value.title !== "string"
    || ![value.viewport?.x, value.viewport?.y, value.viewport?.width, value.viewport?.height, value.viewport?.scale].every(Number.isFinite)
    || value.viewport.width <= 0 || value.viewport.height <= 0 || value.viewport.scale <= 0) throw new Error("Invalid semantic observation");
  const box = (bounds: unknown): bounds is SnapshotBounds => Array.isArray(bounds) && bounds.length === 4
    && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0;
  const ids = new Map<number, SampledSnapshotNode>();
  for (const row of value.rows) {
    if (!row || !Number.isSafeInteger(row.key) || row.key <= 0 || ids.has(row.key)
      || typeof row.role !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(row.role)
      || !Number.isSafeInteger(row.depth) || row.depth < 0 || row.text !== undefined && typeof row.text !== "string"
      || row.value !== undefined && typeof row.value !== "string" || row.valueUnknown && row.value !== undefined
      || row.selectedLabels !== undefined && (!Array.isArray(row.selectedLabels) || row.selectedLabels.some((label) => typeof label !== "string"))
      || row.placeholder !== undefined && (!row.placeholder || !["visible", "unknown"].includes(row.placeholder.status)
        || row.placeholder.status === "visible" && typeof row.placeholder.text !== "string"
        || row.placeholder.status === "unknown" && "text" in row.placeholder)
      || row.bounds !== undefined && !box(row.bounds)
      || row.parentKey !== undefined && (!ids.has(row.parentKey) || ids.get(row.parentKey)!.depth + 1 !== row.depth)
      || row.parentKey === undefined && row.depth !== 0
      || row.textFragments !== undefined && (!Array.isArray(row.textFragments) || row.textFragments.some((fragment) => typeof fragment.text !== "string" || !box(fragment.bounds))))
      throw new Error("Invalid semantic node");
    ids.set(row.key, row);
  }
  if (value.gaps.some((gap) => !gap || typeof gap.reason !== "string" || !gap.reason
    || !Number.isSafeInteger(gap.count) || gap.count <= 0 || gap.bounds !== undefined && !box(gap.bounds)
    || gap.role !== undefined && typeof gap.role !== "string")) throw new Error("Invalid observation coverage");
  return compactSnapshot(value.rows.map((row) => {
    const target = row.target && value.targetToken && elementId ? elementId(row.key, value.targetToken, row.targetShadow === true) : undefined;
    const node: SnapshotNode = { id: `sample:${row.key}`, role: row.role, depth: row.depth,
      ...(target ? { ref: target, actions: ["click", "doubleClick", "hover"] } : {}),
      ...(row.text !== undefined ? { name: row.text, preserveTextWhitespace: true, textWhitespaceProven: true } : {}),
      ...(row.nameUnknown ? { nameUnknown: true } : {}), ...(row.bounds ? { bounds: row.bounds } : {}),
      ...(row.textFragments?.length ? { textFragments: row.textFragments } : {}), ...(row.state ? { state: row.state } : {}),
      ...(row.value !== undefined ? { value: row.value } : {}), ...(row.valueUnknown ? { valueUnknown: true } : {}),
      ...(row.selectedLabels?.length ? { selectedLabels: row.selectedLabels } : {}), ...(row.placeholder ? { placeholder: row.placeholder } : {}), layoutScope: "root" };
    return { ...renderSnapshotNode(node), node, ...(row.parentKey === undefined ? {} : { sourceParent: `sample:${row.parentKey}` }) };
  }));
}
