import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// CI runs this after a browser failure and uploads the diagnosis even if it fails.
const directory = resolve(process.argv[2] ?? '.dev/ci-browser');
await mkdir(directory, { recursive: true });
const missing = [];
async function read(path) {
  try {
    const value = await readFile(path);
    if (!value.length) throw new Error('empty file');
    return value;
  } catch (error) {
    missing.push({ path, error: error.message });
    return null;
  }
}
const log = await read(resolve(directory, 'runner.log'));
const data = await read(resolve(directory, 'results.json'));
let report;
if (data) {
  try {
    report = JSON.parse(data);
    if (!report.stats || !Number.isFinite(report.stats.unexpected) || !Array.isArray(report.errors)) throw new Error('Not a Playwright JSON result.');
  } catch (error) {
    report = undefined;
    missing.push({ path: resolve(directory, 'results.json'), error: error.message });
  }
}
const output = report?.config?.projects?.[0]?.outputDir;
if (output) await read(resolve(dirname(output), 'html/index.html'));
else missing.push({ path: 'Playwright config.projects[0].outputDir', error: 'No report location; tests may have failed before the reporter started.' });
const diagnosis = {
  status: missing.length ? 'incomplete' : 'reporters-complete',
  scope: !report ? 'before-readable-report' : report.errors.length ? 'runner-or-setup-errors'
    : report.stats.expected + report.stats.unexpected === 0 ? 'no-executed-tests' : 'test-results',
  resultsSha256: data ? createHash('sha256').update(data).digest('hex') : null,
  logBytes: log?.length ?? 0,
  stats: report?.stats ?? null,
  missing,
  note: 'A runner receipt alone is insufficient. Early failures may have no trace; inspect runner.log and this diagnosis. Reporter files do not prove task success.',
};
await writeFile(resolve(directory, 'evidence-check.json'), JSON.stringify(diagnosis, null, 2) + '\n');
console.log(JSON.stringify(diagnosis));
if (missing.length) process.exitCode = 1;
