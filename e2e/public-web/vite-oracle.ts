import type { FrozenSource } from "./sources.ts";

const versions = ["5.4.0", "6.0.0", "7.0.0"] as const;
const nodes = ["18.20.0", "20.18.0", "20.19.0", "21.7.0", "22.11.0", "22.12.0"] as const;
const ranges = ["^18.0.0 || >=20.0.0", "^18.0.0 || ^20.0.0 || >=22.0.0", "^20.19.0 || >=22.12.0"] as const;
const dependencies = [["^0.21.3", "^4.13.0"], ["^0.24.0", "^4.23.0"], ["^0.25.0", "^4.40.0"]] as const;
const matrix = [[true,true,true,true,true,true], [true,true,true,false,true,true], [false,false,true,false,false,true]] as const;

/** Reject changed or incomplete registry data rather than grading with a stale oracle. */
export function viteOracle(sources: FrozenSource[]) {
  if (sources.length !== versions.length) throw new Error("Incomplete registry evidence");
  return versions.map((version, i) => {
    const url = `https://registry.npmjs.org/vite/${version}`;
    const source = sources.find(item => item.url === url);
    if (!source) throw new Error(`Missing registry evidence: ${url}`);
    const data = JSON.parse(source.body);
    if (data.version !== version || data.engines?.node !== ranges[i] || data.dependencies?.esbuild !== dependencies[i][0] || data.dependencies?.rollup !== dependencies[i][1]) {
      throw new Error(`Registry evidence changed or incomplete: ${url}`);
    }
    return { vite_version: version, node_engine: ranges[i], node_compatibility: Object.fromEntries(nodes.map((node, n) => [node, matrix[i][n]])),
      dependencies: { esbuild: dependencies[i][0], rollup: dependencies[i][1] } };
  });
}

/** Exact set and values; references must point to each version's official source. */
export function gradeViteFacts(answer: unknown, oracle: ReturnType<typeof viteOracle>): boolean {
  if (!answer || typeof answer !== "object") return false;
  const result = answer as Record<string, any>;
  if (!Array.isArray(result.candidates) || result.candidates.length !== oracle.length || result.highest_matching_candidate !== "6.0.0") return false;
  return oracle.every(expected => {
    const matches = result.candidates.filter((item: any) => item?.vite_version === expected.vite_version);
    if (matches.length !== 1) return false;
    const actual = matches[0];
    const compatibility = actual.node_compatibility;
    return actual.node_engine === expected.node_engine && compatibility && Object.keys(compatibility).length === nodes.length &&
      nodes.every(node => compatibility[node] === expected.node_compatibility[node]) &&
      actual.dependencies?.esbuild === expected.dependencies.esbuild && actual.dependencies?.rollup === expected.dependencies.rollup &&
      Array.isArray(actual.sources) && actual.sources.includes(`https://github.com/vitejs/vite/blob/v${expected.vite_version}/packages/vite/package.json`);
  });
}
