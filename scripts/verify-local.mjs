import { beginArtifactRun } from './dev-storage.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevelopmentExtension, systemChromePath } from './development-extension.mjs';
import { runCommand } from './run-browser-tests.mjs';

export async function verifyLocal(options = {}) {
  if (Number((options.nodeVersion ?? process.versions.node).split('.')[0]) !== 24)
    throw new Error('Local CI requires Node 24. Use npm exec --package=node@24 -- npm run verify:local.');
  const started = Date.now();
  const stages = [];
  const cwd = resolve(options.cwd ?? process.cwd());
  const node = options.node ?? process.execPath;
  const sourceEnv = options.env ?? process.env;
  const executablePath = (options.systemChromePath ?? systemChromePath)(sourceEnv);
  const env = { ...sourceEnv, PATH: `${dirname(node)}${process.platform === 'win32' ? ';' : ':'}${sourceEnv.PATH ?? ''}`,
    PLAYWRIGHT_HTML_OPEN: 'never', SURFWAX_CHROME_PATH: executablePath };
  const artifacts = await beginArtifactRun('local-ci', cwd);
  const verification = resolve(artifacts.directory, 'verification');
  await mkdir(verification, { recursive: true });
  env.SURFWAX_VERIFICATION_DIR = verification;
  env.SURFWAX_EVIDENCE_PATH = resolve(artifacts.directory, 'canonical-logs');
  let development;
  let status = 'failed';
  async function run(name, args) {
    console.log(`\n[local CI] ${name}`);
    const start = Date.now();
    try {
      await (options.runCommand ?? runCommand)(node, args, { cwd, env });
      stages.push({ name, durationMs: Date.now() - start, status: 0 });
    } catch (error) {
      stages.push({ name, durationMs: Date.now() - start, status: 1 });
      throw error;
    }
  }
  try {
    await run('Type checking', ['node_modules/typescript/lib/tsc.js', '--noEmit']);
    await run('Unit and SDK request contracts', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${resolve(verification, 'unit-results.json')}`]);
    env.SURFWAX_TEST_OUTPUT_DIR = resolve(artifacts.directory, 'e2e/results');
    env.PLAYWRIGHT_HTML_OUTPUT_DIR = resolve(artifacts.directory, 'e2e/html');
    development = await (options.startDevelopmentExtension ?? startDevelopmentExtension)({ cwd, tmpdir: options.tmpdir });
    env.SURFWAX_EXTENSION_PATH = development.extensionPath;
    env.SURFWAX_DEV_SERVER_URL = development.url;
    env.PLAYWRIGHT_JSON_OUTPUT_FILE = resolve(verification, 'e2e-results.json');
    await run('Installed Chrome development E2E', ['node_modules/@playwright/test/cli.js', 'test', '--reporter=list,html,json']);
    status = 'passed';
  } finally {
    try {
      await writeFile(resolve(verification, 'local-ci.json'), JSON.stringify({ node: options.nodeVersion ?? process.version,
        startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
        browser: executablePath, extensionMode: 'development', stages }, null, 2));
    } finally {
      try { await development?.close(); } finally { await artifacts?.finish(status); }
    }
  }
  console.log(`\nLocal CI passed. Evidence: ${artifacts.directory}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLocal().catch(error => { console.error(error); process.exitCode = 1; });
}
