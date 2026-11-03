// @vitest-environment node
import { expect, it } from "vitest";
import { applySemanticDelta, deliveredSemanticState, SemanticPages } from "../../e2e/evaluation/semantic-state";

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

it("reconstructs automatic changes using their explicit baseline chain rather than the preceding scope", () => {
  const page = (observationId: string, items: unknown[], extra: object = {}) => ({ observationId, documentId: 1, mode: "full", items, truncation: { baselineComplete: true }, ...extra });
  const events = [
    { type: "tool.finished", output: page("root", [{ id: "a", line: "Visible" }, { id: "b", line: "Before", ref: "old" }]) },
    { type: "tool.finished", output: page("other-scope", [{ id: "unrelated", line: "Different scope" }]) },
    { type: "tool.finished", output: { pageSnapshot: page("change", [{ id: "b", line: "After", ref: "new", change: "updated", after: "a" }], { mode: "delta", baseObservationId: "root" }) } },
    { type: "tool.finished", output: { pageSnapshot: page("remove", [{ id: "a", line: "", change: "removed" }], { mode: "delta", baseObservationId: "change" }) } },
  ];
  expect(deliveredSemanticState(events, { observationId: "remove" })).toEqual([{ id: "b", line: "After", ref: "new" }]);
  expect(() => deliveredSemanticState(events.slice(1), { observationId: "remove" })).toThrow("Missing completely delivered semantic baseline root");
  const premature = [{ ...events[0]!, type: "automation.action.finished" }, ...events.slice(1)];
  expect(() => deliveredSemanticState(premature, { observationId: "remove" })).toThrow("Missing completely delivered semantic baseline root");
});

it("requires every baseline page and a stable baseline identity across continuation pages", () => {
  const first = { observationId: "root", documentId: 1, mode: "full" as const, items: [{ id: "a", line: "A" }], nextCursor: "next", truncation: { baselineComplete: false } };
  const change = { observationId: "change", documentId: 1, mode: "delta" as const, baseObservationId: "root", items: [], truncation: { baselineComplete: true } };
  expect(() => deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: change }], change)).toThrow("Missing completely delivered semantic baseline root");
  const second = { ...first, nextCursor: undefined, items: [{ id: "b", line: "B" }], truncation: { baselineComplete: true } };
  expect(() => deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: change }, { type: "tool.finished", output: second }], change)).toThrow("Missing completely delivered semantic baseline root");
  expect(deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: second }, { type: "tool.finished", output: change }], change)).toEqual([{ id: "a", line: "A" }, { id: "b", line: "B" }]);
  const pages = new SemanticPages();
  pages.append({ ...change, nextCursor: "next", truncation: { baselineComplete: false } });
  expect(() => pages.append({ ...change, baseObservationId: "different" }, "next")).toThrow("Mixed semantic observations");
});
