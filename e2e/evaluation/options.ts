import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SCENARIOS } from "./scenarios";

export type EvaluationOptions = {
  upstream: string;
  key: string;
  model: string;
  providerName: string;
  taskTimeoutMs: number;
  seed: number;
  scenario: (typeof SCENARIOS)[number];
  suiteIdentity: { planHash: string; sampleId: string; repeat: number } | null;
  extensionDirectory: string;
  reportDirectory: string;
  eventsDirectory?: string;
};

/** Environment configuration belongs to the CLI/test entrypoint, not an active evaluation. */
export function evaluationOptionsFromEnvironment(env: Record<string, string | undefined>): EvaluationOptions {
  const taskTimeoutMs = Number(env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs <= 0 || taskTimeoutMs > 2_147_423_647) throw new Error("Invalid evaluation timeout");
  const upstream = env.SURFWAX_EVAL_BASE_URL;
  const key = env.SURFWAX_EVAL_API_KEY;
  const model = env.SURFWAX_EVAL_MODEL;
  const providerName = env.SURFWAX_EVAL_PROVIDER;
  if (!upstream || !key || !model || !providerName) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY, SURFWAX_EVAL_MODEL and SURFWAX_EVAL_PROVIDER");
  const seed = Number(env.SURFWAX_EVAL_SEED ?? 17);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999) throw new Error("Invalid seed");
  const scenario = SCENARIOS.find((candidate) => candidate === (env.SURFWAX_EVAL_SCENARIO ?? "cross-frame-order"));
  if (!scenario) throw new Error("Invalid scenario");
  const suitePlanHash = env.SURFWAX_EVAL_SUITE_PLAN_HASH;
  const suiteSampleId = env.SURFWAX_EVAL_SUITE_SAMPLE_ID;
  const suiteRepeatText = env.SURFWAX_EVAL_SUITE_REPEAT;
  let suiteIdentity: { planHash: string; sampleId: string; repeat: number } | null = null;
  if (suitePlanHash !== undefined || suiteSampleId !== undefined || suiteRepeatText !== undefined) {
    const repeat = Number(suiteRepeatText);
    if (!suitePlanHash || !/^[a-f0-9]{64}$/.test(suitePlanHash) || !suiteSampleId || !/^[a-f0-9]{64}$/.test(suiteSampleId)
      || !suiteRepeatText || !/^[1-9]\d*$/.test(suiteRepeatText) || !Number.isSafeInteger(repeat)) throw new Error("Invalid suite sample identity");
    const expectedId = createHash("sha256").update(JSON.stringify([suitePlanHash, scenario, seed, repeat])).digest("hex");
    if (suiteSampleId !== expectedId) throw new Error("Suite sample identity does not match this task");
    suiteIdentity = { planHash: suitePlanHash, sampleId: suiteSampleId, repeat };
  }
  return { upstream, key, model, providerName, taskTimeoutMs, seed, scenario, suiteIdentity,
    extensionDirectory: resolve(env.SURFWAX_EXTENSION_PATH ?? "dist"),
    reportDirectory: resolve(env.SURFWAX_EVAL_REPORT_DIR ?? ".dev/verification/model-evals"),
    eventsDirectory: env.SURFWAX_EVAL_EVENTS_DIR ? resolve(env.SURFWAX_EVAL_EVENTS_DIR) : undefined };
}
