import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode } from "./snapshot-render";

export type ReadableSnapshot = {
  url: string; title: string;
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  rows: Array<{ text: string; depth: number; bounds: [number, number, number, number] }>;
};

export { sampleReadableSnapshot } from "./snapshot-readable-source.js";

export function readableSnapshot(value: ReadableSnapshot): SnapshotLine[] {
  if (!value || !Array.isArray(value.rows) || typeof value.url !== "string" || typeof value.title !== "string"
    || ![value.viewport?.x, value.viewport?.y, value.viewport?.width, value.viewport?.height, value.viewport?.scale].every(Number.isFinite)
    || value.viewport.width <= 0 || value.viewport.height <= 0 || value.viewport.scale <= 0) throw new Error("Invalid read-only observation");
  return value.rows.map(({ text, depth, bounds }, index) => {
    if (typeof text !== "string" || !Number.isSafeInteger(depth) || depth < 0 || !Array.isArray(bounds) || bounds.length !== 4
      || !bounds.every(Number.isFinite) || bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= 0 || bounds[3] <= 0
      || bounds[0] + bounds[2] > value.viewport.width || bounds[1] + bounds[3] > value.viewport.height) throw new Error("Invalid read-only text");
    const node = { id: `readonly:${index}`, role: "text", name: text, depth, bounds, preserveTextWhitespace: true };
    return { ...renderSnapshotNode(node), node };
  });
}
