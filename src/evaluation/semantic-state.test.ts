// @vitest-environment node
import { expect, it } from "vitest";
import { applySemanticDelta, deliveredSemanticState, SemanticPages } from "../../e2e/evaluation/semantic-state";

it("reassembles ordered UTF-16 fragments across frozen pages and applies identity-based changes", () => {
  const pages = new SemanticPages();
  expect(pages.append({ observationId: "one", documentId: 1, mode: "full", items: [
    { id: "a", role: "button", name: "海🌊", actionable: true, fragment: { index: 0, field: "name", start: 0, end: 3, total: 5 } },
  ], nextCursor: "next", truncation: { baselineComplete: false } })).toBe("next");
  expect(pages.append({ observationId: "one", documentId: 1, mode: "full", items: [
    { id: "a", role: "button", name: "ab", actionable: true, fragment: { index: 0, field: "name", start: 3, end: 5, total: 5 } },
    { id: "b", role: "button", name: "Same" }, { id: "c", role: "button", name: "Same" },
  ], truncation: { baselineComplete: true } }, "next")).toBeUndefined();
  expect(pages.fragments).toBe(2);
  const baseline = pages.result().items;
  expect(baseline).toEqual([{ id: "a", role: "button", name: "海🌊ab", actionable: true }, { id: "b", role: "button", name: "Same" }, { id: "c", role: "button", name: "Same" }]);
  expect(applySemanticDelta(baseline, [
    { id: "b", role: "button", name: "Same", change: "removed" },
    { id: "c", role: "button", name: "Changed", actionable: true, change: "updated", after: null },
    { id: "d", role: "button", name: "Same", change: "added", after: "c" },
  ])).toEqual([{ id: "c", role: "button", name: "Changed", actionable: true }, { id: "d", role: "button", name: "Same" }, { id: "a", role: "button", name: "海🌊ab", actionable: true }]);
});

it("rejects mixed observations, gaps, broken Unicode and invalid delta anchors", () => {
  const base = { observationId: "one", documentId: 1, mode: "full" as const, truncation: { baselineComplete: false } };
  const pages = new SemanticPages();
  pages.append({ ...base, items: [{ id: "a", role: "button", name: "x", fragment: { index: 0, field: "name", start: 0, end: 1, total: 2 } }], nextCursor: "next" });
  expect(() => pages.append({ ...base, observationId: "other", items: [] }, "next")).toThrow();
  expect(() => pages.append({ ...base, items: [{ id: "a", role: "button", name: "y", fragment: { index: 0, field: "name", start: 0, end: 1, total: 2 } }] }, "next")).toThrow();
  expect(() => new SemanticPages().append({ ...base, items: [{ id: "a", role: "button", name: "\ud83c", fragment: { index: 0, field: "name", start: 0, end: 1, total: 2 } }] })).toThrow();
  expect(() => applySemanticDelta([{ id: "a", role: "button", name: "x" }], [{ id: "b", role: "button", name: "y", change: "added", after: "missing" }])).toThrow();
});

it("reconstructs automatic changes using their explicit baseline chain rather than the preceding scope", () => {
  const page = (observationId: string, items: unknown[], extra: object = {}) => ({ observationId, documentId: 1, mode: "full", items, truncation: { baselineComplete: true }, ...extra });
  const events = [
    { type: "tool.finished", output: page("root", [{ id: "a", role: "button", name: "Visible" }, { id: "b", role: "button", name: "Before", actionable: true }]) },
    { type: "tool.finished", output: page("other-scope", [{ id: "unrelated", role: "button", name: "Different scope" }]) },
    { type: "tool.finished", output: { pageSnapshot: page("change", [{ id: "b", role: "button", name: "After", actionable: true, change: "updated", after: "a" }], { mode: "delta", baseObservationId: "root" }) } },
    { type: "tool.finished", output: { pageSnapshot: page("remove", [{ id: "a", change: "removed" }], { mode: "delta", baseObservationId: "change" }) } },
  ];
  expect(deliveredSemanticState(events, { observationId: "remove" })).toEqual([{ id: "b", role: "button", name: "After", actionable: true }]);
  expect(() => deliveredSemanticState(events.slice(1), { observationId: "remove" })).toThrow("Missing completely delivered semantic baseline root");
  const premature = [{ ...events[0]!, type: "automation.action.finished" }, ...events.slice(1)];
  expect(() => deliveredSemanticState(premature, { observationId: "remove" })).toThrow("Missing completely delivered semantic baseline root");
});

it("requires every baseline page and a stable baseline identity across continuation pages", () => {
  const first = { observationId: "root", documentId: 1, mode: "full" as const, items: [{ id: "a", role: "button", name: "A" }], nextCursor: "next", truncation: { baselineComplete: false } };
  const change = { observationId: "change", documentId: 1, mode: "delta" as const, baseObservationId: "root", items: [], truncation: { baselineComplete: true } };
  expect(() => deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: change }], change)).toThrow("Missing completely delivered semantic baseline root");
  const second = { ...first, nextCursor: undefined, items: [{ id: "b", role: "button", name: "B" }], truncation: { baselineComplete: true } };
  expect(() => deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: change }, { type: "tool.finished", output: second }], change)).toThrow("Missing completely delivered semantic baseline root");
  expect(deliveredSemanticState([{ type: "tool.finished", output: first }, { type: "tool.finished", output: second }, { type: "tool.finished", output: change }], change)).toEqual([{ id: "a", role: "button", name: "A" }, { id: "b", role: "button", name: "B" }]);
  const pages = new SemanticPages();
  pages.append({ ...change, nextCursor: "next", truncation: { baselineComplete: false } });
  expect(() => pages.append({ ...change, baseObservationId: "different" }, "next")).toThrow("Mixed semantic observations");
});
