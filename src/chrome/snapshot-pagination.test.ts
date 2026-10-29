import { describe, expect, it } from "vitest";
import { paginateSnapshot, type SnapshotItem, type SnapshotPosition } from "./snapshot-pagination";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("immutable semantic snapshot pagination", () => {
  it("recovers a very large line losslessly under a fixed JSON byte budget", () => {
    const line = `${"a\n\"\\😀".repeat(210_000)}end`;
    expect(line.length).toBeGreaterThan(1_000_000);
    const items: SnapshotItem[] = [{ id: "frame:1", line }];
    let position: SnapshotPosition | undefined;
    let recovered = "";
    let pages = 0;
    do {
      const page = paginateSnapshot(items, { budget: 2048, position });
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.usedBytes).toBeLessThanOrEqual(2048);
      expect(page.fragments).toHaveLength(1);
      const fragment = page.fragments[0]!;
      expect(fragment.start).toBe(recovered.length);
      expect(fragment.end).toBeGreaterThan(fragment.start);
      expect(fragment.line).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(fragment.line).not.toMatch(/^[\uDC00-\uDFFF]/);
      recovered += fragment.line;
      position = page.next;
      expect(++pages).toBeLessThan(5_000);
    } while (position);
    expect(recovered).toBe(line);
    expect(pages).toBeGreaterThan(1);
  });

  it("preserves delta identity, order, and change metadata across pages", () => {
    const items: SnapshotItem[] = [
      { id: "a", line: "alpha", change: "removed" },
      { id: "b", ref: "t3sabc123d0e1", line: "beta😀".repeat(80), change: "updated", after: "a" },
      { id: "c", line: "", change: "added", after: null },
    ];
    let position: SnapshotPosition | undefined;
    const fragments = [];
    do {
      const page = paginateSnapshot(items, { budget: 180, limit: 2, position });
      expect(page.usedBytes).toBeLessThanOrEqual(180);
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.fragments.length).toBeGreaterThan(0);
      fragments.push(...page.fragments);
      position = page.next;
    } while (position);
    expect(fragments.map(({ index }) => index)).toEqual([...fragments.map(({ index }) => index)].sort((a, b) => a - b));
    for (const [index, item] of items.entries()) {
      const parts = fragments.filter((fragment) => fragment.index === index);
      expect(parts.map((part) => part.line).join("")).toBe(item.line);
      expect(parts.every((part) => part.id === item.id && part.ref === item.ref && part.change === item.change && part.after === item.after)).toBe(true);
      expect(parts.at(-1)?.complete).toBe(true);
    }
  });

  it("reports the precise minimum budget when identity metadata does not fit", () => {
    const items = [{ id: "id".repeat(1000), line: "😀x" }];
    const first = paginateSnapshot(items, { budget: 100 });
    expect(first).toMatchObject({ fragments: [], hasMore: true, next: { index: 0, charOffset: 0 }, reason: "budget", requiredBudget: expect.any(Number) });
    expect(paginateSnapshot(items, { budget: first.requiredBudget! - 1 }).fragments).toEqual([]);
    const next = paginateSnapshot(items, { budget: first.requiredBudget! });
    expect(next.fragments[0]?.line.startsWith("😀")).toBe(true);
    expect(next.usedBytes).toBe(first.requiredBudget);
  });

  it("honors the item limit and distinguishes it from a partially returned item", () => {
    const items = [{ id: "a", line: "A" }, { id: "b", line: "B" }];
    const page = paginateSnapshot(items, { budget: 1000, limit: 1 });
    expect(page).toMatchObject({ reason: "limit", next: { index: 1, charOffset: 0 }, fragments: [{ line: "A", complete: true }] });
    expect(paginateSnapshot([{ id: "a", line: "x".repeat(1000) }], { budget: 120, limit: 1 })).toMatchObject({ reason: "budget", fragments: [{ complete: false }] });
  });

  it("uses the available budget without cutting escaped characters or Unicode pairs", () => {
    const line = "x😀\n\"\\中".repeat(8);
    for (let budget = 80; budget <= 200; budget++) {
      const page = paginateSnapshot([{ id: "node", line }], { budget });
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.usedBytes).toBeLessThanOrEqual(budget);
      if (!page.fragments.length) {
        expect(page.requiredBudget).toBeGreaterThan(budget);
        continue;
      }
      const fragment = page.fragments[0]!;
      expect(fragment.line).toBe(line.slice(fragment.start, fragment.end));
      if (!fragment.complete) {
        const following = Array.from(line.slice(fragment.end))[0]!;
        const end = fragment.end + following.length;
        const bigger = { ...fragment, end, complete: end === line.length, line: line.slice(fragment.start, end) };
        expect(bytes([bigger])).toBeGreaterThan(budget);
      }
    }
  });

  it("rejects invalid offsets, surrogate splits and invalid limits", () => {
    const items = [{ id: "a", line: "a😀b" }];
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 0, charOffset: 2 } })).toThrow("character offset");
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 1, charOffset: 1 } })).toThrow("terminal");
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 2, charOffset: 0 } })).toThrow("position");
    expect(() => paginateSnapshot(items, { budget: 1 })).toThrow("budget");
    expect(() => paginateSnapshot(items, { budget: 100, limit: 0 })).toThrow("limit");
    expect(paginateSnapshot([], { budget: 2 })).toEqual({ fragments: [], usedBytes: 2, hasMore: false, reason: "complete" });
  });
});
