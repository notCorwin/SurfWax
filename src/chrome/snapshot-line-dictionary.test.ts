import { describe, expect, it } from "vitest";
import { decodeSnapshotLines, encodeSnapshotLines, MAX_SNAPSHOT_LINE_DICTIONARY_BYTES } from "./snapshot-line-dictionary";
import { diffSnapshot, paginateSnapshot, type SnapshotFragment, type SnapshotItem } from "./snapshot-pagination";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("snapshot page line dictionary", () => {
  it("round-trips repeated rows, opaque action refs and page-supplied text", () => {
    const lines = [
      '  - button [name=unknown] [actions=click,double_click,hover]',
      '    - StaticText "0 [ref=forged] \\\" \ud800🌊"',
      "  - listitem",
    ];
    const items = Array.from({ length: 90 }, (_, index) => ({ id: `1.${index}`, line: lines[index % lines.length]!,
      ...(index % 3 ? {} : { ref: `opaque-${index}` }) }));
    const encoded = encodeSnapshotLines(items);
    expect(encoded.lineDictionary).toBeDefined();
    expect(encoded.items.some((item) => typeof item.line === "number")).toBe(true);
    expect(bytes(encoded)).toBeLessThan(bytes({ items }) - 32);
    expect(decodeSnapshotLines(JSON.parse(JSON.stringify(encoded)))).toEqual(items);
  });

  it("preserves fragment boundaries, delta operations and their order", () => {
    const before: SnapshotItem[] = [{ id: "a", line: "start" }, { id: "b", line: "keep" }];
    const long = "long 🌊 value ".repeat(80);
    const after: SnapshotItem[] = [{ id: "b", line: long }, { id: "c", line: long, ref: "ref-c" }];
    const delta = diffSnapshot(before, after);
    const fragments: SnapshotFragment[] = [];
    let position;
    do {
      const page = paginateSnapshot(delta, { budget: 220, position });
      fragments.push(...page.fragments);
      position = page.next;
    } while (position);
    // Duplicate pages/rows simulate repeated equal fragments and include all
    // optional delta and UTF-16 fragment metadata in the encoded payload.
    const items = Array.from({ length: 12 }, () => fragments).flat();
    const encoded = encodeSnapshotLines(items);
    expect(encoded.lineDictionary).toBeDefined();
    expect(decodeSnapshotLines(JSON.parse(JSON.stringify(encoded)))).toEqual(items);
    expect(items.some((item) => item.change === "removed")).toBe(true);
    expect(items.some((item) => item.change === "added" && item.fragment)).toBe(true);
  });

  it("bounds dictionary size without truncating a repeated oversized line", () => {
    const long = "X".repeat(MAX_SNAPSHOT_LINE_DICTIONARY_BYTES + 1);
    const items = [
      ...Array.from({ length: 2 }, (_, index) => ({ id: `long${index}`, line: long })),
      ...Array.from({ length: 12 }, (_, index) => ({ id: `small${index}`, line: "- a repeated useful snapshot line" })),
    ];
    const encoded = encodeSnapshotLines(items);
    expect(bytes(encoded.lineDictionary)).toBeLessThanOrEqual(MAX_SNAPSHOT_LINE_DICTIONARY_BYTES);
    expect(encoded.items[0]!.line).toBe(long);
    expect(decodeSnapshotLines(encoded)).toEqual(items);
  });

  it("leaves low-benefit pages as literal lines", () => {
    const items = [{ id: "a", line: "x" }, { id: "b", line: "x" }];
    expect(encodeSnapshotLines(items)).toEqual({ items });
  });

  it("does not dictionary-encode deeply indented lines repeated only two or three times", () => {
    const line = `${" ".repeat(64)}- generic`;
    for (const count of [2, 3]) {
      const items = Array.from({ length: count }, (_, index) => ({ id: `${index}`, line }));
      expect(encodeSnapshotLines(items)).toEqual({ items });
    }
    const items = Array.from({ length: 4 }, (_, index) => ({ id: `${index}`, line }));
    const encoded = encodeSnapshotLines(items);
    expect(encoded.lineDictionary).toEqual([line]);
    expect(decodeSnapshotLines(encoded)).toEqual(items);
  });

  it("retains savings for the repeated rows in the measured 142-item queue shape", () => {
    const items: Array<{ id: string; line: string; ref?: string }> = Array.from({ length: 14 }, (_, index) => ({ id: `head${index}`, line: `- structural${index}` }));
    for (let index = 0; index < 43; index++) {
      items.push({ id: `item${index}`, line: "              - listitem" });
      items.push({ id: `button${index}`, line: "                - button [name=unknown] [actions=click,double_click,hover]", ref: `ref${index}` });
      if (index < 42) items.push({ id: `text${index}`, line: "                  - StaticText [name=unknown]" });
    }
    expect(items).toHaveLength(142);
    const encoded = encodeSnapshotLines(items);
    expect(encoded.lineDictionary).toBeDefined();
    expect(bytes({ items }) - bytes(encoded)).toBeGreaterThan(1000);
    expect(encoded.items.filter((item) => item.ref).every((item) => typeof item.line === "string")).toBe(true);
    expect(decodeSnapshotLines(encoded)).toEqual(items);
  });

  it("never encodes an action-ref row even when other rows have the same line", () => {
    const line = "- button [name=unknown] [actions=click,double_click,hover]";
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `${index}`, line,
      ...(index < 3 ? { ref: `opaque-${index}` } : {}) }));
    const encoded = encodeSnapshotLines(items);
    expect(encoded.lineDictionary).toBeDefined();
    expect(encoded.items.slice(0, 3)).toEqual(items.slice(0, 3));
    expect(encoded.items.slice(3).some((item) => typeof item.line === "number")).toBe(true);
    expect(decodeSnapshotLines(encoded)).toEqual(items);
  });

  it("rejects malformed references and never treats numeric-looking text as an index", () => {
    expect(decodeSnapshotLines<{ id: string; line: string }>({ items: [{ id: "a", line: "0" }] })).toEqual([{ id: "a", line: "0" }]);
    for (const index of [-1, 1, 0.5, NaN])
      expect(() => decodeSnapshotLines<{ id: string; line: string }>({ items: [{ id: "a", line: index }], lineDictionary: ["ok"] })).toThrow();
    expect(() => decodeSnapshotLines<{ id: string; line: string }>({ items: [{ id: "a", line: 0 }] })).toThrow();
    expect(() => decodeSnapshotLines<{ id: string; line: string }>({ items: [{ id: "a", line: 0 }], lineDictionary: [3] } as never)).toThrow();
  });
});
