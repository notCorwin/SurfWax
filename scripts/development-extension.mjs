import { accessSync, constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Resolve an installed browser, never Playwright's downloaded test browser. */
export function systemChromePath(env = process.env, platform = process.platform, verifyInstalled = true) {
  const executable = env.SURFWAX_CHROME_PATH || (platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
  if (/chrome[ -]for[ -]testing|ms-playwright|test-browsers/i.test(executable))
    throw new Error('Use the locally installed Google Chrome, not Chrome for Testing or a Playwright browser.');
  if (!verifyInstalled) return executable;
  try { accessSync(executable, constants.X_OK); }
  catch (cause) { throw new Error(`Google Chrome is not installed at ${executable}. Install Google Chrome or set SURFWAX_CHROME_PATH to its executable.`, { cause }); }
  return executable;
}

/** Use the available desktop area without entering fullscreen. */
export async function fitWindowToScreen(context, page, session) {
  const browserSession = session ?? await context.browser().newBrowserCDPSession();
  const pageSession = await context.newCDPSession(page);
  try {
    const { windowId } = await pageSession.send('Browser.getWindowForTarget');
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const screenBounds = await page.evaluate(() => ({ left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight }));
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: screenBounds });
    const { bounds } = await browserSession.send('Browser.getWindowBounds', { windowId });
    if (Object.entries(screenBounds).some(([key, value]) => bounds[key] !== value))
      throw new Error('Cannot resize the development Chrome window to the available screen area.');
  } finally { await pageSession.detach(); if (!session) await browserSession.detach(); }
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(0, 'localhost', accept); });
  const port = probe.address().port;
  await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  return port;
}

/** A private dev output and live HMR server shared by all tests in one invocation. */
export async function startDevelopmentExtension(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const directory = await mkdtemp(join(options.tmpdir ?? tmpdir(), 'surfwax-development-'));
  const extensionPath = join(directory, 'extension');
  const port = await availablePort();
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await server?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    const createServer = options.createServer ?? (await import('vite')).createServer;
    // Inline configuration keeps parallel launches independent; never mutate
    // process-wide environment while Vite asynchronously loads its config.
    server = await createServer({ root: cwd, configFile: resolve(cwd, 'vite.config.ts'),
      cacheDir: join(directory, 'vite-cache'),
      define: { __SURF_WAX_DEV_SERVER__: JSON.stringify(`http://localhost:${port}`) },
      server: { host: 'localhost', port, strictPort: true, ws: { host: 'localhost', clientPort: port } },
      build: { outDir: extensionPath } });
    await server.listen();
    const url = `http://localhost:${port}`;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (true) {
      try { await access(join(extensionPath, 'manifest.json')); break; }
      catch {
        if (Date.now() >= deadline) throw new Error('Development extension did not become ready. Check Vite compilation errors.');
        await new Promise(accept => setTimeout(accept, 50));
      }
    }
    const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3 || !manifest.background?.service_worker)
      throw new Error('The development output does not contain a Manifest V3 extension.');
    const response = await fetch(`${url}/@vite/client`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Vite HMR client is unavailable (${response.status}).`);
    return { extensionPath, url, port, close };
  } catch (error) { await close(); throw error; }

}
