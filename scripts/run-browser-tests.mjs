import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Build into a private directory so browser tests never replace the live dev extension. */
export async function runBrowserTests(kind, options = {}) {
  if (kind !== 'e2e' && kind !== 'performance') throw new Error(`Unknown browser test kind: ${kind}`);
  const cwd = resolve(options.cwd ?? process.cwd());
  const spawn = options.spawn ?? spawnSync;
  const node = options.node ?? process.execPath;
  const forwarded = options.args ?? [];
  const output = await mkdtemp(join(options.tmpdir ?? tmpdir(), `surfwax-${kind}-`));
  const env = { ...(options.env ?? process.env), SURFWAX_EXTENSION_PATH: output };
  const run = (command, args) => {
    const result = spawn(command, args, { cwd, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.signal ?? result.status})`);
  };
  try {
    run(node, ['node_modules/vite/bin/vite.js', 'build', '--outDir', output]);
    run(node, ['scripts/validate-build.mjs', output]);
    run(node, ['node_modules/@playwright/test/cli.js', 'test', kind === 'e2e' ? '--grep-invert' : '--grep', '@performance', ...forwarded]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrowserTests(process.argv[2], { args: process.argv.slice(3) }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
