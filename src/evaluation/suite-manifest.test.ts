// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aggregateSuiteReports, createSuiteManifest, type SuitePlan, type SuiteReport } from "../../e2e/evaluation/suite-manifest";
import { evaluateResultEvidence } from "../../e2e/evaluation/result-evidence";

const plan = (): SuitePlan => ({ version: 1, provider: "local-mock", model: "test/model", scenarios: ["rolling-queue", "long-manifest"], seeds: [73, 17], repeats: 2, timeoutMs: 30000 });
const usage = (input: number | null, output: number | null) => [{ inputTokens: input, outputTokens: output, totalTokens: input === null || output === null ? null : input + output, cachedInputTokens: null, reasoningTokens: null }];
const build = "a".repeat(64), lockfile = "b".repeat(64), browser = "Chrome/151.0.7922.34";

function report(manifest: ReturnType<typeof createSuiteManifest>, index: number, changes: Record<string, unknown> = {}): SuiteReport {
  const sample = manifest.samples[index]!;
  const outcome = typeof changes.outcome === "string" ? changes.outcome : "conversation.finished";
  const business = typeof changes.businessVerified === "boolean" ? changes.businessVerified : true;
  const lifecycle = typeof changes.lifecycleVerified === "boolean" ? changes.lifecycleVerified : true;
  const result = evaluateResultEvidence({ outcome, networkSettled: true, ledgerDrained: true, logComplete: true, business,
    interaction: { applicable: false }, lifecycle });
  return { sampleId: sample.id, planHash: manifest.planHash, report: { scenario: sample.scenario, seed: sample.seed,
    provider: manifest.plan.provider, model: manifest.plan.model, taskTimeoutMs: manifest.plan.timeoutMs,
    suiteIdentity: { sampleId: sample.id, planHash: manifest.planHash, repeat: sample.repeat },
    outcome, networkSettled: true, ledgerDrained: true, logComplete: true, ...result,
    extensionBuild: { sha256: build }, extensionBuildStable: true, lockfileSha256: lockfile, browser,
    providerUsageByStep: usage(10, 3), ...changes } };
}

describe("offline benchmark suite manifest", () => {
  it("canonicalizes the plan and fixes each scenario, seed and repetition once", () => {
    const manifest = createSuiteManifest(plan());
    const same = createSuiteManifest({ ...plan(), scenarios: [...plan().scenarios].reverse(), seeds: [...plan().seeds].reverse() });
    expect(manifest).toEqual(same);
    expect(manifest.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.samples).toHaveLength(8);
    expect(new Set(manifest.samples.map((sample) => sample.id)).size).toBe(8);
    expect(manifest.samples.slice(0, 2)).toMatchObject([{ scenario: "long-manifest", seed: 17, repeat: 1 }, { scenario: "long-manifest", seed: 17, repeat: 2 }]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.plan.seeds)).toBe(true);
    expect(Object.isFrozen(manifest.samples[0])).toBe(true);
    expect(createSuiteManifest({ ...plan(), timeoutMs: 30001 }).planHash).not.toBe(manifest.planHash);
  });

  it("rejects duplicate, missing and invalid plan inputs before execution", () => {
    for (const bad of [
      { ...plan(), scenarios: ["rolling-queue", "rolling-queue"] }, { ...plan(), seeds: [17, 17] },
      { ...plan(), scenarios: [] }, { ...plan(), seeds: [-1] }, { ...plan(), seeds: [1.5] },
      { ...plan(), scenarios: ["Bad Scenario"] }, { ...plan(), scenarios: ["rolling-queu"] },
      { ...plan(), provider: "" }, { ...plan(), model: " model " },
      { ...plan(), repeats: 0 }, { ...plan(), timeoutMs: 0 }, { ...plan(), apiKey: "must not be serialized" },
    ]) expect(() => createSuiteManifest(bad as SuitePlan)).toThrow();
    expect(() => createSuiteManifest({ ...plan(), scenarios: ["network-identity"] })).not.toThrow();
  });

  it("retains every missing sample as unknown and never invents zero usage", () => {
    const manifest = createSuiteManifest(plan());
    const result = aggregateSuiteReports(manifest, []);
    expect(result.counts).toEqual({ total: 8, passed: 0, failed: 0, unknown: 8, timedOut: 0, missing: 8 });
    expect(result.samples.every((sample) => sample.missing && sample.classification === "unknown")).toBe(true);
    expect(result.usage.totals).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(result.usage.unknownSamples).toMatchObject({ inputTokens: 8, outputTokens: 8 });
    expect(result.environment).toMatchObject({ comparable: null, groups: [], unknownSamples: 8, unstableSamples: 0 });
  });

  it("counts failed and timed-out runs separately while keeping all planned samples", () => {
    const manifest = createSuiteManifest(plan());
    const result = aggregateSuiteReports(manifest, [report(manifest, 0), report(manifest, 1, { businessVerified: false }),
      report(manifest, 2, { outcome: "timed_out", providerUsageByStep: usage(null, 5) })]);
    expect(result.counts).toEqual({ total: 8, passed: 1, failed: 1, unknown: 6, timedOut: 1, missing: 5 });
    expect(result.usage.totals).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(result.usage.unknownSamples).toMatchObject({ inputTokens: 6, outputTokens: 5 });
  });

  it("sums usage only when every sample and every step supplies the metric", () => {
    const manifest = createSuiteManifest({ ...plan(), scenarios: ["rolling-queue"], seeds: [17], repeats: 2 });
    const complete = aggregateSuiteReports(manifest, [report(manifest, 0), report(manifest, 1)]);
    expect(complete.usage.totals).toMatchObject({ inputTokens: 20, outputTokens: 6, totalTokens: 26, cachedInputTokens: null });
    expect(complete.usage.unknownSamples).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 2 });
    const incomplete = aggregateSuiteReports(manifest, [report(manifest, 0, { providerUsageByStep: [...usage(10, 3), ...usage(null, 4)] }), report(manifest, 1)]);
    expect(incomplete.usage.totals).toMatchObject({ inputTokens: null, outputTokens: 10 });
    expect(incomplete.usage.unknownSamples.inputTokens).toBe(1);
    const noSteps = aggregateSuiteReports(manifest, [report(manifest, 0, { providerUsageByStep: [] }), report(manifest, 1)]);
    expect(noSteps.usage.totals.inputTokens).toBeNull();
  });

  it("groups matching, mixed and unstable environments without changing the denominator", () => {
    const manifest = createSuiteManifest({ ...plan(), scenarios: ["rolling-queue"], seeds: [17], repeats: 2 });
    const first = report(manifest, 0), second = report(manifest, 1);
    const matching = aggregateSuiteReports(manifest, [first, second]);
    expect(matching.counts).toMatchObject({ total: 2, passed: 2 });
    expect(matching.environment).toMatchObject({ comparable: true, scope: "extension-build-lockfile-browser-only", unknownSamples: 0, unstableSamples: 0,
      groups: [{ extensionBuildSha256: build, lockfileSha256: lockfile, browser, sampleIds: manifest.samples.map((sample) => sample.id) }] });
    for (const changes of [{ extensionBuild: { sha256: "c".repeat(64) } }, { lockfileSha256: "d".repeat(64) }, { browser: "Chrome/150" }]) {
      const mixed = aggregateSuiteReports(manifest, [first, report(manifest, 1, changes)]);
      expect(mixed.environment).toMatchObject({ comparable: false, unknownSamples: 0, unstableSamples: 0 });
      expect(mixed.environment.groups).toHaveLength(2);
      expect(mixed.counts).toEqual(matching.counts);
    }
    const unstable = aggregateSuiteReports(manifest, [first, report(manifest, 1, { extensionBuildStable: false })]);
    expect(unstable.environment).toMatchObject({ comparable: false, unknownSamples: 0, unstableSamples: 1,
      groups: [{ unstableSamples: 1 }] });
    expect(unstable.counts).toEqual(matching.counts);
  });

  it("reports unknown environment identity without treating absence as a match", () => {
    const manifest = createSuiteManifest({ ...plan(), scenarios: ["rolling-queue"], seeds: [17], repeats: 2 });
    const first = report(manifest, 0);
    for (const changes of [{ extensionBuild: null }, { extensionBuild: {} }, { extensionBuildStable: null }, { lockfileSha256: null }, { browser: null }]) {
      const result = aggregateSuiteReports(manifest, [first, report(manifest, 1, changes)]);
      expect(result.environment).toMatchObject({ comparable: null, unknownSamples: 1, unstableSamples: 0 });
      expect(result.counts).toMatchObject({ total: 2, passed: 2 });
    }
    expect(aggregateSuiteReports(manifest, [first]).environment).toMatchObject({ comparable: null, unknownSamples: 1 });
    const single = createSuiteManifest({ ...plan(), scenarios: ["rolling-queue"], seeds: [17], repeats: 1 });
    expect(aggregateSuiteReports(single, [report(single, 0)]).environment.comparable).toBeNull();
    const unstableAndMissing = aggregateSuiteReports(manifest, [report(manifest, 0, { extensionBuildStable: false })]);
    expect(unstableAndMissing.environment).toMatchObject({ comparable: false, unknownSamples: 1, unstableSamples: 1 });
    expect(() => aggregateSuiteReports(manifest, [report(manifest, 0, { lockfileSha256: "not-a-hash" })])).toThrow(/environment hash/);
  });

  it("rejects duplicates, foreign or mismatched records and inconsistent claims", () => {
    const manifest = createSuiteManifest(plan()), one = report(manifest, 0);
    expect(() => aggregateSuiteReports(manifest, [one, one])).toThrow(/Duplicate/);
    expect(() => aggregateSuiteReports(manifest, [{ ...one, sampleId: "missing" }])).toThrow(/Unplanned/);
    expect(() => aggregateSuiteReports(manifest, [{ ...one, planHash: "foreign" }])).toThrow(/wrapper/);
    const otherRepeat = report(manifest, 1);
    expect(() => aggregateSuiteReports(manifest, [{ ...otherRepeat, sampleId: one.sampleId }])).toThrow(/Suite report identity/);
    expect(() => aggregateSuiteReports(manifest, [{ ...one, report: { ...(one.report as object), suiteIdentity: null } }])).toThrow(/Suite report identity/);
    for (const field of ["scenario", "seed", "provider", "model", "taskTimeoutMs"]) {
      expect(() => aggregateSuiteReports(manifest, [{ ...one, report: { ...(one.report as object), [field]: "wrong" } }])).toThrow(/identity/);
    }
    expect(() => aggregateSuiteReports(manifest, [{ ...one, report: { ...(one.report as object), businessVerified: false } }])).toThrow(/Inconsistent/);
    expect(() => aggregateSuiteReports(manifest, [{ ...one, report: { ...(one.report as object), providerUsageByStep: usage(-1, 2) } }])).toThrow(/usage/);
  });

  it("revalidates persisted manifests against the canonical plan regardless of object key order", () => {
    const manifest = createSuiteManifest(plan());
    const persisted = JSON.parse(JSON.stringify({ samples: manifest.samples, planHash: manifest.planHash, plan: manifest.plan, version: manifest.version }));
    expect(aggregateSuiteReports(persisted, []).counts.total).toBe(8);
    persisted.samples.pop();
    expect(() => aggregateSuiteReports(persisted, [])).toThrow(/does not match/);
  });
});
