// @vitest-environment node
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const executable = promisify(execFile);
const cliPath = resolve("e2e/evaluation/suite-cli.ts");
const plan = () => ({
  version: 1,
  provider: "local-mock",
  model: "test-model",
  scenarios: ["rolling-queue", "long-manifest"],
  seeds: [73, 17],
  repeats: 2,
  timeoutMs: 30_000,
});
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "surfwax-suite-cli-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function call(...args: string[]) {
  try {
    const result = await executable(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...args],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    return { status: 0, ...result };
  } catch (error) {
    const result = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

async function writeJson(name: string, value: unknown) {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function freeze() {
  const source = await writeJson("plan.json", plan());
  const manifestPath = join(directory, "frozen", "manifest.json");
  const result = await call("freeze", source, manifestPath);
  expect(result.status, result.stderr).toBe(0);
  return {
    source,
    manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, "utf8")),
    output: JSON.parse(result.stdout),
  };
}

describe("offline suite CLI", () => {
  it("freezes a canonical plan and stable sample identities without accessing a provider", async () => {
    const { manifest, output } = await freeze();
    expect(output).toEqual({ planHash: manifest.planHash, samples: 8 });
    expect(manifest.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.plan.scenarios).toEqual(["long-manifest", "rolling-queue"]);
    expect(manifest.plan.seeds).toEqual([17, 73]);
    expect(manifest.samples).toHaveLength(8);
    expect(
      new Set(manifest.samples.map((sample: { id: string }) => sample.id)).size,
    ).toBe(8);

    const reordered = await writeJson("reordered.json", {
      ...plan(),
      seeds: [17, 73],
      scenarios: ["long-manifest", "rolling-queue"],
    });
    const secondPath = join(directory, "other", "manifest.json");
    const result = await call("freeze", reordered, secondPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(secondPath, "utf8"))).toEqual(manifest);
  });

  it("keeps every planned sample unknown when the report directory is empty", async () => {
    const { manifest, manifestPath } = await freeze();
    const reports = join(directory, "reports"),
      summaryPath = join(directory, "summary", "result.json");
    await mkdir(reports);
    const result = await call("aggregate", manifestPath, reports, summaryPath);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.planHash).toBe(manifest.planHash);
    expect(summary.counts).toEqual({
      total: 8,
      passed: 0,
      failed: 0,
      unknown: 8,
      timedOut: 0,
      missing: 8,
    });
    expect(summary.samples.map((sample: { id: string }) => sample.id)).toEqual(
      manifest.samples.map((sample: { id: string }) => sample.id),
    );
    expect(
      summary.samples.every(
        (sample: { missing: boolean; classification: string }) =>
          sample.missing && sample.classification === "unknown",
      ),
    ).toBe(true);
    expect(summary.usage).toMatchObject({
      totals: { inputTokens: null, outputTokens: null },
      unknownSamples: { inputTokens: 8, outputTokens: 8 },
    });
    expect(summary.environment).toMatchObject({
      comparable: null,
      groups: [],
      unknownSamples: 8,
    });
    expect(JSON.parse(result.stdout).counts).toEqual(summary.counts);
  });

  it("never overwrites existing artifacts and removes temporary files", async () => {
    const { source, manifestPath } = await freeze();
    const originalManifest = await readFile(manifestPath, "utf8");
    const overwrite = await call("freeze", source, manifestPath);
    expect(overwrite.status).toBe(1);
    expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
    expect(await readdir(join(directory, "frozen"))).toEqual(["manifest.json"]);

    const reports = join(directory, "reports"),
      summaryPath = join(directory, "summary.json");
    await mkdir(reports);
    await writeFile(summaryPath, "existing summary\n");
    const aggregate = await call(
      "aggregate",
      manifestPath,
      reports,
      summaryPath,
    );
    expect(aggregate.status).toBe(1);
    expect(await readFile(summaryPath, "utf8")).toBe("existing summary\n");
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".surfwax-suite-"),
      ),
    ).toEqual([]);
  });

  it("rejects invalid plans, malformed input, invalid report files and tampered manifests", async () => {
    for (const [index, value] of [
      { ...plan(), scenarios: ["not-a-scenario"] },
      { ...plan(), seeds: [17, 17] },
      { ...plan(), repeats: 0 },
      { ...plan(), apiKey: "unexpected-credential-field" },
    ].entries()) {
      const path = await writeJson(`invalid-${index}.json`, value),
        output = join(directory, `invalid-${index}-out.json`);
      expect((await call("freeze", path, output)).status).toBe(1);
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{not-json");
    expect(
      (await call("freeze", malformed, join(directory, "bad.json"))).status,
    ).toBe(1);
    expect((await call("freeze")).status).toBe(1);

    const { manifest, manifestPath } = await freeze();
    const reports = join(directory, "reports"),
      summary = join(directory, "invalid-summary.json");
    await mkdir(reports);
    await writeFile(join(reports, "wrong.txt"), "{}");
    expect(
      (await call("aggregate", manifestPath, reports, summary)).status,
    ).toBe(1);
    await rm(join(reports, "wrong.txt"));
    await writeFile(join(reports, "unidentified.json"), "{}");
    expect(
      (await call("aggregate", manifestPath, reports, summary)).status,
    ).toBe(1);
    await rm(join(reports, "unidentified.json"));
    manifest.samples.pop();
    const tampered = await writeJson("tampered.json", manifest);
    expect((await call("aggregate", tampered, reports, summary)).status).toBe(
      1,
    );
    await expect(readFile(summary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
