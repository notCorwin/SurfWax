import { access, mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Immutable pre-0.3 source; upgrading this fixture must be a reviewed change.
const base = '39fd9abb6f7bc4a15a379c150591a1c71ee460f1';
const directory = resolve('.dev/upgrade-v0.2.0');
try { await access(resolve(directory, 'dist/manifest.json')); } catch {
  await mkdir(directory, { recursive: true });
  const archive = execFileSync('git', ['archive', base], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
  try { await access(resolve(directory, 'node_modules')); } catch { await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir'); }
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], { cwd: directory, stdio: 'inherit' });
  await writeFile(resolve(directory, 'fixture-source.json'), JSON.stringify({ commit: base, version: '0.2.0' }, null, 2));
}
const manifest = JSON.parse(await readFile(resolve(directory, 'dist/manifest.json'), 'utf8'));
if (manifest.version !== '0.2.0') throw new Error('Historical upgrade fixture version changed');
console.log(`Upgrade fixture: ${directory}/dist (${base})`);
