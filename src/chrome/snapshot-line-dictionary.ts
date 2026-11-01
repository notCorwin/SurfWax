/**
 * Page-local dictionary for repeated snapshot fragments. A numeric `line` is
 * an index into this page's dictionary; string lines remain literal. Numeric
 * indices never replace ids, action refs, positions or fragment metadata.
 * Lines on any item with an own `ref` field always remain literal, so the
 * canonical action-receipt reader continues to see its target label.
 *
 * This module does not paginate or change cursors. A caller must budget the
 * encoded items *and* dictionary, and decode each page before reconstructing
 * split lines or applying a delta. The page envelope must reserve the field
 * name `lineDictionary`; dictionaries cannot be shared between pages.
 */
export type LineDictionaryPage<T extends { line: string }> = Readonly<{
  items: readonly (Omit<T, "line"> & { line: string | number })[];
  lineDictionary?: readonly string[];
}>;

// No individual page's dictionary may exceed the existing wire ceiling.
// A larger repeated line remains literal, preserving it without truncation.
export const MAX_SNAPSHOT_LINE_DICTIONARY_BYTES = 16 * 1024;
const MIN_SAVINGS_BYTES = 32;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** Encode only when the complete {items,lineDictionary} JSON is smaller by a
 * conservative margin. Byte savings do not guarantee savings for every model
 * tokenizer; measure the actual model and task separately. */
export function encodeSnapshotLines<T extends { line: string }>(items: readonly T[]): LineDictionaryPage<T> {
  const counts = new Map<string, { count: number; bytes: number; order: number }>();
  for (const item of items) {
    if (typeof item.line !== "string") throw new TypeError("Snapshot line must be a string");
    if (Object.hasOwn(item, "ref")) continue;
    const prior = counts.get(item.line);
    if (prior) prior.count++;
    else counts.set(item.line, { count: 1, bytes: jsonBytes(item.line), order: counts.size });
  }
  const candidates = [...counts].filter(([, info]) => info.count > 1)
    .sort((a, b) => (b[1].count - 1) * b[1].bytes - (a[1].count - 1) * a[1].bytes || a[1].order - b[1].order);
  const lineDictionary: string[] = [], indices = new Map<string, number>();
  let dictionaryBytes = 2; // []
  for (const [line, info] of candidates) {
    // Repeated indentation can be a single or very few tokenizer tokens even
    // when it takes many bytes. Avoid the observed low-repeat regression; this
    // is a heuristic, not a guarantee for any particular model tokenizer.
    const indentation = line.length - line.trimStart().length;
    if (info.count <= 3 && indentation >= 32 && indentation >= line.length - indentation) continue;
    const separator = lineDictionary.length ? 1 : 0;
    const indexBytes = String(lineDictionary.length).length;
    // Exclude entries that cannot pay even their own dictionary/indices cost.
    if ((info.count - 1) * info.bytes <= info.count * indexBytes + separator
      || dictionaryBytes + separator + info.bytes > MAX_SNAPSHOT_LINE_DICTIONARY_BYTES) continue;
    indices.set(line, lineDictionary.length);
    lineDictionary.push(line);
    dictionaryBytes += separator + info.bytes;
  }
  if (!lineDictionary.length) return { items };
  const encoded = items.map((item) => ({ ...item, line: Object.hasOwn(item, "ref") ? item.line : indices.get(item.line) ?? item.line }));
  const result: LineDictionaryPage<T> = { items: encoded, lineDictionary };
  return jsonBytes({ items }) - jsonBytes(result) >= MIN_SAVINGS_BYTES ? result : { items };
}

/** Decode one page before applying deltas or joining UTF-16 fragments. */
export function decodeSnapshotLines<T extends { line: string }>(page: LineDictionaryPage<T>): T[] {
  if (!Array.isArray(page.items) || page.lineDictionary !== undefined &&
    (!Array.isArray(page.lineDictionary) || page.lineDictionary.some((value) => typeof value !== "string")))
    throw new TypeError("Invalid snapshot line dictionary");
  return page.items.map((item) => {
    if (typeof item.line === "string") return { ...item } as T;
    if (!Number.isSafeInteger(item.line) || item.line < 0 || !page.lineDictionary || item.line >= page.lineDictionary.length)
      throw new RangeError("Invalid snapshot line dictionary index");
    return { ...item, line: page.lineDictionary[item.line]! } as T;
  });
}
