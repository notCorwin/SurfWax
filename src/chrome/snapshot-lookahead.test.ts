import { describe, expect, it } from "vitest";
import { paginateSnapshot, type SnapshotItem } from "./snapshot-pagination";
import { snapshotLookahead } from "./snapshot-lookahead";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const row = (id: string, name: string, extra: Partial<SnapshotItem> = {}): SnapshotItem =>
  ({ id, depth: 0, role: "button", name, ...extra });

function sample(name = "海🌊".repeat(2500)): SnapshotItem[] {
  return [
    row("root", "main", { role: "main" }),
    row("long", name, { ref: "ref-long" }),
    row("next", "Next", { depth: 1, ref: "ref-next" }),
    row("status", "Ready", { depth: 1, role: "status" }),
  ];
}

describe("snapshot lookahead", () => {
  it("uses spare bytes for separate complete rows while preserving a reconstructible primary cursor", () => {
    const source = sample(), before = structuredClone(source), budget = 12_000;
    const original = paginateSnapshot(source, { budget });
    const { page, lookahead, combinedBytes } = snapshotLookahead(source, original, { budget, mode: "full" });
    const originalLast = original.fragments.at(-1)!, shortened = page.fragments.at(-1)!;
    expect(originalLast.fragment?.start).toBe(0);
    expect(shortened.name!.length).toBeGreaterThanOrEqual(512);
    expect(shortened.name!.slice(0, 255)).toBe(originalLast.name!.slice(0, 255));
    expect(shortened.name!.length > 256).toBe(originalLast.name!.length > 256);
    expect(shortened.name! + source[1]!.name!.slice(page.next!.charOffset)).toBe(source[1]!.name);
    expect(page.next).toEqual({ index: 1, charOffset: shortened.name!.length });
    expect(shortened.fragment).toEqual({ index: 1, field: "name", start: 0, end: shortened.name!.length, total: source[1]!.name!.length });
    expect(page.usedBytes).toBe(bytes(page.fragments));
    expect(lookahead).toEqual({ nonAuthoritative: true, items: [
      { index: 2, id: source[2]!.id, depth: 1, role: "button", name: "Next" },
      { index: 3, id: source[3]!.id, depth: 1, role: "status", name: "Ready" },
    ] });
    expect(combinedBytes).toBe(bytes({ items: page.fragments, lookahead }));
    expect(combinedBytes).toBeLessThanOrEqual(budget);
    expect(source).toEqual(before);
    const reconstructed = new Map<string, string>();
    let current = page;
    for (;;) {
      for (const item of current.fragments) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + (item.name ?? ""));
      if (!current.next) break;
      current = paginateSnapshot(source, { budget, position: current.next });
    }
    expect([...reconstructed]).toEqual(source.map(({ id, name }) => [id, name]));
    expect(original.fragments.at(-1)?.name).toBe(originalLast.name);
  });

  it("does not split a surrogate pair at the minimum prefix", () => {
    const source = sample("x".repeat(511) + "😀" + "y".repeat(5000)), budget = 4000;
    const original = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, original, { budget, mode: "full" });
    expect(result.page.fragments.at(-1)?.name!.length).toBe(513);
    expect(result.page.fragments.at(-1)?.name!.endsWith("😀")).toBe(true);
    expect(result.page.next?.charOffset).toBe(513);
  });

  it("does not put long later rows or partial rows in the preview", () => {
    const source = sample();
    source.splice(2, 0, row("large", "z".repeat(700)));
    const budget = 12_000, page = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, page, { budget, mode: "full" });
    expect(result.lookahead?.items.map((item) => item.id)).toEqual(["next", "status"]);
  });

  it("accounts exactly for escaped JSON and retains only preview rows that fit", () => {
    const source = sample("x".repeat(5000));
    source[2] = row("escaped", '\\"\n'.repeat(80), { ref: "r\\\"" });
    const budget = 1000, original = paginateSnapshot(source, { budget });
    const result = snapshotLookahead(source, original, { budget, mode: "full" });
    expect(result.lookahead).toBeDefined();
    expect(result.combinedBytes).toBe(bytes({ items: result.page.fragments, lookahead: result.lookahead }));
    expect(result.combinedBytes).toBeLessThanOrEqual(budget);
    for (const item of result.lookahead!.items) {
      expect(source[item.index]!.id).toBe(item.id);
      expect(source[item.index]!.name).toBe(item.name);
    }
  });

  it("preserves the original page when no complete candidate can fit", () => {
    const source = sample("x".repeat(5000));
    source.splice(2, 2, row("long-again", "z".repeat(600)));
    const original = paginateSnapshot(source, { budget: 1000 });
    expect(snapshotLookahead(source, original, { budget: 1000, mode: "full" })).toEqual({ page: original });
  });

  it("returns the original page if even a complete short row cannot fit with its identity", () => {
    const source = sample("x".repeat(5000));
    source.splice(2, 2, row("huge-id-" + "x".repeat(2000), "short"));
    const original = paginateSnapshot(source, { budget: 1000 });
    expect(snapshotLookahead(source, original, { budget: 1000, mode: "full" })).toEqual({ page: original });
  });

  it("previews within an explicit source window while preserving the cursor and row limit", () => {
    const source = sample();
    source.splice(2, 0, row("skipped", "z".repeat(600)));
    for (let index = 0; index < 150; index++) source.push(row(`row-${index}`, `row ${index}`));
    const budget = 12_000, limit = 100;
    const original = paginateSnapshot(source, { budget, limit });
    const { page, lookahead, combinedBytes } = snapshotLookahead(source, original, { budget, limit, mode: "full" });
    expect(lookahead?.items.some((item) => item.id === "next")).toBe(true);
    expect(lookahead?.items.some((item) => item.id === "skipped")).toBe(false);
    expect(lookahead!.items.every((item) => item.index < limit)).toBe(true);
    expect(page.fragments.length + lookahead!.items.length).toBeLessThanOrEqual(limit);
    expect(combinedBytes).toBe(bytes({ items: page.fragments, lookahead }));
    expect(combinedBytes).toBeLessThanOrEqual(budget);
    const reconstructed = new Map<string, string>();
    let current = page;
    for (;;) {
      for (const item of current.fragments) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + (item.name ?? ""));
      if (!current.next) break;
      current = paginateSnapshot(source, { budget, limit, position: current.next });
    }
    expect([...reconstructed]).toEqual(source.map(({ id, name }) => [id, name]));
  });

  it("does not preview when primary fragments exhaust the explicit limit", () => {
    const source = sample(), budget = 12_000;
    const limit = 2, page = paginateSnapshot(source, { budget, limit });
    expect(page.reason).toBe("budget");
    expect(page.fragments).toHaveLength(limit);
    expect(snapshotLookahead(source, page, { budget, limit, mode: "full" })).toEqual({ page });
    const one = paginateSnapshot(source, { budget, limit: 1 });
    expect(snapshotLookahead(source, one, { budget, limit: 1, mode: "full" })).toEqual({ page: one });
  });

  it.each([
    { mode: "delta" as const },
    { mode: "full" as const, position: { index: 0, charOffset: 1 } },
    { mode: "full" as const, position: { index: 1, charOffset: 0 } },
  ])("does not preview deltas or continuation positions", (options) => {
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
