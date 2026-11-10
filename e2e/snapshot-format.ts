import { formatSnapshotItem, type ProjectedSnapshotNode } from "../src/chrome/snapshot-render";

/** Structured inspect_page row, including delta/pagination extras. */
export type SnapshotWireItem = ProjectedSnapshotNode & {
  change?: "added" | "updated" | "removed" | "moved";
  after?: string | null;
};

/** Legacy tree line for string includes against structured inspect_page items. */
export function itemLine(item: SnapshotWireItem | Record<string, unknown> | undefined | null): string {
  if (!item || typeof item !== "object") return "";
  const row = item as SnapshotWireItem;
  if (row.role === undefined && row.change === "removed") return "";
  return formatSnapshotItem(row);
}

export function inspectText(items: readonly unknown[] | undefined): string {
  return (items ?? []).map((item) => itemLine(item as SnapshotWireItem)).join("\n");
}
