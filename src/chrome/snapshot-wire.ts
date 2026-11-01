import { paginateSnapshot, type SnapshotItem, type SnapshotPage, type SnapshotPosition } from "./snapshot-pagination";
import { snapshotLookahead, type SnapshotLookaheadResult } from "./snapshot-lookahead";

export type SnapshotWirePage = SnapshotLookaheadResult & { budget: number };
export class SnapshotWireError extends Error {}
/** Internal only: reserve, then finalize a page around terminal-log persistence. */
export const SNAPSHOT_DELIVERY_COMMIT = Symbol("snapshot-delivery-commit");
export type SnapshotDeliveryLease = { begin(): boolean; finish(): void; cancel(): void };
const encoder = new TextEncoder();

/** Select from one frozen source before committing its pagination position. */
export function selectSnapshotWirePage(
  source: readonly SnapshotItem[],
  options: { budget: number; limit?: number; position: SnapshotPosition; mode: "full" | "delta"; maxBytes: number; evidenceId: string },
  envelope: (candidate: SnapshotWirePage) => Record<string, unknown>,
): SnapshotWirePage {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2 || typeof options.evidenceId !== "string") throw new SnapshotWireError("Invalid inspection wire limit");
  let budget = options.budget, preview = true;
  // Each candidate is checked independently: lookahead can be non-monotonic.
  for (let attempt = 0; attempt < 128; attempt++) {
    const page: SnapshotPage = paginateSnapshot(source, { budget, limit: options.limit, position: options.position });
    const selected = preview ? snapshotLookahead(source, page, { budget, limit: options.limit, position: options.position, mode: options.mode }) : { page };
    const candidate: SnapshotWirePage = { ...selected, budget };
    const bytes = encoder.encode(JSON.stringify({ ...envelope(candidate), evidenceId: options.evidenceId })).byteLength;
    if (bytes <= options.maxBytes) {
      if (page.hasMore && !page.fragments.length) {
        if (page.requiredBudget === undefined || page.requiredBudget <= budget) throw new SnapshotWireError("Inspection cannot advance within wire limit");
        const minimumBudget = page.requiredBudget;
        preview = false;
        const minimum = paginateSnapshot(source, { budget: minimumBudget, limit: options.limit, position: options.position });
        const minimumCandidate: SnapshotWirePage = { page: minimum, budget: minimumBudget };
        if (!minimum.fragments.length || encoder.encode(JSON.stringify({ ...envelope(minimumCandidate), evidenceId: options.evidenceId })).byteLength > options.maxBytes)
          throw new SnapshotWireError("Inspection cannot advance within wire limit");
        // Preserve the caller's intentionally small budget and requiredBudget.
        if (budget === options.budget) return candidate;
        if (minimumBudget > options.budget) throw new SnapshotWireError("Inspection cannot advance within wire limit");
        return minimumCandidate;
      }
      return candidate;
    }
    if (preview && selected.lookahead) { preview = false; continue; }
    if (budget <= 2) break;
    // Recheck every result rather than assuming monotonicity; periodic halving
    // bounds work even for metadata whose byte size does not shrink.
    budget = Math.max(2, budget - Math.max(1, bytes - options.maxBytes, attempt % 8 === 7 ? Math.ceil(budget / 2) : 0));
  }
  throw new SnapshotWireError("Inspection cannot fit within wire limit");
}
