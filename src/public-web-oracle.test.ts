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
