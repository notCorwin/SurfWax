import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Local CI requires Node 24. Use npm exec --package=node@24 -- npm run verify:local.');
const started = Date.now();
const stages = [];
const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  PLAYWRIGHT_HTML_OPEN: 'never' };
const node = process.execPath;
await mkdir('.dev/verification', { recursive: true });
function run(name, command, args, options = {}) {
  console.log(`\n[local CI] ${name}`);
  const start = Date.now();
  const result = spawnSync(command, args, { env, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  stages.push({ name, durationMs: Date.now() - start, status: result.status });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${name} failed (${result.status})`);
  return result.stdout?.trim();
}
try {
  run('Generated documentation', node, ['scripts/generate-tool-docs.mjs', '--check']);
  run('Live Models.dev SDK coverage', node, ['scripts/check-sdk-coverage.mjs']);
  run('Type checking', node, ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('Extension build', node, ['node_modules/vite/bin/vite.js', 'build']);
  run('Manifest and bundle contract', node, ['scripts/validate-build.mjs']);
  run('Unit and SDK streaming contracts', node, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=.dev/verification/unit-results.json']);
  run('Upgrade fixture', node, ['scripts/prepare-upgrade-fixture.mjs']);
  env.SURFWAX_CHROME_138_PATH = run('Chrome 138', node, ['scripts/install-test-browser.mjs', '138'], { capture: true });
  env.SURFWAX_CHROME_PATH = run('Current Chrome Stable', node, ['scripts/install-test-browser.mjs', 'current'], { capture: true });
  env.SURFWAX_EXTENSION_PATH = resolve('dist');
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = resolve('.dev/verification/e2e-results.json');
  run('Chrome 138 and current E2E', node, ['node_modules/@playwright/test/cli.js', 'test', '--grep-invert', '@performance', '--reporter=list,html,json']);
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = resolve('.dev/verification/performance-results.json');
  run('120Hz rendering traces and interaction performance', node, ['node_modules/@playwright/test/cli.js', 'test', '--grep', '@performance', '--reporter=list,html,json']);
} finally {
  await mkdir('.dev/verification', { recursive: true });
  await writeFile('.dev/verification/local-ci.json', JSON.stringify({ node: process.version, startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started, browsers: { chrome138: env.SURFWAX_CHROME_138_PATH, current: env.SURFWAX_CHROME_PATH }, stages }, null, 2));
}
console.log('\nLocal CI passed. Evidence: .dev/verification, test-results and playwright-report.');
