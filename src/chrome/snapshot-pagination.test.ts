import { describe, expect, it } from "vitest";
import { diffSnapshot, paginateSnapshot, type SnapshotItem, type SnapshotPosition } from "./snapshot-pagination";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const row = (id: string, name: string, extra: Partial<SnapshotItem> = {}): SnapshotItem =>
  ({ id, depth: 0, role: "button", name, ...extra });

describe("semantic snapshot differences", () => {
  it("keeps removals, updates, insertions and moves in their respective snapshot order", () => {
    const before = [row("a", "A"), row("b", "B"), row("c", "C"), row("d", "D")];
    const after = [row("c", "new C", { ref: "ref-c" }), row("a", "A"), row("e", "E"), row("d", "D")];
    expect(diffSnapshot(before, after)).toEqual([
      { id: "b", change: "removed" },
      { ...row("c", "new C", { ref: "ref-c" }), change: "updated", after: null },
      { ...row("e", "E"), change: "added", after: "a" },
    ]);
  });

  it("paginates removals without exposing old text or refs and reconstructs mixed changes", () => {
    const before = [
      row("old-a", "hidden A ".repeat(1000), { ref: "old-ref-a" }),
      row("old-b", "hidden B", { ref: "old-ref-b" }),
      row("same", "kept", { ref: "kept-ref" }),
      row("changed", "old value", { ref: "changed-ref" }),
    ];
    const after = [
      row("changed", "new value", { ref: "changed-ref" }),
      row("same", "kept", { ref: "kept-ref" }),
      row("new", "new row", { ref: "new-ref" }),
    ];
    const changes = diffSnapshot(before, after);
    expect(changes.slice(0, 2)).toEqual([
      { id: "old-a", change: "removed" },
      { id: "old-b", change: "removed" },
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
      const { change: _c, after: _a, fragment: _f, ...body } = change as SnapshotItem & { fragment?: unknown };
      reconstructed.splice(predecessor + 1, 0, body);
    }
    expect(reconstructed).toEqual(after);
  });

  it("handles large unchanged snapshots and a change at the end", () => {
    const before = Array.from({ length: 40_000 }, (_, index) => row(`node-${index}`, `row ${index}`));
    const after = before.map((item) => ({ ...item }));
    after[39_999] = row("node-39999", "updated");
    expect(diffSnapshot(before, after)).toEqual([{ ...row("node-39999", "updated"), change: "updated", after: "node-39998" }]);
  });

  it("represents a rotation with one move, in either direction", () => {
    const before = Array.from({ length: 10_000 }, (_, index) => row(`row-${index}`, `row ${index}`));
    expect(diffSnapshot(before, [...before.slice(1), before[0]!])).toEqual([
      { ...before[0], change: "moved", after: "row-9999" },
    ]);
    expect(diffSnapshot(before, [before.at(-1)!, ...before.slice(0, -1)])).toEqual([
      { ...before.at(-1), change: "moved", after: null },
    ]);
  });

  it("uses a required update to perform a move without moving unchanged items", () => {
    const before = [row("a", "A"), row("b", "B"), row("c", "C")];
    const after = [row("b", "changed B"), before[0]!, before[2]!];
    expect(diffSnapshot(before, after)).toEqual([{ ...row("b", "changed B"), change: "updated", after: null }]);
  });

  it("provides identities that reconstruct duplicate names, embedded newlines and reordered content", () => {
    const before = [row("one", "same\nvalue"), row("two", "same\nvalue"), row("three", "other")];
    const after = [row("two", "same\nvalue"), row("three", "changed\nvalue"), row("four", "same\nvalue")];
    const original = paginateSnapshot(before, { budget: 10000 }).fragments;
    const delta = paginateSnapshot(diffSnapshot(before, after), { budget: 10000 }).fragments;
    const state = original.map(({ id, depth, role, name }) => ({ id, depth, role, name }));
    for (const item of delta) {
      const index = state.findIndex(({ id }) => id === item.id);
      if (item.change === "removed") { if (index >= 0) state.splice(index, 1); continue; }
      if (index >= 0) state.splice(index, 1);
      const position = item.after === null ? 0 : state.findIndex(({ id }) => id === item.after) + 1;
      state.splice(position, 0, { id: item.id, depth: item.depth, role: item.role, name: item.name });
    }
    expect(state).toEqual(after.map(({ id, depth, role, name }) => ({ id, depth, role, name })));
  });

  it("reports an updated ref even when visible text is unchanged", () => {
    expect(diffSnapshot([row("a", "same", { ref: "old" })], [row("a", "same", { ref: "new" })]))
      .toEqual([{ ...row("a", "same", { ref: "new" }), change: "updated", after: null }]);
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
      const before = shuffled().filter(() => random() % 3 !== 0).map((id) => row(id, `${id}-old`, { ref: `ref-${id}` }));
      const after = shuffled().filter(() => random() % 3 !== 0).map((id) => row(id, `${id}-${random() % 3 ? "old" : "new"}`, { ref: `ref-${id}` }));
      const actual = before.map((item) => ({ ...item }));
      for (const change of diffSnapshot(before, after)) {
        const index = actual.findIndex((item) => item.id === change.id);
        if (index >= 0) actual.splice(index, 1);
        if (change.change === "removed") continue;
        const predecessor = change.after === null ? -1 : actual.findIndex((item) => item.id === change.after);
        expect(change.after === null || predecessor >= 0).toBe(true);
        const { change: _c, after: _a, ...body } = change;
        actual.splice(predecessor + 1, 0, body);
      }
      expect(actual).toEqual(after);
    }
  });
});

describe("immutable semantic snapshot pagination", () => {
  it("recovers a very large name losslessly under a fixed JSON byte budget", () => {
    const name = `${"a\n\"\\😀".repeat(210_000)}end`;
    expect(name.length).toBeGreaterThan(1_000_000);
    const items: SnapshotItem[] = [row("frame:1", name)];
    let position: SnapshotPosition | undefined;
    let recovered = "";
    let pages = 0;
    do {
      const page = paginateSnapshot(items, { budget: 2048, position });
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.usedBytes).toBeLessThanOrEqual(2048);
      expect(page.fragments).toHaveLength(1);
      const fragment = page.fragments[0]!;
      expect(fragment.fragment?.field).toBe("name");
      expect(fragment.fragment?.start ?? 0).toBe(recovered.length);
      expect(fragment.fragment?.end ?? fragment.name!.length).toBeGreaterThan(fragment.fragment?.start ?? 0);
      expect(fragment.name!).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(fragment.name!).not.toMatch(/^[\uDC00-\uDFFF]/);
      recovered += fragment.name!;
      position = page.next;
      expect(++pages).toBeLessThan(5_000);
    } while (position);
    expect(recovered).toBe(name);
    expect(pages).toBeGreaterThan(1);
  });

  it("preserves delta identity, order, and change metadata across pages", () => {
    const items: SnapshotItem[] = [
      { id: "a", change: "removed" },
      { ...row("b", "beta😀".repeat(80), { ref: "t3sabc123d0e1" }), change: "updated", after: "a" },
      { id: "c", depth: 0, role: "status", change: "added", after: null },
    ];
    let position: SnapshotPosition | undefined;
    const fragments = [];
    do {
      const page = paginateSnapshot(items, { budget: 220, limit: 2, position });
      expect(page.usedBytes).toBeLessThanOrEqual(220);
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.fragments.length).toBeGreaterThan(0);
      fragments.push(...page.fragments);
      position = page.next;
    } while (position);
    for (const item of items) {
      const parts = fragments.filter((fragment) => fragment.id === item.id);
      expect(parts.map((part) => part.name ?? "").join("")).toBe(item.name ?? "");
      expect(parts.every((part) => part.id === item.id && part.ref === item.ref && part.change === item.change && part.after === item.after)).toBe(true);
      expect(parts.at(-1)?.fragment?.end ?? (item.name?.length ?? 0)).toBe(item.name?.length ?? 0);
    }
  });

  it("reports the precise minimum budget when identity metadata does not fit", () => {
    const items = [row("id".repeat(1000), "😀x")];
    const first = paginateSnapshot(items, { budget: 100 });
    expect(first).toMatchObject({ fragments: [], hasMore: true, next: { index: 0, charOffset: 0 }, reason: "budget", requiredBudget: expect.any(Number) });
    expect(paginateSnapshot(items, { budget: first.requiredBudget! - 1 }).fragments).toEqual([]);
    const next = paginateSnapshot(items, { budget: first.requiredBudget! });
    expect(next.fragments[0]?.name?.startsWith("😀")).toBe(true);
    expect(next.usedBytes).toBe(first.requiredBudget);
  });

  it("honors the item limit and distinguishes it from a partially returned item", () => {
    const items = [row("a", "A"), row("b", "B")];
    const page = paginateSnapshot(items, { budget: 1000, limit: 1 });
    expect(page).toMatchObject({ reason: "limit", next: { index: 1, charOffset: 0 }, fragments: [{ id: "a", name: "A" }] });
    expect(page.fragments[0]).not.toHaveProperty("fragment");
    expect(paginateSnapshot([row("a", "x".repeat(1000))], { budget: 180, limit: 1 })).toMatchObject({
      reason: "budget", fragments: [{ fragment: { start: 0, field: "name" } }],
    });
  });

  it("uses the available budget without cutting escaped characters or Unicode pairs", () => {
    const name = "x😀\n\"\\中".repeat(8);
    for (let budget = 120; budget <= 280; budget++) {
      const page = paginateSnapshot([row("node", name)], { budget });
      expect(page.usedBytes).toBe(bytes(page.fragments));
      expect(page.usedBytes).toBeLessThanOrEqual(budget);
      if (!page.fragments.length) {
        expect(page.requiredBudget).toBeGreaterThan(budget);
        continue;
      }
      const fragment = page.fragments[0]!;
      const start = fragment.fragment?.start ?? 0, currentEnd = fragment.fragment?.end ?? name.length;
      expect(fragment.name).toBe(name.slice(start, currentEnd));
      if (currentEnd < name.length) {
        const following = Array.from(name.slice(currentEnd))[0]!;
        const end = currentEnd + following.length;
        const bigger = {
          ...row("node", name.slice(start, end)),
          ...(end === name.length && start === 0 ? {} : { fragment: { index: 0, field: "name", start, end, total: name.length } }),
        };
        expect(bytes([bigger])).toBeGreaterThan(budget);
      }
    }
  });

  it("rejects invalid offsets, surrogate splits and invalid limits", () => {
    const items = [row("a", "a😀b")];
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 0, charOffset: 2 } })).toThrow("character offset");
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 1, charOffset: 1 } })).toThrow("terminal");
    expect(() => paginateSnapshot(items, { budget: 100, position: { index: 2, charOffset: 0 } })).toThrow("position");
    expect(() => paginateSnapshot(items, { budget: 1 })).toThrow("budget");
    expect(() => paginateSnapshot(items, { budget: 100, limit: 0 })).toThrow("limit");
    expect(paginateSnapshot([], { budget: 2 })).toEqual({ fragments: [], usedBytes: 2, hasMore: false, reason: "complete" });
  });
});

it("keeps a row whole on the next page when it fits there", () => {
  const rows = [row("first", "a".repeat(60)), row("second", "b".repeat(60), { ref: "second-ref" })];
  const first = paginateSnapshot(rows, { budget: 220 });
  expect(first.fragments).toEqual([rows[0]]);
  expect(first.next).toEqual({ index: 1, charOffset: 0 });
  const second = paginateSnapshot(rows, { budget: 220, position: first.next });
  expect(second.fragments).toEqual([rows[1]]);
  expect(second.hasMore).toBe(false);
});
