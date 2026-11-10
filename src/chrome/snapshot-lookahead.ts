import { snapshotSliceTarget, type SnapshotItem, type SnapshotPage, type SnapshotPosition } from "./snapshot-pagination";

/** Informational only: these rows are not part of the ordered snapshot page. */
export type SnapshotLookahead = Readonly<{
  nonAuthoritative: true;
  items: readonly Readonly<{
    index: number;
    id: string;
    depth?: number;
    role?: string;
    name?: string;
    value?: string;
  }>[];
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
const MAX_PREVIEW_TEXT = 512;

function previewItem(index: number, item: SnapshotItem): SnapshotLookahead["items"][number] | undefined {
  if (item.change !== undefined || item.after !== undefined) return undefined;
  const name = typeof item.name === "string" ? item.name : undefined;
  const value = typeof item.value === "string" ? item.value : undefined;
  if ((name?.length ?? 0) > MAX_PREVIEW_TEXT || (value?.length ?? 0) > MAX_PREVIEW_TEXT) return undefined;
  return {
    index,
    id: item.id,
    ...(item.depth === undefined ? {} : { depth: item.depth }),
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(name === undefined ? {} : { name }),
    ...(value === undefined ? {} : { value }),
  };
}

/**
 * Spend part of an already-paginated first full page on complete later rows.
 * The main page remains a consecutive prefix and its cursor still points into
 * the original frozen string field. The lookahead neither advances the cursor
 * nor contributes to a complete baseline.
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
  if (!fragment || fragment.start !== 0 || fragment.end <= MIN_PREFIX
    || fragment.total <= fragment.end || page.next.index !== fragment.index || page.next.charOffset !== fragment.end
    || fragment.index < 0 || fragment.index + 1 >= source.length) return original;
  const sourceItem = source[fragment.index];
  const target = sourceItem ? snapshotSliceTarget(sourceItem) : undefined;
  const deliveredPrefix = fragment.field === "name" ? last.name
    : fragment.field === "value" ? last.value
    : (() => {
      const match = /^textParts\.(\d+)\.text$/.exec(fragment.field);
      return match && last.textParts?.[Number(match[1])]?.text;
    })();
  if (!sourceItem || !target || sourceItem.id !== last.id || sourceItem.ref !== last.ref || sourceItem.change !== undefined
    || sourceItem.after !== undefined || target.field !== fragment.field || target.text.length !== fragment.total
    || typeof deliveredPrefix !== "string" || !target.text.startsWith(deliveredPrefix) || deliveredPrefix.length !== fragment.end)
    return original;
  // Keep at least 512 UTF-16 units without ending between surrogate halves.
  const end = highSurrogate(target.text.charCodeAt(MIN_PREFIX - 1)) && lowSurrogate(target.text.charCodeAt(MIN_PREFIX))
    ? MIN_PREFIX + 1 : MIN_PREFIX;
  if (end >= fragment.end) return original;
  const shortenedText = target.text.slice(0, end);
  const shortenedBody = fragment.field === "name" ? { ...last, name: shortenedText }
    : fragment.field === "value" ? { ...last, value: shortenedText }
    : (() => {
      const match = /^textParts\.(\d+)\.text$/.exec(fragment.field)!;
      const partIndex = Number(match[1]);
      return {
        ...last,
        textParts: last.textParts!.map((part, index) => index === partIndex ? { ...part, text: shortenedText } : part),
      };
    })();
  const fragments = [...page.fragments.slice(0, -1), {
    ...shortenedBody,
    fragment: { ...fragment, end },
  }];
  const lookaheadItems: Array<SnapshotLookahead["items"][number]> = [];
  const lookahead: SnapshotLookahead = { nonAuthoritative: true, items: lookaheadItems };
  let combinedBytes = jsonBytes({ items: fragments, lookahead });
  if (combinedBytes > options.budget) return original;
  const previewEnd = Math.min(source.length, options.limit ?? source.length);
  for (let index = fragment.index + 1; index < previewEnd; index++) {
    const candidate = previewItem(index, source[index]!);
    if (!candidate) continue;
    const nextBytes = combinedBytes + (lookaheadItems.length ? 1 : 0) + jsonBytes(candidate);
    if (nextBytes > options.budget) continue;
    lookaheadItems.push(candidate);
    combinedBytes = nextBytes;
  }
  if (!lookaheadItems.length) return original;
  return { page: { ...page, fragments, usedBytes: jsonBytes(fragments), next: { index: fragment.index, charOffset: end } }, lookahead, combinedBytes };
}
