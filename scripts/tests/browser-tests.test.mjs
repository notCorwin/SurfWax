import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runBrowserTests, runCommand } from '../run-browser-tests.mjs';
import { startDevelopmentExtension, systemChromePath } from '../development-extension.mjs';

function development(output, calls) {
  return async () => ({ extensionPath: output, url: 'http://localhost:5179', close: async () => { calls.push('close'); } });
}

test('browser runs use one live development extension and close it on success and failure', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const execute = runBrowserTests('e2e', { cwd: '/repo', node: '/node24', env: { KEEP_ME: 'yes', SURFWAX_EXTENSION_PATH: '/live-user-extension' },
      systemChromePath: () => '/installed/chrome', startDevelopmentExtension: development('/private/dev-extension', calls), args: ['e2e/development.spec.ts'],
      runCommand: async (command, args, options) => {
        calls.push({ command, args, ...options });
        if (fail) throw new Error('browser regression failed');
      } });
    if (fail) await assert.rejects(execute, /browser regression failed/); else await execute;
    assert.equal(calls.length, 2);
    assert.equal(calls[1], 'close');
    assert.equal(calls[0].command, '/node24');
    assert.deepEqual(calls[0].args, ['node_modules/@playwright/test/cli.js', 'test', '--grep-invert', '@performance', 'e2e/development.spec.ts']);
    assert.equal(calls[0].env.SURFWAX_EXTENSION_PATH, '/private/dev-extension');
    assert.equal(calls[0].env.SURFWAX_DEV_SERVER_URL, 'http://localhost:5179');
    assert.equal(calls[0].env.SURFWAX_CHROME_PATH, '/installed/chrome');
    assert.equal(calls[0].env.KEEP_ME, 'yes');
  }
});

test('the Vite dev server supplies HMR and removes private output after closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfwax-dev-lifecycle-'));
  let server;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'vite.config.ts'), `import { mkdir, writeFile } from 'node:fs/promises';
      export default { plugins: [{ name: 'test-extension', async configureServer() {
        await mkdir(process.env.SURFWAX_DEV_OUT_DIR, { recursive: true });
        await writeFile(process.env.SURFWAX_DEV_OUT_DIR + '/manifest.json', JSON.stringify({manifest_version:3,background:{service_worker:'worker.js'}}));
      } }] };`);
    await writeFile(join(root, 'dist-sentinel'), 'live development');
    const oldPort = process.env.SURFWAX_DEV_PORT, oldOutput = process.env.SURFWAX_DEV_OUT_DIR;
    server = await startDevelopmentExtension({ cwd: root, tmpdir: root });
    assert.equal(process.env.SURFWAX_DEV_PORT, oldPort);
    assert.equal(process.env.SURFWAX_DEV_OUT_DIR, oldOutput);
    const response = await fetch(`${server.url}/@vite/client`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /WebSocket/);
    assert.equal(JSON.parse(await readFile(join(server.extensionPath, 'manifest.json'), 'utf8')).manifest_version, 3);
    await server.close();
    await assert.rejects(readFile(join(server.extensionPath, 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(fetch(`${server.url}/@vite/client`));
    assert.equal(await readFile(join(root, 'dist-sentinel'), 'utf8'), 'live development');
    await server.close();
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed development startup closes Vite, removes output and restores environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfwax-dev-failure-'));
  const oldPort = process.env.SURFWAX_DEV_PORT, oldOutput = process.env.SURFWAX_DEV_OUT_DIR;
  let closed = false;
  try {
    await assert.rejects(startDevelopmentExtension({ cwd: root, tmpdir: root,
      createServer: async () => ({ listen: async () => { throw new Error('compile failed'); }, close: async () => { closed = true; } }) }), /compile failed/);
    assert.equal(closed, true);
    assert.deepEqual(await readdir(root), []);
    assert.equal(process.env.SURFWAX_DEV_PORT, oldPort);
    assert.equal(process.env.SURFWAX_DEV_OUT_DIR, oldOutput);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed Chrome is required and downloaded test browsers are rejected', () => {
  assert.throws(() => systemChromePath({ SURFWAX_CHROME_PATH: '/cache/ms-playwright/chromium/chrome' }), /installed Google Chrome/);
  assert.throws(() => systemChromePath({ SURFWAX_CHROME_PATH: '/Google Chrome for Testing.app/chrome' }), /installed Google Chrome/);
  assert.throws(() => systemChromePath({ SURFWAX_CHROME_PATH: '/missing/Google Chrome' }), /Install Google Chrome/);
});

test('subprocess failures settle asynchronously without blocking the development server', async () => {
  await runCommand(process.execPath, ['-e', 'process.exit(0)']);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(3)']), /failed \(3\)/);
});

test('verify-local shares one development server and installed Chrome across browser stages', async () => {
  const { verifyLocal } = await import('../verify-local.mjs');
  const root = await mkdtemp(join(tmpdir(), 'surfwax-verify-test-'));
  const calls = [];
  try {
    await mkdir(join(root, 'private-extension'));
    await verifyLocal({ cwd: root, node: '/node24', nodeVersion: '24.0.0', env: { PATH: '/bin' },
      systemChromePath: () => '/installed/chrome', startDevelopmentExtension: development(join(root, 'private-extension'), calls),
      runCommand: async (command, args, options) => { calls.push({ command, args, env: { ...options.env } }); } });
    const browserCalls = calls.filter(call => call.args?.[0] === 'node_modules/@playwright/test/cli.js');
    assert.equal(browserCalls.length, 2);
    assert.ok(browserCalls.every(call => call.env.SURFWAX_EXTENSION_PATH === join(root, 'private-extension')
      && call.env.SURFWAX_DEV_SERVER_URL === 'http://localhost:5179' && call.env.SURFWAX_CHROME_PATH === '/installed/chrome'));
    assert.equal(calls.at(-1), 'close');
    assert.equal(calls.some(call => call.args?.includes('build')), false);
    const report = JSON.parse(await readFile(join(root, '.dev/verification/local-ci.json'), 'utf8'));
    assert.equal(report.extensionMode, 'development');
    assert.equal(report.browser, '/installed/chrome');
    assert.equal(report.stages.length, calls.length - 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
