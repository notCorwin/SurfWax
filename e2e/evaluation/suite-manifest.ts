import { createHash } from "node:crypto";
import { evaluateResultEvidence, lastAgentResponse } from "./result-evidence.ts";
import { SCENARIOS } from "./scenarios.ts";

export interface SuitePlan {
  version: 1;
  provider: string;
  model: string;
  scenarios: string[];
  seeds: number[];
  repeats: number;
  timeoutMs: number;
}

export interface SuiteSample {
  id: string;
  scenario: string;
  seed: number;
  /** Repetitions of one scenario and seed are correlated, not independent tasks. */
  repeat: number;
}

export interface SuiteManifest {
  version: 1;
  plan: SuitePlan;
  planHash: string;
  samples: SuiteSample[];
}

export interface SuiteReport {
  sampleId: string;
  planHash: string;
  /** The single-run report, without adding secrets or trusting its filename. */
  report: unknown;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const triState = (value: unknown): value is boolean | null => value === true || value === false || value === null;
const metrics = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"] as const;
const availableScenarios = new Set<string>(SCENARIOS);
type Metric = typeof metrics[number];
type Totals = Record<Metric, number | null>;
type Environment = { extensionBuildSha256: string | null; evaluationSourceSha256: string | null; lockfileSha256: string | null; browser: string | null; stable: boolean | null; evaluationStable: boolean | null };

function optionalHash(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid environment hash");
  return value;
}

/** Environment identity is evidence, never a claim of statistical comparability. */
function environmentEvidence(value: Record<string, unknown>): Environment {
  const build = value.extensionBuild;
  if (build !== undefined && build !== null && !isRecord(build)) throw new Error("Invalid extension build evidence");
  const stable = value.extensionBuildStable;
  if (stable !== undefined && !triState(stable)) throw new Error("Invalid extension stability evidence");
  const source = value.evaluationSource;
  if (source !== undefined && source !== null && !isRecord(source)) throw new Error("Invalid evaluation source evidence");
  const evaluationStable = value.evaluationSourceStable;
  if (evaluationStable !== undefined && !triState(evaluationStable)) throw new Error("Invalid evaluation stability evidence");
  const browser = value.browser;
  if (browser !== undefined && browser !== null && !identity(browser)) throw new Error("Invalid browser evidence");
  return { extensionBuildSha256: isRecord(build) ? optionalHash(build.sha256) : null,
    evaluationSourceSha256: isRecord(source) ? optionalHash(source.sha256) : null,
    lockfileSha256: optionalHash(value.lockfileSha256), browser: typeof browser === "string" ? browser : null,
    stable: stable ?? null, evaluationStable: evaluationStable ?? null };
}

/** Canonicalize a plan before any run. This function does not access a provider. */
export function createSuiteManifest(value: SuitePlan): SuiteManifest {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "model,provider,repeats,scenarios,seeds,timeoutMs,version"
    || value.version !== 1 || !identity(value.provider) || !identity(value.model)) throw new Error("Invalid suite plan");
  if (!Array.isArray(value.scenarios) || !value.scenarios.length || value.scenarios.some((item) => typeof item !== "string" || !availableScenarios.has(item))
    || new Set(value.scenarios).size !== value.scenarios.length) throw new Error("Invalid or duplicate scenarios");
  if (!Array.isArray(value.seeds) || !value.seeds.length || value.seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 999999)
    || new Set(value.seeds).size !== value.seeds.length) throw new Error("Invalid or duplicate seeds");
  if (!Number.isSafeInteger(value.repeats) || value.repeats < 1 || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2_147_423_647) throw new Error("Invalid repeats or timeout");
  const count = value.scenarios.length * value.seeds.length * value.repeats;
  if (!Number.isSafeInteger(count) || count > 100_000) throw new Error("Suite plan is too large");
  const plan: SuitePlan = { version: 1, provider: value.provider, model: value.model, scenarios: [...value.scenarios].sort(),
    seeds: [...value.seeds].sort((a, b) => a - b), repeats: value.repeats, timeoutMs: value.timeoutMs };
  const planHash = digest(plan);
  const samples: SuiteSample[] = [];
  for (const scenario of plan.scenarios) for (const seed of plan.seeds) for (let repeat = 1; repeat <= plan.repeats; repeat++) {
    samples.push({ id: digest([planHash, scenario, seed, repeat]), scenario, seed, repeat });
  }
  // In-memory callers cannot accidentally alter the preregistered denominator.
  Object.freeze(plan.scenarios); Object.freeze(plan.seeds); Object.freeze(plan);
  for (const sample of samples) Object.freeze(sample);
  Object.freeze(samples);
  return Object.freeze({ version: 1, plan, planHash, samples });
}

function usageTotals(value: unknown): Totals {
  if (!Array.isArray(value)) throw new Error("Invalid usage evidence");
  const totals = Object.fromEntries(metrics.map((metric) => [metric, value.length ? 0 : null])) as Totals;
  for (const step of value) {
    if (!isRecord(step)) throw new Error("Invalid usage step");
    for (const metric of metrics) {
      const current = step[metric];
      if (current !== null && !tokenCount(current)) throw new Error("Invalid usage value");
      if (current === null) totals[metric] = null;
      else if (totals[metric] !== null) {
        const sum = totals[metric]! + current;
        if (!Number.isSafeInteger(sum)) throw new Error("Usage total overflow");
        totals[metric] = sum;
      }
    }
  }
  return totals;
}

function validatedReport(value: unknown, sample: SuiteSample, plan: SuitePlan, planHash: string) {
  if (!isRecord(value) || value.scenario !== sample.scenario || value.seed !== sample.seed || value.provider !== plan.provider
    || value.model !== plan.model || value.taskTimeoutMs !== plan.timeoutMs) throw new Error("Report identity mismatch");
  const suite = value.suiteIdentity;
  if (!isRecord(suite) || Object.keys(suite).sort().join(",") !== "planHash,repeat,sampleId"
    || suite.sampleId !== sample.id || suite.planHash !== planHash || suite.repeat !== sample.repeat) throw new Error("Suite report identity mismatch");
  if (typeof value.outcome !== "string" || !identity(value.outcome) || !triState(value.networkSettled)
    || typeof value.ledgerDrained !== "boolean" || typeof value.logComplete !== "boolean" || !triState(value.businessVerified)
    || typeof value.interactionApplicable !== "boolean" || !triState(value.interactionVerified) || !triState(value.lifecycleVerified)
    || !Array.isArray(value.reasons)) throw new Error("Invalid result evidence");
  const expected = evaluateResultEvidence({ outcome: value.outcome, networkSettled: value.networkSettled, ledgerDrained: value.ledgerDrained,
    logComplete: value.logComplete, business: value.businessVerified,
    interaction: value.interactionApplicable ? { applicable: true, verified: value.interactionVerified } : { applicable: false },
    lifecycle: value.lifecycleVerified });
  if (value.classification !== expected.classification || value.passed !== expected.passed || value.businessVerified !== expected.businessVerified
    || value.interactionVerified !== expected.interactionVerified || value.lifecycleVerified !== expected.lifecycleVerified
    || JSON.stringify(value.reasons) !== JSON.stringify(expected.reasons)) throw new Error("Inconsistent result evidence");
  const providerResponse = lastAgentResponse(value.requests);
  if (providerResponse === null ? value.lastAgentResponse !== null : !isRecord(value.lastAgentResponse)
    || value.lastAgentResponse.status !== providerResponse.status || value.lastAgentResponse.complete !== providerResponse.complete
    || Object.keys(value.lastAgentResponse).sort().join(",") !== "complete,status") throw new Error("Inconsistent provider response evidence");
  return { classification: expected.classification, outcome: value.outcome, providerResponse, usage: usageTotals(value.providerUsageByStep), environment: environmentEvidence(value) };
}

/** Validate identities and retain every planned sample, including absent reports. */
export function aggregateSuiteReports(manifest: SuiteManifest, reports: readonly SuiteReport[]) {
  if (!isRecord(manifest) || Object.keys(manifest).sort().join(",") !== "plan,planHash,samples,version"
    || manifest.version !== 1 || !isRecord(manifest.plan) || !Array.isArray(manifest.samples)) throw new Error("Invalid suite manifest");
  const canonical = createSuiteManifest(manifest.plan as unknown as SuitePlan);
  if (manifest.planHash !== canonical.planHash || manifest.samples.length !== canonical.samples.length
    || manifest.samples.some((sample, index) => !isRecord(sample) || Object.keys(sample).sort().join(",") !== "id,repeat,scenario,seed"
      || sample.id !== canonical.samples[index]!.id || sample.scenario !== canonical.samples[index]!.scenario
      || sample.seed !== canonical.samples[index]!.seed || sample.repeat !== canonical.samples[index]!.repeat)) throw new Error("Suite manifest does not match its plan");
  if (!Array.isArray(reports)) throw new Error("Invalid suite reports");
  const planned = new Map(canonical.samples.map((sample) => [sample.id, sample]));
  const results = new Map<string, ReturnType<typeof validatedReport>>();
  for (const item of reports) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "planHash,report,sampleId" || item.planHash !== canonical.planHash
      || typeof item.sampleId !== "string") throw new Error("Invalid suite report wrapper");
    const sample = planned.get(item.sampleId);
    if (!sample) throw new Error("Unplanned suite report");
    if (results.has(item.sampleId)) throw new Error("Duplicate suite report");
    results.set(item.sampleId, validatedReport(item.report, sample, canonical.plan, canonical.planHash));
  }
  const counts = { total: canonical.samples.length, passed: 0, failed: 0, unknown: 0, timedOut: 0, missing: 0 };
  const totals = Object.fromEntries(metrics.map((metric) => [metric, 0])) as Totals;
  const unknownUsage = Object.fromEntries(metrics.map((metric) => [metric, 0])) as Record<Metric, number>;
  const groups = new Map<string, { extensionBuildSha256: string; evaluationSourceSha256: string; lockfileSha256: string; browser: string; sampleIds: string[]; unstableSamples: number; unknownStabilitySamples: number }>();
  let unknownEnvironmentSamples = 0, unstableEnvironmentSamples = 0;
  const samples = canonical.samples.map((sample) => {
    const result = results.get(sample.id);
    if (!result) {
      counts.unknown++; counts.missing++;
      unknownEnvironmentSamples++;
      for (const metric of metrics) { totals[metric] = null; unknownUsage[metric]++; }
      return { ...sample, classification: "unknown" as const, outcome: null, missing: true };
    }
    counts[result.classification]++;
    if (result.outcome === "timed_out") counts.timedOut++;
    const env = result.environment;
    if (env.stable === false || env.evaluationStable === false) unstableEnvironmentSamples++;
    if (env.stable === null || env.evaluationStable === null || !env.extensionBuildSha256 || !env.evaluationSourceSha256 || !env.lockfileSha256 || !env.browser) unknownEnvironmentSamples++;
    if (env.extensionBuildSha256 && env.evaluationSourceSha256 && env.lockfileSha256 && env.browser) {
      const key = JSON.stringify([env.extensionBuildSha256, env.evaluationSourceSha256, env.lockfileSha256, env.browser]);
      const group = groups.get(key) ?? { extensionBuildSha256: env.extensionBuildSha256, evaluationSourceSha256: env.evaluationSourceSha256, lockfileSha256: env.lockfileSha256,
        browser: env.browser, sampleIds: [], unstableSamples: 0, unknownStabilitySamples: 0 };
      group.sampleIds.push(sample.id);
      if (env.stable === false || env.evaluationStable === false) group.unstableSamples++;
      if (env.stable === null || env.evaluationStable === null) group.unknownStabilitySamples++;
      groups.set(key, group);
    }
    for (const metric of metrics) {
      const value = result.usage[metric];
      if (value === null) { totals[metric] = null; unknownUsage[metric]++; }
      else if (totals[metric] !== null) {
        const sum = totals[metric]! + value;
        if (!Number.isSafeInteger(sum)) throw new Error("Suite usage overflow");
        totals[metric] = sum;
      }
    }
    return { ...sample, classification: result.classification, outcome: result.outcome, lastAgentResponse: result.providerResponse, missing: false };
  });
  const comparable = unstableEnvironmentSamples > 0 || groups.size > 1 ? false
    : unknownEnvironmentSamples > 0 || canonical.samples.length < 2 ? null : true;
  return { planHash: canonical.planHash, counts, usage: { totals, unknownSamples: unknownUsage },
    environment: { comparable, scope: "extension-evaluation-source-lockfile-browser-only" as const,
      groups: [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group),
      unknownSamples: unknownEnvironmentSamples, unstableSamples: unstableEnvironmentSamples }, samples };
}
