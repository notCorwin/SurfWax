import type { ProjectedSnapshotNode } from "./snapshot-render";

/** A structured row in an immutable semantic snapshot or computed delta. */
export type SnapshotItem = ProjectedSnapshotNode & Readonly<{
  change?: "added" | "updated" | "removed" | "moved";
  after?: string | null;
}>;

export type SnapshotFragmentField = string;

/** The caller must bind this position to its snapshot, owner, tab and document. */
export type SnapshotPosition = Readonly<{ index: number; charOffset: number }>;

const CONTENT_KEYS = [
  "depth", "role", "name", "nameUnknown", "box", "textBox", "textParts", "coordinates",
  "value", "valueUnknown", "placeholder", "selected", "frameRef", "ownerUnrepresented",
  "actionable", "ref", "actions", "state", "count", "boxes", "path",
] as const;

function contentKey(item: SnapshotItem): string {
  const payload: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) {
    const value = item[key];
    if (value !== undefined) payload[key] = value;
  }
  return JSON.stringify(payload);
}

/** Compare frozen snapshots while minimizing unchanged nodes that must move. */
export function diffSnapshot(before: readonly SnapshotItem[], after: readonly SnapshotItem[]): SnapshotItem[] {
  const prior = new Map<string, { item: SnapshotItem; index: number; key: string }>();
  const current = new Set<string>();
  for (const item of after) {
    if (current.has(item.id)) throw new Error(`Duplicate semantic snapshot id: ${item.id}`);
    current.add(item.id);
  }
  const changes: SnapshotItem[] = [];
  before.forEach((item, index) => {
    if (prior.has(item.id)) throw new Error(`Duplicate semantic snapshot id: ${item.id}`);
    prior.set(item.id, { item, index, key: contentKey(item) });
    // A removed node is no longer visible or actionable. The consumer only
    // needs its identity to remove it from the baseline.
    if (!current.has(item.id)) changes.push({ id: item.id, change: "removed" });
  });

  // A changed item must be sent anyway, so only unchanged items need to be
  // retained in the longest increasing subsequence of previous positions.
  // All remaining items can be upserted after their final predecessor.
  const candidates: { id: string; index: number; previous: number }[] = [];
  const tails: number[] = [];
  for (const item of after) {
    const old = prior.get(item.id);
    if (!old || old.key !== contentKey(item)) continue;
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
    else if (old.key !== contentKey(item)) changes.push({ ...item, change: "updated", after: predecessor });
    else if (!retained.has(item.id)) changes.push({ ...item, change: "moved", after: predecessor });
  }
  return changes;
}

export type SnapshotFragment = SnapshotItem & Readonly<{
  /** Present only when this is part of a string field, with UTF-16 offsets. */
  fragment?: Readonly<{ index: number; field: SnapshotFragmentField; start: number; end: number; total: number }>;
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

function isBoundary(text: string, index: number): boolean {
  return index <= 0 || index >= text.length || !(highSurrogate(text.charCodeAt(index - 1)) && lowSurrogate(text.charCodeAt(index)));
}

function boundaryBefore(text: string, index: number): number {
  return isBoundary(text, index) ? index : index - 1;
}

function nextBoundary(text: string, index: number): number {
  return index < text.length && highSurrogate(text.charCodeAt(index)) && lowSurrogate(text.charCodeAt(index + 1)) ? index + 2 : Math.min(index + 1, text.length);
}

type SliceTarget = { field: SnapshotFragmentField; text: string };

/** Prefer name, then value, then the longest textParts entry. */
export function snapshotSliceTarget(item: SnapshotItem): SliceTarget | undefined {
  if (typeof item.name === "string") return { field: "name", text: item.name };
  if (typeof item.value === "string") return { field: "value", text: item.value };
  if (item.textParts?.length) {
    let best = 0;
    for (let index = 1; index < item.textParts.length; index++) {
      if ((item.textParts[index]!.text?.length ?? 0) > (item.textParts[best]!.text?.length ?? 0)) best = index;
    }
    const part = item.textParts[best]!;
    if (typeof part.text === "string") return { field: `textParts.${best}.text`, text: part.text };
  }
  return undefined;
}

function withSlicedField(item: SnapshotItem, field: SnapshotFragmentField, text: string): SnapshotItem {
  if (field === "name") return { ...item, name: text };
  if (field === "value") return { ...item, value: text };
  const match = /^textParts\.(\d+)\.text$/.exec(field);
  if (match && item.textParts) {
    const index = Number(match[1]);
    return {
      ...item,
      textParts: item.textParts.map((part, partIndex) => partIndex === index ? { ...part, text } : part),
    };
  }
  return item;
}

/**
 * Pages an already-frozen list. Whole items are preferred. Oversized items
 * slice name/value/textParts text with UTF-16 offsets that never split a
 * surrogate pair. Budget is measured against the UTF-8 JSON of `fragments`.
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

  const fragments: SnapshotFragment[] = [];
  let usedBytes = 2; // []
  let requiredBudget: number | undefined;

  while (index < items.length && fragments.length < limit) {
    const item = items[index]!;
    const target = snapshotSliceTarget(item);
    if (charOffset > 0) {
      if (!target || charOffset > target.text.length || !isBoundary(target.text, charOffset)
        || charOffset === target.text.length) throw new RangeError("Invalid snapshot character offset");
    }

    const makeWhole = (): SnapshotFragment => ({ ...item });
    const makeSlice = (end: number): SnapshotFragment => {
      if (!target) throw new RangeError("Invalid snapshot character offset");
      const sliced = withSlicedField(item, target.field, target.text.slice(charOffset, end));
      return {
        ...sliced,
        ...(charOffset === 0 && end === target.text.length ? {} : {
          fragment: { index, field: target.field, start: charOffset, end, total: target.text.length },
        }),
      };
    };

    const separator = fragments.length ? 1 : 0;
    const fitsWhole = (): boolean => usedBytes + separator + jsonBytes(makeWhole()) <= budget;
    const fitsSlice = (end: number): boolean => usedBytes + separator + jsonBytes(makeSlice(end)) <= budget;

    // Prefer keeping a complete row together when it fits on the next page.
    if (fragments.length && charOffset === 0 && jsonBytes(makeWhole()) <= budget && !fitsWhole()
      && 2 + jsonBytes(makeWhole()) <= budget) break;

    if (charOffset === 0 && fitsWhole()) {
      const fragment = makeWhole();
      fragments.push(fragment);
      usedBytes += separator + jsonBytes(fragment);
      index += 1;
      charOffset = 0;
      continue;
    }

    if (!target) {
      if (!fragments.length) requiredBudget = 2 + jsonBytes(makeWhole());
      break;
    }

    let end: number;
    if (target.text.length - charOffset <= budget && fitsSlice(target.text.length)) end = target.text.length;
    else {
      let low = charOffset, high = Math.min(target.text.length - 1, charOffset + budget);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fitsSlice(boundaryBefore(target.text, middle))) low = middle;
        else high = middle - 1;
      }
      end = boundaryBefore(target.text, low);
    }

    if (!fitsSlice(end) || end === charOffset && charOffset < target.text.length) {
      if (!fragments.length) {
        const first = 2 + jsonBytes(makeSlice(nextBoundary(target.text, charOffset)));
        requiredBudget = target.text.length - charOffset <= first
          ? Math.min(first, 2 + jsonBytes(makeSlice(target.text.length)))
          : first;
        // A whole item can cost less than a fragment with metadata.
        if (charOffset === 0) requiredBudget = Math.min(requiredBudget, 2 + jsonBytes(makeWhole()));
      }
      break;
    }

    const fragment = makeSlice(end);
    fragments.push(fragment);
    usedBytes += separator + jsonBytes(fragment);
    if (end === target.text.length) { index += 1; charOffset = 0; }
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
