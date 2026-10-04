import { readFile, readdir, access, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredPermissions = ['debugger', 'downloads', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage', 'userScripts'];
export async function validateBuild(directory = 'dist') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== packageInfo.version || lock.packages[''].version !== packageInfo.version) throw new Error('package-lock version differs from package.json');
  if (!/^\d+(?:\.\d+){0,3}$/.test(packageInfo.version) || packageInfo.version.split('.').some(value => Number(value) > 65535)) throw new Error('Version is not a Chrome-compatible numeric version');
  const output = resolve(root, directory);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const equal = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (manifest.version !== packageInfo.version) throw new Error('Built manifest version differs from package.json');
  if (!equal(manifest.permissions ?? [], requiredPermissions)) throw new Error('Unexpected required extension permissions');
  if (!equal(manifest.optional_permissions ?? [], [])) throw new Error('No optional extension permissions are expected');
  if (!equal(manifest.host_permissions ?? [], ['<all_urls>'])) throw new Error('Expected all_urls host access');
  if (manifest.minimum_chrome_version !== '138' || manifest.manifest_version !== 3) throw new Error('Unsupported browser/manifest contract');
  if (manifest.devtools_page || manifest.offscreen_document) throw new Error('Removed execution hosts remain in manifest');
  for (const path of [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, 'userscripts.html', ...Object.values(manifest.icons)]) await access(join(output, path));
  const guards = manifest.content_scripts?.filter(script => script.run_at === 'document_start' && script.all_frames);
  if (!guards?.length) throw new Error('Document-start interaction capture is missing');
  for (const script of guards.flatMap(script => script.js ?? [])) {
    const code = await readFile(join(output, script), 'utf8');
    if (/\bimport\s*\(/.test(code)) throw new Error(`Interaction capture must run synchronously: ${script}`);
  }
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return (await Promise.all(entries.map(async entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]))).flat();
  }
  const files = await walk(output);
  const sidepanel = await readFile(join(output, manifest.side_panel.default_path), 'utf8');
  const entrypoint = sidepanel.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
  if (!entrypoint) throw new Error('Side panel JavaScript entrypoint missing');
  const entrypointBytes = (await stat(join(output, entrypoint.replace(/^\//, '')))).size;
  if (entrypointBytes > 2_000_000) throw new Error(`Side panel entrypoint ${entrypointBytes} bytes exceeds the 2,000,000-byte budget`);
  if (files.some(path => /(?:^|\/)(?:offscreen|devtools)(?:[.-]|\/)/.test(path))) throw new Error('Removed execution host is included in build');
  return { version: packageInfo.version, manifest, files, directory: output, entrypointBytes };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await validateBuild(process.argv[2]);
  console.log(`Validated Surf Wax ${result.version}: ${result.files.length} files, ${result.manifest.permissions.length} required permissions, main JavaScript ${result.entrypointBytes} bytes.`);
}
