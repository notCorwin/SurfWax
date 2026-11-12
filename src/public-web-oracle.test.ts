import { describe, expect, it } from "vitest";
import { gradeViteFacts, viteOracle } from "../e2e/public-web/vite-oracle";
import type { FrozenSource } from "../e2e/public-web/sources";

const versions = ["5.4.0", "6.0.0", "7.0.0"];
const ranges = ["^18.0.0 || >=20.0.0", "^18.0.0 || ^20.0.0 || >=22.0.0", "^20.19.0 || >=22.12.0"];
const deps = [["^0.21.3", "^4.13.0"], ["^0.24.0", "^4.23.0"], ["^0.25.0", "^4.40.0"]];
const sources: FrozenSource[] = versions.map((version, i) => ({ url: `https://registry.npmjs.org/vite/${version}`, finalUrl: "", status: 200, fetchedAt: "", sha256: "", body: JSON.stringify({ version, engines: { node: ranges[i] }, dependencies: { esbuild: deps[i][0], rollup: deps[i][1] } }) }));

describe("Vite oracle", () => {
  it("rejects missing or changed source data", () => {
    expect(() => viteOracle(sources.slice(1))).toThrow();
    expect(() => viteOracle([{ ...sources[0], body: "{}" }, ...sources.slice(1)])).toThrow();
  });
  it("rejects empty, omitted, incorrect and fabricated source answers", () => {
    const oracle = viteOracle(sources);
    const valid = { highest_matching_candidate: "6.0.0", candidates: oracle.map(item => ({ ...item, sources: [`https://github.com/vitejs/vite/blob/v${item.vite_version}/packages/vite/package.json`] })) };
    expect(gradeViteFacts(valid, oracle)).toBe(true);
    expect(gradeViteFacts({}, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, candidates: valid.candidates.slice(1) }, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, highest_matching_candidate: "7.0.0" }, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, candidates: valid.candidates.map(item => ({ ...item, sources: ["https://example.com"] })) }, oracle)).toBe(false);
  });
});

import { canonicalUrl, finalAnswer, snapshotEvidence } from "../e2e/public-web/evidence";

it("accepts browser snapshot evidence only from actual completed tool outputs", () => {
  const snapshot = { url: "https://example.org/source/", observationId: "obs", items: [{ text: "source" }] };
  const events = [
    { id: 1, type: "conversation.message", content: { id: "a", role: "assistant", parts: [{ type: "text", text: JSON.stringify(snapshot) }] } },
    { id: 2, type: "tool.started", content: snapshot },
    { id: 3, type: "tool.failed", output: snapshot },
    { id: 4, type: "tool.finished", output: { pageSnapshot: snapshot } },
  ] as any;
  expect(snapshotEvidence(events)).toEqual([{ eventId: 4, url: snapshot.url, observationId: "obs", itemCount: 1, partial: false, text: JSON.stringify(snapshot.items), tabId: null, at: NaN }]);
  expect(canonicalUrl("https://example.org/source/#section")).toBe("https://example.org/source");
  expect(canonicalUrl("https://example.org/source?version=1")).not.toBe(canonicalUrl("https://example.org/source?version=2"));
});

it("does not grade an earlier correct draft when the last assistant message has no valid JSON", () => {
  const events = [
    { id: 1, type: "conversation.message", content: { id: "a", role: "assistant", parts: [{ type: "text", text: '```json\n{"results":[]}\n```' }] } },
    { id: 2, type: "conversation.message", content: { id: "b", role: "assistant", parts: [{ type: "text", text: "Unable to verify" }] } },
  ] as any;
  expect(finalAnswer(events)).toEqual({ text: "Unable to verify", value: null });
});

import { verifyBrowsing } from "../e2e/public-web/evidence";
it("requires relevant visible facts and honors newer navigation failures and language equivalence", () => {
  const url = "https://developer.chrome.com/docs/extensions/reference/api/userScripts";
  const docs = [{ url, status: 200, at: "2026-11-12T00:00:00.000Z", duringTask: false, pageId: 1, tabId: 1 }];
  const snapshots = [{ eventId: 4, url: url + "?hl=en", observationId: "obs", itemCount: 1, partial: false, text: "execute 135", tabId: 1, at: Date.parse(docs[0].at) + 1000 }];
  const required = [{ url, terms: ["execute", "135"] }];
  expect(verifyBrowsing(required, docs, snapshots).complete).toBe(true);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], partial: true }]).complete).toBe(false);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], tabId: 2 }]).complete).toBe(false);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], text: "unrelated" }]).complete).toBe(false);
  const blocked = verifyBrowsing(required, [...docs, { ...docs[0], status: 403, duringTask: true, at: "2026-11-12T00:00:02.000Z" }], snapshots);
  expect(blocked).toMatchObject({ complete: false, blocked: true });
});

import { nobelOracle, gradeNobel } from "../e2e/public-web/nobel-oracle";
it("rejects incomplete Nobel sources, missing co-laureates, duplicates and rounded near-miss shares", () => {
  expect(() => nobelOracle({ body: '{"nobelPrizes":[]}' } as FrozenSource)).toThrow("incomplete");
  const expected = [[{ year: 2001, share: "1/2", names: ["A"], co: [["B"]], source_url: "https://www.nobelprize.org/prizes/chemistry/2001/summary/" }]];
  const award = { year: 2001, share: "2/4", co_laureates: ["B"], source_url: expected[0][0].source_url };
  const result = { name: "A", awards: [award] };
  expect(gradeNobel({ results: [result] }, expected)).toBe(true);
  for (const bad of [{ ...award, share: "9007199254740993/18014398509481984" }, { ...award, co_laureates: [] }])
    expect(gradeNobel({ results: [{ ...result, awards: [bad] }] }, expected)).toBe(false);
  expect(gradeNobel({ results: [result, result] }, expected)).toBe(false);
  expect(gradeNobel({ results: [] }, expected)).toBe(false);
});
