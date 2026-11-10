import { describe, expect, it } from "vitest";
import { selectSnapshotWirePage, SnapshotWireError, type SnapshotWirePage } from "./snapshot-wire";
import type { SnapshotItem } from "./snapshot-pagination";

const encoder = new TextEncoder();
const evidenceId = 'call-"🌊';
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const render = (candidate: SnapshotWirePage) => ({ observationId: "obs", url: "https://example.test/", title: 'title "🌊',
  items: candidate.page.fragments, ...(candidate.lookahead ? { lookahead: candidate.lookahead } : {}),
  nextCursor: candidate.page.next, truncation: { budget: candidate.budget, used: candidate.page.usedBytes, requiredBudget: candidate.page.requiredBudget } });
const row = (id: string, name: string): SnapshotItem => ({ id, depth: 0, role: "button", name });

describe("inspection wire budget", () => {
  it("splits oversized pages without losing UTF-16 content or exceeding the caller's items budget", () => {
    const source: SnapshotItem[] = Array.from({ length: 80 }, (_, index) => row(`node-${index}`, `row-${index}-${'🌊海"\\'.repeat(200)}`));
    const maxBytes = 3000, originalBudget = 30_000, reconstructed = new Map<string, string>();
    let position = { index: 0, charOffset: 0 }, pages = 0;
    for (;;) {
      const result = selectSnapshotWirePage(source, { budget: originalBudget, position, mode: "full", maxBytes, evidenceId }, render);
      expect(size({ ...render(result), evidenceId })).toBeLessThanOrEqual(maxBytes);
      expect(result.budget).toBeLessThanOrEqual(originalBudget);
      expect(result.page.usedBytes).toBeLessThanOrEqual(result.budget);
      for (const item of result.page.fragments) reconstructed.set(item.id, (reconstructed.get(item.id) ?? "") + (item.name ?? ""));
      pages++;
      if (!result.page.next) break;
      expect(result.page.next).not.toEqual(position);
      position = result.page.next;
      expect(pages).toBeLessThan(500);
    }
    expect([...reconstructed]).toEqual(source.map(({ id, name }) => [id, name]));
    expect(pages).toBeGreaterThan(1);
  });

  it("accounts for envelope and evidenceId and fails closed if metadata alone cannot fit", () => {
    const source = [row("id", "short")], position = { index: 0, charOffset: 0 };
    expect(() => selectSnapshotWirePage(source, { budget: 12000, position, mode: "full", maxBytes: 500, evidenceId: "x".repeat(1000) }, render)).toThrow(SnapshotWireError);
    expect(() => selectSnapshotWirePage(source, { budget: 12000, position, mode: "full", maxBytes: 500, evidenceId }, (candidate) => ({ ...render(candidate), title: "x".repeat(1000) }))).toThrow(SnapshotWireError);
  });

  it("preserves a caller's small budget only if requiredBudget can advance within the wire limit", () => {
    const source = [row("node", "text")], position = { index: 0, charOffset: 0 };
    const page = selectSnapshotWirePage(source, { budget: 2, position, mode: "full", maxBytes: 1000, evidenceId }, render);
    expect(page.page.fragments).toHaveLength(0);
    expect(page.page.requiredBudget).toBeGreaterThan(2);
    expect(() => selectSnapshotWirePage([row("x".repeat(1000), "text")], { budget: 2, position, mode: "full", maxBytes: 500, evidenceId }, render)).toThrow(SnapshotWireError);
  });
});
