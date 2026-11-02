import { describe, expect, it } from "vitest";
import { diffSnapshot, paginateSnapshot, type SnapshotItem, type SnapshotPosition } from "./snapshot-pagination";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("semantic snapshot differences", () => {
  it("keeps removals, updates, insertions and moves in their respective snapshot order", () => {
    const before = [{ id: "a", line: "A" }, { id: "b", line: "B" }, { id: "c", line: "C" }, { id: "d", line: "D" }];
    const after = [{ id: "c", line: "new C", ref: "ref-c" }, { id: "a", line: "A" }, { id: "e", line: "E" }, { id: "d", line: "D" }];
    expect(diffSnapshot(before, after)).toEqual([
      { id: "b", line: "", change: "removed" },
      { id: "c", line: "new C", ref: "ref-c", change: "updated", after: null },
      { id: "e", line: "E", change: "added", after: "a" },
    ]);
  });

  it("paginates removals without exposing old text or refs and reconstructs mixed changes", () => {
    const before = [
      { id: "old-a", line: "hidden A ".repeat(1000), ref: "old-ref-a" },
      { id: "old-b", line: "hidden B", ref: "old-ref-b" },
      { id: "same", line: "kept", ref: "kept-ref" },
      { id: "changed", line: "old value", ref: "changed-ref" },
    ];
    const after = [
      { id: "changed", line: "new value", ref: "changed-ref" },
      { id: "same", line: "kept", ref: "kept-ref" },
      { id: "new", line: "new row", ref: "new-ref" },
    ];
    const changes = diffSnapshot(before, after);
    expect(changes.slice(0, 2)).toEqual([
      { id: "old-a", line: "", change: "removed" },
      { id: "old-b", line: "", change: "removed" },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/hidden|old-ref/);
    const delivered: SnapshotItem[] = [];
    let position: SnapshotPosition | undefined;
    do {
      const page = paginateSnapshot(changes, { budget: 160, limit: 1, position });
      expect(page.usedBytes).toBeLessThanOrEqual(160);
      expect(page.fragments).toHaveLength(1);
      expect(page.fragments[0]!.fragment).toBeUndefined();
      delivered.push(...page.fragments);
      position = page.next;
    } while (position);
    const reconstructed = before.map((item) => ({ ...item }));
    for (const change of delivered) {
      const index = reconstructed.findIndex((item) => item.id === change.id);
      if (change.change === "removed") { expect(index).toBeGreaterThanOrEqual(0); reconstructed.splice(index, 1); continue; }
      if (index >= 0) reconstructed.splice(index, 1);
      const predecessor = change.after === null ? -1 : reconstructed.findIndex((item) => item.id === change.after);
      expect(change.after === null || predecessor >= 0).toBe(true);
      reconstructed.splice(predecessor + 1, 0, { id: change.id, line: change.line, ref: change.ref! });
    }
    expect(reconstructed).toEqual(after);
  });

  it("handles large unchanged snapshots and a change at the end", () => {
    const before = Array.from({ length: 40_000 }, (_, index) => ({ id: `node-${index}`, line: `row ${index}` }));
    const after = before.map((item) => ({ ...item }));
    after[39_999]!.line = "updated";
    expect(diffSnapshot(before, after)).toEqual([{ id: "node-39999", line: "updated", change: "updated", after: "node-39998" }]);
  });

  it("represents a rotation with one move, in either direction", () => {
    const before = Array.from({ length: 10_000 }, (_, index) => ({ id: `row-${index}`, line: `row ${index}` }));
    expect(diffSnapshot(before, [...before.slice(1), before[0]!])).toEqual([
      { ...before[0], change: "moved", after: "row-9999" },
    ]);
    expect(diffSnapshot(before, [before.at(-1)!, ...before.slice(0, -1)])).toEqual([
      { ...before.at(-1), change: "moved", after: null },
    ]);
  });

  it("uses a required update to perform a move without moving unchanged items", () => {
    const before = [{ id: "a", line: "A" }, { id: "b", line: "B" }, { id: "c", line: "C" }];
    const after = [{ id: "b", line: "changed B" }, before[0]!, before[2]!];
    expect(diffSnapshot(before, after)).toEqual([{ id: "b", line: "changed B", change: "updated", after: null }]);
  });

  it("provides identities that reconstruct duplicate lines, embedded newlines and reordered content", () => {
    const before = [{ id: "one", line: "same\nvalue" }, { id: "two", line: "same\nvalue" }, { id: "three", line: "other" }];
    const after = [{ id: "two", line: "same\nvalue" }, { id: "three", line: "changed\nvalue" }, { id: "four", line: "same\nvalue" }];
    const original = paginateSnapshot(before, { budget: 10000 }).fragments;
    const delta = paginateSnapshot(diffSnapshot(before, after), { budget: 10000 }).fragments;
    const state = original.map(({ id, line }) => ({ id, line }));
    for (const item of delta) {
      const index = state.findIndex(({ id }) => id === item.id);
      if (item.change === "removed") { if (index >= 0) state.splice(index, 1); continue; }
      if (index >= 0) state.splice(index, 1);
      const position = item.after === null ? 0 : state.findIndex(({ id }) => id === item.after) + 1;
      state.splice(position, 0, { id: item.id, line: item.line });
    }
    expect(state).toEqual(after);
  });

  it("reports an updated ref even when visible text is unchanged", () => {
    expect(diffSnapshot([{ id: "a", line: "same", ref: "old" }], [{ id: "a", line: "same", ref: "new" }]))
      .toEqual([{ id: "a", line: "same", ref: "new", change: "updated", after: null }]);
  });

  it("reconstructs seeded combinations of additions, removals, updates and reorders", () => {
    let seed = 0x13579bdf;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let run = 0; run < 1000; run++) {
      const pool = Array.from({ length: 12 }, (_, index) => `node-${index}`);
      const shuffled = () => {
        const values = [...pool];
        for (let index = values.length - 1; index > 0; index--) {
          const other = random() % (index + 1);
          [values[index], values[other]] = [values[other]!, values[index]!];
        }
        return values;
      };
      const before = shuffled().filter(() => random() % 3 !== 0).map((id) => ({ id, line: `${id}-old`, ref: `ref-${id}` }));
      const after = shuffled().filter(() => random() % 3 !== 0).map((id) => ({ id, line: `${id}-${random() % 3 ? "old" : "new"}`, ref: `ref-${id}` }));
      const actual = before.map((item) => ({ ...item }));
      for (const change of diffSnapshot(before, after)) {
        const index = actual.findIndex((item) => item.id === change.id);
        if (index >= 0) actual.splice(index, 1);
        if (change.change === "removed") continue;
        const predecessor = change.after === null ? -1 : actual.findIndex((item) => item.id === change.after);
        expect(change.after === null || predecessor >= 0).toBe(true);
        actual.splice(predecessor + 1, 0, { id: change.id, line: change.line, ref: change.ref! });
      }
      expect(actual).toEqual(after);
    }
  });
});

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
      expect(fragment.fragment?.start ?? 0).toBe(recovered.length);
      expect(fragment.fragment?.end ?? fragment.line.length).toBeGreaterThan(fragment.fragment?.start ?? 0);
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
      { id: "a", line: "", change: "removed" },
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
    for (const item of items) {
      const parts = fragments.filter((fragment) => fragment.id === item.id);
      expect(parts.map((part) => part.line).join("")).toBe(item.line);
      expect(parts.every((part) => part.id === item.id && part.ref === item.ref && part.change === item.change && part.after === item.after)).toBe(true);
      expect(parts.at(-1)?.fragment?.end ?? item.line.length).toBe(item.line.length);
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
    expect(page).toMatchObject({ reason: "limit", next: { index: 1, charOffset: 0 }, fragments: [{ id: "a", line: "A" }] });
    expect(page.fragments[0]).not.toHaveProperty("fragment");
    expect(paginateSnapshot([{ id: "a", line: "x".repeat(1000) }], { budget: 120, limit: 1 })).toMatchObject({ reason: "budget", fragments: [{ fragment: { start: 0 } }] });
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
      const start = fragment.fragment?.start ?? 0, currentEnd = fragment.fragment?.end ?? line.length;
      expect(fragment.line).toBe(line.slice(start, currentEnd));
      if (currentEnd < line.length) {
        const following = Array.from(line.slice(currentEnd))[0]!;
        const end = currentEnd + following.length;
        const bigger = { id: fragment.id, line: line.slice(start, end), ...(end === line.length && start === 0 ? {} : { fragment: { index: 0, start, end, total: line.length } }) };
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
it("keeps a row whole on the next page when it fits there", () => {
  const rows = [{ id: "first", line: "a".repeat(60) }, { id: "second", line: "b".repeat(60), ref: "second-ref" }];
  const first = paginateSnapshot(rows, { budget: 187 });
  expect(first.fragments).toEqual([rows[0]]);
  expect(first.next).toEqual({ index: 1, charOffset: 0 });
  const second = paginateSnapshot(rows, { budget: 187, position: first.next });
  expect(second.fragments).toEqual([rows[1]]);
  expect(second.hasMore).toBe(false);
});
