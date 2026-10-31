import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { aggregateSuiteReports, createSuiteManifest, type SuiteManifest, type SuitePlan, type SuiteReport } from "./suite-manifest.ts";

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read or parse JSON input"); }
}

/** Publish a complete file without overwriting an existing experiment artifact. */
async function writeNew(path: string, value: unknown): Promise<void> {
  const target = resolve(path), temporary = join(dirname(target), `.surfwax-suite-${randomUUID()}.tmp`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await link(temporary, target);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "freeze" && args.length === 3) {
    const manifest = createSuiteManifest(await readJson(args[1]!) as SuitePlan);
    await writeNew(args[2]!, manifest);
    console.log(JSON.stringify({ planHash: manifest.planHash, samples: manifest.samples.length }));
    return;
  }
  if (args[0] === "aggregate" && args.length === 4) {
    const manifest = await readJson(args[1]!) as SuiteManifest;
    const directory = resolve(args[2]!);
    const files = await readdir(directory, { withFileTypes: true });
    if (files.some((file) => !file.isFile() || !file.name.endsWith(".json"))) throw new Error("Reports directory must contain only JSON files");
    const reports: SuiteReport[] = [];
    for (const file of files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const report = await readJson(join(directory, file.name));
      if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid report");
      const identity = (report as Record<string, unknown>).suiteIdentity;
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Report has no suite identity");
      const { sampleId, planHash } = identity as Record<string, unknown>;
      if (typeof sampleId !== "string" || typeof planHash !== "string") throw new Error("Invalid suite identity");
      reports.push({ sampleId, planHash, report });
    }
    const summary = aggregateSuiteReports(manifest, reports);
    await writeNew(args[3]!, summary);
    console.log(JSON.stringify({ planHash: summary.planHash, counts: summary.counts, environment: summary.environment }));
    return;
  }
  throw new Error("Usage: suite-cli.ts freeze <plan.json> <manifest.json> | aggregate <manifest.json> <reports-directory> <summary.json>");
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof Error && !("code" in error) ? error.message : "Suite operation failed");
  process.exitCode = 1;
}
