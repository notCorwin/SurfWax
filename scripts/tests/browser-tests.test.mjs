import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runBrowserTests } from '../run-browser-tests.mjs';

test('browser test builds are private, propagated to every child and removed after use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfwax-test-runner-'));
  const outputPaths = [];
  try {
    await writeFile(join(root, 'dist-sentinel'), 'development');
    for (const kind of ['e2e', 'performance']) {
      const calls = [];
      const spawn = (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      };
      await runBrowserTests(kind, { cwd: root, tmpdir: root, node: '/test-node', spawn,
        env: { KEEP_ME: 'yes', SURFWAX_EXTENSION_PATH: '/dev-extension' }, args: ['--workers=2'] });
      assert.equal(calls.length, 3);
      const output = calls[0].args.at(-1);
      outputPaths.push(output);
      assert.match(output, new RegExp(`^${root}/surfwax-${kind}-`));
      assert.deepEqual(calls[0].args.slice(0, -1), ['node_modules/vite/bin/vite.js', 'build', '--outDir']);
      assert.deepEqual(calls[1].args, ['scripts/validate-build.mjs', output]);
      assert.deepEqual(calls[2].args, ['node_modules/@playwright/test/cli.js', 'test', kind === 'e2e' ? '--grep-invert' : '--grep', '@performance', '--workers=2']);
      for (const call of calls) {
        assert.equal(call.command, '/test-node');
        assert.equal(call.options.cwd, root);
        assert.equal(call.options.env.SURFWAX_EXTENSION_PATH, output);
        assert.equal(call.options.env.KEEP_ME, 'yes');
      }
      assert.deepEqual(await readdir(root), ['dist-sentinel']);
    }
    assert.notEqual(outputPaths[0], outputPaths[1]);
    assert.equal(await readFile(join(root, 'dist-sentinel'), 'utf8'), 'development');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed builds do not start Playwright and still remove the private output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfwax-test-runner-'));
  const calls = [];
  try {
    await assert.rejects(runBrowserTests('e2e', { cwd: root, tmpdir: root,
      spawn: (_command, args) => { calls.push(args); return { status: 1 }; } }), /failed/);
    assert.equal(calls.length, 1);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verify-local builds, validates and runs both browser stages against one private extension', async () => {
  const { verifyLocal } = await import('../verify-local.mjs');
  const root = await mkdtemp(join(tmpdir(), 'surfwax-verify-test-'));
  const calls = [];
  try {
    await writeFile(join(root, 'dist-sentinel'), 'development');
    await verifyLocal({ cwd: root, tmpdir: root, node: '/node24', nodeVersion: '24.0.0', env: { PATH: '/bin', SURFWAX_EXTENSION_PATH: '/dev-extension' },
      spawn: (command, args, options) => {
        calls.push({ command, args: [...args], env: { ...options.env } });
        return { status: 0, stdout: args[0] === 'scripts/install-test-browser.mjs' ? `/chrome-${args[1]}` : '' };
      } });
    const build = calls.find((call) => call.args[0] === 'node_modules/vite/bin/vite.js');
    const output = build.args.at(-1);
    assert.match(output, new RegExp(`^${root}/surfwax-verify-`));
    assert.deepEqual(build.args.slice(0, -1), ['node_modules/vite/bin/vite.js', 'build', '--outDir']);
    assert.deepEqual(calls.find((call) => call.args[0] === 'scripts/validate-build.mjs').args, ['scripts/validate-build.mjs', output]);
    const browserCalls = calls.filter((call) => call.args[0] === 'node_modules/@playwright/test/cli.js');
    assert.equal(browserCalls.length, 2);
    assert.ok(browserCalls.every((call) => call.env.SURFWAX_EXTENSION_PATH === output));
    assert.equal(browserCalls[0].env.SURFWAX_CHROME_138_PATH, '/chrome-138');
    assert.equal(browserCalls[0].env.SURFWAX_CHROME_PATH, '/chrome-current');
    assert.equal(await readFile(join(root, 'dist-sentinel'), 'utf8'), 'development');
    await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(root, '.dev/verification/local-ci.json'), 'utf8')).stages.length, calls.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
