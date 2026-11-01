import { describe, expect, it } from "vitest";
import { paginateSnapshot, type SnapshotItem } from "./snapshot-pagination";
import { snapshotLookahead } from "./snapshot-lookahead";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function sample(line = `- button "${"海🌊".repeat(2500)}"`): SnapshotItem[] {
  return [
    { id: "root", line: "- main" },
    { id: "long", ref: "ref-long", line },
    { id: "next", ref: "ref-next", line: '  - button "Next"' },
    { id: "status", line: '  - status "Ready"' },
  ];
}

describe("snapshot lookahead", () => {
  it("uses spare bytes for separate complete rows while preserving a reconstructible primary cursor", () => {
    const source = sample(), before = structuredClone(source), budget = 12_000;
    const original = paginateSnapshot(source, { budget });
    const { page, lookahead, combinedBytes } = snapshotLookahead(source, original, { budget, mode: "full" });
    const originalLast = original.fragments.at(-1)!, shortened = page.fragments.at(-1)!;
    expect(originalLast.fragment?.start).toBe(0);
    expect(shortened.line.length).toBeGreaterThanOrEqual(512);
    expect(shortened.line.slice(0, 255)).toBe(originalLast.line.slice(0, 255));
    expect(shortened.line.length > 256).toBe(originalLast.line.length > 256);
    expect(shortened.line + source[1]!.line.slice(page.next!.charOffset)).toBe(source[1]!.line);
    expect(page.next).toEqual({ index: 1, charOffset: shortened.line.length });
    expect(shortened.fragment).toEqual({ index: 1, start: 0, end: shortened.line.length, total: source[1]!.line.length });
    expect(page.usedBytes).toBe(bytes(page.fragments));
    expect(lookahead).toEqual({ nonAuthoritative: true, items: [
      { index: 2, id: source[2]!.id, line: source[2]!.line }, { index: 3, id: source[3]!.id, line: source[3]!.line },
    ] });
    expect(combinedBytes).toBe(bytes({ items: page.fragments, lookahead }));
    expect(combinedBytes).toBeLessThanOrEqual(budget);
    expect(source).toEqual(before);
    const reconstructed = new Map<string, string>();
    let current = page;
    for (;;) {
      for (const item of current.fragments) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + item.line);
      if (!current.next) break;
      current = paginateSnapshot(source, { budget, position: current.next });
    }
    expect([...reconstructed]).toEqual(source.map(({ id, line }) => [id, line]));
    expect(original.fragments.at(-1)?.line).toBe(originalLast.line);
  });

  it("does not split a surrogate pair at the minimum prefix", () => {
    const source = sample("x".repeat(511) + "😀" + "y".repeat(5000)), budget = 4000;
    const original = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, original, { budget, mode: "full" });
    expect(result.page.fragments.at(-1)?.line.length).toBe(513);
    expect(result.page.fragments.at(-1)?.line.endsWith("😀")).toBe(true);
    expect(result.page.next?.charOffset).toBe(513);
  });

  it("does not put long later rows or partial rows in the preview", () => {
    const source = sample();
    source.splice(2, 0, { id: "large", line: '"' + "z".repeat(700) + '"' });
    const budget = 12_000, page = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, page, { budget, mode: "full" });
    expect(result.lookahead?.items.map((item) => item.id)).toEqual(["next", "status"]);
  });

  it("accounts exactly for escaped JSON and retains only preview rows that fit", () => {
    const source = sample("x".repeat(5000));
    source[2] = { id: "escaped", ref: "r\\\"", line: '\\"\n'.repeat(80) };
    const budget = 1000, original = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, original, { budget, mode: "full" });
    expect(result.lookahead).toBeDefined();
    expect(result.combinedBytes).toBe(bytes({ items: result.page.fragments, lookahead: result.lookahead }));
    expect(result.combinedBytes).toBeLessThanOrEqual(budget);
    for (const { index, ...item } of result.lookahead!.items) expect(source[index]).toEqual(item);
  });

  it("preserves the original page when no complete candidate can fit", () => {
    const source = sample("x".repeat(5000));
    source.splice(2, 2, { id: "long-again", line: "z".repeat(600) });
    const original = paginateSnapshot(source, { budget: 1000 });
    expect(snapshotLookahead(source, original, { budget: 1000, mode: "full" })).toEqual({ page: original });
  });

  it("returns the original page if even a complete short row cannot fit with its identity", () => {
    const source = sample("x".repeat(5000));
    source.splice(2, 2, { id: "huge-id-" + "x".repeat(2000), line: "short" });
    const original = paginateSnapshot(source, { budget: 1000 });
    expect(snapshotLookahead(source, original, { budget: 1000, mode: "full" })).toEqual({ page: original });
  });

  it.each([
    { mode: "delta" as const }, { mode: "full" as const, limit: 1 },
    { mode: "full" as const, position: { index: 0, charOffset: 1 } },
    { mode: "full" as const, position: { index: 1, charOffset: 0 } },
  ])("does not preview deltas, explicit limits, or continuation positions", (options) => {
    const source = sample(), page = paginateSnapshot(source, { budget: 12_000 });
    expect(snapshotLookahead(source, page, { budget: 12_000, ...options })).toEqual({ page });
  });

  it("leaves already complete, short-fragment, and final-row pages unchanged", () => {
    const complete = sample("short"), done = paginateSnapshot(complete, { budget: 12_000 });
    expect(snapshotLookahead(complete, done, { budget: 12_000, mode: "full" })).toEqual({ page: done });
    const source = sample("x".repeat(5000)), small = paginateSnapshot(source, { budget: 300 });
    expect(snapshotLookahead(source, small, { budget: 300, mode: "full" })).toEqual({ page: small });
    const final = source.slice(0, 2), end = paginateSnapshot(final, { budget: 2000 });
    expect(snapshotLookahead(final, end, { budget: 2000, mode: "full" })).toEqual({ page: end });
  });
});
