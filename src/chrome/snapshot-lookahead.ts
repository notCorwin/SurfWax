import type { SnapshotItem, SnapshotPage, SnapshotPosition } from "./snapshot-pagination";

/** Informational only: these rows are not part of the ordered snapshot page. */
export type SnapshotLookahead = Readonly<{
  nonAuthoritative: true;
  items: readonly Readonly<{ index: number; id: string; line: string }>[];
}>;

export type SnapshotLookaheadResult = Readonly<{
  page: SnapshotPage;
  lookahead?: SnapshotLookahead;
  /** UTF-8 JSON bytes for {items: page.fragments, lookahead}; absent without a preview. */
  combinedBytes?: number;
}>;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const highSurrogate = (value: number): boolean => value >= 0xd800 && value <= 0xdbff;
const lowSurrogate = (value: number): boolean => value >= 0xdc00 && value <= 0xdfff;
const MIN_PREFIX = 512;
const MAX_PREVIEW_LINE = 512;

/**
 * Spend part of an already-paginated first full page on complete later rows.
 * The main page remains a consecutive prefix and its cursor still points into
 * the original frozen line. The lookahead neither advances the cursor nor
 * contributes to a complete baseline. An explicit limit bounds the original
 * source window as well as the number of primary and preview rows combined.
 *
 * Budget includes the exact JSON encoding of both payload fields:
 * UTF8(JSON.stringify({ items: page.fragments, lookahead })).byteLength.
 * page.usedBytes retains its existing definition: JSON bytes of fragments.
 * Previews carry no action refs; use the primary snapshot or a locator.
 */
export function snapshotLookahead(
  source: readonly SnapshotItem[],
  page: SnapshotPage,
  options: { budget: number; limit?: number; position?: SnapshotPosition; mode: "full" | "delta" },
): SnapshotLookaheadResult {
  const original: SnapshotLookaheadResult = { page };
  if (options.mode !== "full" || !Number.isSafeInteger(options.budget) || options.budget < 2
    || options.position && (options.position.index !== 0 || options.position.charOffset !== 0)
    || !page.hasMore || page.reason !== "budget" || !page.next || !page.fragments.length) return original;
  const last = page.fragments.at(-1)!, fragment = last.fragment;
  if (!fragment || fragment.start !== 0 || fragment.end !== last.line.length || fragment.end <= MIN_PREFIX
    || fragment.total <= fragment.end || page.next.index !== fragment.index || page.next.charOffset !== fragment.end
    || fragment.index < 0 || fragment.index + 1 >= source.length) return original;
  const sourceItem = source[fragment.index];
  if (!sourceItem || sourceItem.id !== last.id || sourceItem.ref !== last.ref || sourceItem.change !== undefined
    || sourceItem.after !== undefined || sourceItem.line.length !== fragment.total || !sourceItem.line.startsWith(last.line)) return original;
  // Keep at least 512 UTF-16 units without ending between surrogate halves.
  const end = highSurrogate(last.line.charCodeAt(MIN_PREFIX - 1)) && lowSurrogate(last.line.charCodeAt(MIN_PREFIX))
    ? MIN_PREFIX + 1 : MIN_PREFIX;
  if (end >= fragment.end) return original;
  const fragments = [...page.fragments.slice(0, -1), { ...last, line: last.line.slice(0, end), fragment: { ...fragment, end } }];
  const lookaheadItems: Array<{ index: number; id: string; line: string }> = [];
  const lookahead: SnapshotLookahead = { nonAuthoritative: true, items: lookaheadItems };
  let combinedBytes = jsonBytes({ items: fragments, lookahead });
  if (combinedBytes > options.budget) return original;
  const previewEnd = Math.min(source.length, options.limit ?? source.length);
  for (let index = fragment.index + 1; index < previewEnd; index++) {
    const item = source[index]!;
    // A preview never pretends that an incomplete long line is complete.
    if (item.line.length > MAX_PREVIEW_LINE || item.change !== undefined || item.after !== undefined) continue;
    const candidate = { index, id: item.id, line: item.line };
    const nextBytes = combinedBytes + (lookaheadItems.length ? 1 : 0) + jsonBytes(candidate);
    if (nextBytes > options.budget) continue;
    lookaheadItems.push(candidate);
    combinedBytes = nextBytes;
  }
  if (!lookaheadItems.length) return original;
  return { page: { ...page, fragments, usedBytes: jsonBytes(fragments), next: { index: fragment.index, charOffset: end } }, lookahead, combinedBytes };
}
