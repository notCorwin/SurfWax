import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MODEL_SDKS } from '../src/types.ts';
import { GITLAB_MODELS } from '../src/agent/gitlab-models.ts';
import { publicJson } from './public-json.mjs';
import { analyzeSdkCoverage, sdkCoverageFailures } from './sdk-coverage.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--catalog')) {
  throw new Error('Usage: node scripts/check-sdk-coverage.mjs [--catalog path/to/catalog.json]');
}
const source = args.length ? resolve(args[1]) : 'https://models.dev/api.json';
const catalog = args.length ? JSON.parse(await readFile(source, 'utf8')) : await publicJson(source);
const report = { source, sourceKind: args.length ? 'snapshot' : 'live', checkedAt: new Date().toISOString(),
  ...analyzeSdkCoverage(catalog, MODEL_SDKS, GITLAB_MODELS) };
await mkdir('.dev/verification', { recursive: true });
await writeFile('.dev/verification/sdk-coverage.json', JSON.stringify(report, null, 2));
const failures = sdkCoverageFailures(report);
if (failures.length) throw new Error(failures.join('; '));
console.log(`Models.dev (${report.sourceKind}): ${report.catalogSdks.length} SDK names `
  + `(${report.providerSdks.length} provider-level, ${report.modelOverrideSdks.length} model-override), `
  + `${report.providers} providers, ${report.models} models; SDK name and GitLab alias coverage complete `
  + `(${report.gitlab.catalogModelIds.length} GitLab aliases).`);
console.log(report.limitations);
