import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevelopmentExtension, systemChromePath } from './development-extension.mjs';

export async function runCommand(command, args, options = {}) {
  const { spawn: createProcess = spawn, ...settings } = options;
  await new Promise((accept, reject) => {
    const child = createProcess(command, args, { ...settings, stdio: 'inherit' });
    const interrupt = signal => child.kill(signal);
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
    const cleanup = () => { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      code === 0 ? accept() : reject(new Error(`${command} ${args[0]} failed (${signal ?? code})`));
    });
  });
}

/** Keep Vite responsive while Playwright exercises the development extension. */
export async function runBrowserTests(kind, options = {}) {
  if (kind !== 'e2e' && kind !== 'performance') throw new Error(`Unknown browser test kind: ${kind}`);
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourceEnv = options.env ?? process.env;
  const executablePath = (options.systemChromePath ?? systemChromePath)(sourceEnv);
  const development = await (options.startDevelopmentExtension ?? startDevelopmentExtension)({ cwd, tmpdir: options.tmpdir });
  const env = { ...sourceEnv, SURFWAX_EXTENSION_PATH: development.extensionPath, SURFWAX_DEV_SERVER_URL: development.url,
    SURFWAX_CHROME_PATH: executablePath };
  try {
    await (options.runCommand ?? runCommand)(options.node ?? process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', kind === 'e2e' ? '--grep-invert' : '--grep', '@performance', ...(options.args ?? [])], { cwd, env });
  } finally { await development.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrowserTests(process.argv[2], { args: process.argv.slice(3) }).catch(error => { console.error(error); process.exitCode = 1; });
}
