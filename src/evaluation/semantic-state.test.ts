// @vitest-environment node
import { expect, it } from "vitest";
import { applySemanticDelta, SemanticPages } from "../../e2e/evaluation/semantic-state";

it("reassembles ordered UTF-16 fragments across frozen pages and applies identity-based changes", () => {
  const pages = new SemanticPages();
  expect(pages.append({ observationId: "one", documentId: 1, mode: "full", items: [
    { id: "a", line: "海🌊", ref: "ref-a", fragment: { index: 0, start: 0, end: 3, total: 5 } },
  ], nextCursor: "next", truncation: { baselineComplete: false } })).toBe("next");
  expect(pages.append({ observationId: "one", documentId: 1, mode: "full", items: [
    { id: "a", line: "ab", ref: "ref-a", fragment: { index: 0, start: 3, end: 5, total: 5 } },
    { id: "b", line: "Same" }, { id: "c", line: "Same" },
  ], truncation: { baselineComplete: true } }, "next")).toBeUndefined();
  expect(pages.fragments).toBe(2);
  const baseline = pages.result().items;
  expect(baseline).toEqual([{ id: "a", line: "海🌊ab", ref: "ref-a" }, { id: "b", line: "Same" }, { id: "c", line: "Same" }]);
  expect(applySemanticDelta(baseline, [
    { id: "b", line: "Same", change: "removed" },
    { id: "c", line: "Changed", ref: "ref-c", change: "updated", after: null },
    { id: "d", line: "Same", change: "added", after: "c" },
  ])).toEqual([{ id: "c", line: "Changed", ref: "ref-c" }, { id: "d", line: "Same" }, { id: "a", line: "海🌊ab", ref: "ref-a" }]);
});

it("rejects mixed observations, gaps, broken Unicode and invalid delta anchors", () => {
  const base = { observationId: "one", documentId: 1, mode: "full" as const, truncation: { baselineComplete: false } };
  const pages = new SemanticPages();
  pages.append({ ...base, items: [{ id: "a", line: "x", fragment: { index: 0, start: 0, end: 1, total: 2 } }], nextCursor: "next" });
  expect(() => pages.append({ ...base, observationId: "other", items: [] }, "next")).toThrow();
  expect(() => pages.append({ ...base, items: [{ id: "a", line: "y", fragment: { index: 0, start: 0, end: 1, total: 2 } }] }, "next")).toThrow();
  expect(() => new SemanticPages().append({ ...base, items: [{ id: "a", line: "\ud83c", fragment: { index: 0, start: 0, end: 1, total: 2 } }] })).toThrow();
  expect(() => applySemanticDelta([{ id: "a", line: "x" }], [{ id: "b", line: "y", change: "added", after: "missing" }])).toThrow();
});

it("decodes each page's dictionary before reassembling fragments", () => {
  const pages = new SemanticPages();
  pages.append({ observationId: "one", documentId: 1, mode: "full", lineDictionary: ["海🌊"], items: [
    { id: "a", line: 0, fragment: { index: 0, start: 0, end: 3, total: 5 } },
  ], nextCursor: "next", truncation: { baselineComplete: false } });
  pages.append({ observationId: "one", documentId: 1, mode: "full", lineDictionary: ["ab"], items: [
    { id: "a", line: 0, fragment: { index: 0, start: 3, end: 5, total: 5 } },
  ], truncation: { baselineComplete: true } }, "next");
  expect(pages.result().items).toEqual([{ id: "a", line: "海🌊ab" }]);
  expect(() => new SemanticPages().append({ observationId: "bad", documentId: 1, mode: "full", items: [{ id: "x", line: 1 }],
    lineDictionary: ["only"], truncation: { baselineComplete: true } })).toThrow("Invalid semantic item");
});
