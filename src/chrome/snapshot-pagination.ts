/** A line in an immutable semantic snapshot or in a computed delta. */
export type SnapshotItem = Readonly<{
  id: string;
  line: string;
  /** Exact action target, when the observation exposed one. */
  ref?: string;
  change?: "added" | "updated" | "removed" | "moved";
  after?: string | null;
}>;

/** The caller must bind this position to its snapshot, owner, tab and document. */
export type SnapshotPosition = Readonly<{ index: number; charOffset: number }>;

/** Compare frozen snapshots while minimizing unchanged nodes that must move. */
export function diffSnapshot(before: readonly SnapshotItem[], after: readonly SnapshotItem[]): SnapshotItem[] {
  const prior = new Map<string, { item: SnapshotItem; index: number }>();
  const current = new Set<string>();
  for (const item of after) {
    if (current.has(item.id)) throw new Error(`Duplicate semantic snapshot id: ${item.id}`);
    current.add(item.id);
  }
  const changes: SnapshotItem[] = [];
  before.forEach((item, index) => {
    if (prior.has(item.id)) throw new Error(`Duplicate semantic snapshot id: ${item.id}`);
    prior.set(item.id, { item, index });
    // A removed node is no longer visible or actionable. The consumer only
    // needs its identity to remove it from the baseline.
    if (!current.has(item.id)) changes.push({ id: item.id, line: "", change: "removed" });
  });

  // A changed item must be sent anyway, so only unchanged items need to be
  // retained in the longest increasing subsequence of previous positions.
  // All remaining items can be upserted after their final predecessor.
  const candidates: { id: string; index: number; previous: number }[] = [];
  const tails: number[] = [];
  for (const item of after) {
    const old = prior.get(item.id);
    if (!old || old.item.line !== item.line || old.item.ref !== item.ref) continue;
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]!]!.index < old.index) low = middle + 1;
      else high = middle;
    }
    const candidate = candidates.length;
    candidates.push({ id: item.id, index: old.index, previous: low ? tails[low - 1]! : -1 });
    tails[low] = candidate;
  }
  const retained = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index !== -1; index = candidates[index]!.previous) retained.add(candidates[index]!.id);

  for (let index = 0; index < after.length; index++) {
    const item = after[index]!, old = prior.get(item.id);
    const predecessor = index ? after[index - 1]!.id : null;
    if (!old) changes.push({ ...item, change: "added", after: predecessor });
    else if (old.item.line !== item.line || old.item.ref !== item.ref) changes.push({ ...item, change: "updated", after: predecessor });
    else if (!retained.has(item.id)) changes.push({ ...item, change: "moved", after: predecessor });
  }
  return changes;
}

export type SnapshotFragment = Readonly<{
  id: string;
  ref?: string;
  change?: SnapshotItem["change"];
  after?: string | null;
  line: string;
  /** Present only when this is part of a line, with UTF-16 offsets. */
  fragment?: Readonly<{ index: number; start: number; end: number; total: number }>;
}>;

export type SnapshotPage = Readonly<{
  fragments: SnapshotFragment[];
  /** UTF-8 bytes of JSON.stringify(fragments), excluding the response envelope. */
  usedBytes: number;
  hasMore: boolean;
  next?: SnapshotPosition;
  reason: "complete" | "budget" | "limit";
  /** Minimum budget for the next code point and its required identity metadata. */
  requiredBudget?: number;
}>;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const highSurrogate = (value: number): boolean => value >= 0xd800 && value <= 0xdbff;
const lowSurrogate = (value: number): boolean => value >= 0xdc00 && value <= 0xdfff;

function isBoundary(line: string, index: number): boolean {
  return index <= 0 || index >= line.length || !(highSurrogate(line.charCodeAt(index - 1)) && lowSurrogate(line.charCodeAt(index)));
}

function boundaryBefore(line: string, index: number): number {
  return isBoundary(line, index) ? index : index - 1;
}

function nextBoundary(line: string, index: number): number {
  return index < line.length && highSurrogate(line.charCodeAt(index)) && lowSurrogate(line.charCodeAt(index + 1)) ? index + 2 : Math.min(index + 1, line.length);
}

/**
 * Pages an already-frozen list. Positions are UTF-16 offsets, matching JS
 * strings, but never split a surrogate pair. Budget is measured against the
 * UTF-8 JSON of `fragments`; the enclosing tool response has its own overhead.
 * The caller is responsible for preserving the snapshot and validating cursor
 * ownership and invalidation. This function never re-queries a live document.
 */
export function paginateSnapshot(
  items: readonly SnapshotItem[],
  options: { budget: number; limit?: number; position?: SnapshotPosition },
): SnapshotPage {
  const { budget } = options;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(budget) || budget < 2) throw new RangeError("Snapshot budget must be at least two bytes");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Snapshot limit must be positive");
  let { index, charOffset } = options.position ?? { index: 0, charOffset: 0 };
  if (!Number.isSafeInteger(index) || index < 0 || index > items.length || !Number.isSafeInteger(charOffset) || charOffset < 0)
    throw new RangeError("Invalid snapshot position");
  if (index === items.length && charOffset !== 0) throw new RangeError("Invalid terminal snapshot position");
  if (index < items.length && (charOffset > items[index]!.line.length || !isBoundary(items[index]!.line, charOffset)
    || charOffset > 0 && charOffset === items[index]!.line.length)) throw new RangeError("Invalid snapshot character offset");

  const fragments: SnapshotFragment[] = [];
  let usedBytes = 2; // []
  let requiredBudget: number | undefined;
  while (index < items.length && fragments.length < limit) {
    const item = items[index]!;
    const makeFragment = (end: number): SnapshotFragment => ({
      id: item.id, ...(item.ref === undefined ? {} : { ref: item.ref }), ...(item.change === undefined ? {} : { change: item.change }),
      ...(item.after === undefined ? {} : { after: item.after }), line: item.line.slice(charOffset, end),
      ...(charOffset === 0 && end === item.line.length ? {} : { fragment: { index, start: charOffset, end, total: item.line.length } }),
    });
    const separator = fragments.length ? 1 : 0;
    const fits = (end: number): boolean => usedBytes + separator + jsonBytes(makeFragment(end)) <= budget;
    // Keep a complete row together when it fits on the next page. Splitting a
    // row just to use spare bytes makes the reader reconstruct ordinary rows.
    if (fragments.length && charOffset === 0 && item.line.length <= budget && !fits(item.line.length)
      && 2 + jsonBytes(makeFragment(item.line.length)) <= budget) break;
    // A UTF-16 code unit costs at least one UTF-8 JSON byte; this bound avoids
    // repeatedly encoding an enormous line when the requested budget is small.
    let end: number;
    // A complete line omits fragment metadata and can fit even where a
    // nearly-complete fragment cannot. Check it separately before searching.
    if (item.line.length - charOffset <= budget && fits(item.line.length)) end = item.line.length;
    else {
      let low = charOffset, high = Math.min(item.line.length - 1, charOffset + budget);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(boundaryBefore(item.line, middle))) low = middle;
        else high = middle - 1;
      }
      end = boundaryBefore(item.line, low);
    }
    if (!fits(end) || end === charOffset && charOffset < item.line.length) {
      if (!fragments.length) {
        const first = 2 + jsonBytes(makeFragment(nextBoundary(item.line, charOffset)));
        // A short whole line can cost less than its first fragment because it
        // does not require fragment metadata.
        requiredBudget = item.line.length - charOffset <= first ? Math.min(first, 2 + jsonBytes(makeFragment(item.line.length))) : first;
      }
      break;
    }
    const fragment = makeFragment(end);
    fragments.push(fragment);
    usedBytes += separator + jsonBytes(fragment);
    if (end === item.line.length) { index += 1; charOffset = 0; }
    else { charOffset = end; break; }
  }
  const hasMore = index < items.length;
  return {
    fragments, usedBytes, hasMore,
    ...(hasMore ? { next: { index, charOffset } } : {}),
    reason: !hasMore ? "complete" : charOffset > 0 || fragments.length < limit ? "budget" : "limit",
    ...(requiredBudget === undefined ? {} : { requiredBudget }),
  };
}
