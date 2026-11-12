import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
// Only these obsolete generated outputs are eligible for the one-off migration.
const LEGACY = ['align-performance-results', 'nonstream-performance-results', 'nonstream-performance-final',
  'profile-results', 'render-fix-results',
  'verification/alignment-2026-10-04T153056Z', 'verification/performance/chrome138'];
const CACHES = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache'];

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Never follow symlinks into a live profile or outside the repository.
async function safePath(root, path) {
  const suffix = relative(root, path);
  if (!suffix || suffix.startsWith('..') || resolve(path) !== path) throw new Error(`Unsafe cleanup path: ${path}`);
  let current = root;
  for (const part of ['', ...suffix.split(sep)]) {
    current = part ? join(current, part) : current;
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Cleanup refuses symlink: ${current}`); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

async function measure(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { bytes: 0, modified: 0 }; throw error; }
  if (stat.isSymbolicLink()) return { bytes: 0, modified: stat.mtimeMs };
  let bytes = stat.isFile() ? stat.size : 0, modified = stat.mtimeMs;
  if (stat.isDirectory()) for (const entry of await entries(path)) {
    const child = await measure(join(path, entry.name));
    bytes += child.bytes; modified = Math.max(modified, child.modified);
  }
  return { bytes, modified };
}

// Shared by the development launcher and cache cleanup. Stale locks fail closed;
// after a crash, verify Chrome is stopped before removing the named lock directory.
export async function lockProfile(profile, cwd = process.cwd()) {
  const root = resolve(cwd), lock = `${resolve(profile)}.cleanup-lock`;
  await safePath(root, lock);
  // A process start time distinguishes a reused PID when inspected with ps.
  const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(process.pid)]);
  const processStartedAt = stdout.trim();
  if (!processStartedAt) throw new Error('Unable to identify the profile lock owner process.');
  await mkdir(join(lock, '..'), { recursive: true });
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  const owner = randomUUID(), record = join(lock, owner);
  let created = false;
  try {
    const file = await open(record, 'wx');
    created = true;
    try { await file.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), owner, processStartedAt })); }
    finally { await file.close(); }
  } catch (error) {
    // Remove only our own record and an empty directory; never recursively delete a lock.
    await safePath(root, lock);
    if (created) await unlink(record).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(lock).catch(e => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await safePath(root, lock);
    try { await unlink(record); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try { await rmdir(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
}

export async function cleanDevStorage({ cwd = process.cwd(), apply = false, legacy = false, caches = true,
  cacheBudgetBytes = 0, maxRuns = 3, maxBytes = 512 * 1024 ** 2, maxAgeMs = 14 * DAY, now = Date.now() } = {}) {
  const root = resolve(cwd), dev = join(root, '.dev'), candidates = [], skipped = [];
  await safePath(root, dev);
  await safePath(root, join(dev, 'artifacts'));
  const runs = [];
  for (const entry of await entries(join(dev, 'artifacts'))) {
    if (!entry.isDirectory()) continue;
    const path = join(dev, 'artifacts', entry.name);
    await safePath(root, path);
    let receipt;
    try { receipt = JSON.parse(await readFile(join(path, 'run.json'), 'utf8')); }
    catch { skipped.push(`${path}: missing/invalid run receipt`); continue; }
    if (!receipt || !['e2e', 'performance', 'local-ci'].includes(receipt.kind) || !Number.isFinite(receipt.startedAt)) {
      skipped.push(`${path}: invalid run receipt`); continue;
    }
    if (!Number.isFinite(receipt.finishedAt)) { skipped.push(`${path}: unfinished run; may still be active, retained for manual inspection`); continue; }
    runs.push({ path, ...await measure(path), kind: receipt.kind, finishedAt: receipt.finishedAt });
  }
  runs.sort((a, b) => b.finishedAt - a.finishedAt);
  let keptBytes = 0;
  const counts = new Map();
  for (const run of runs) {
    const count = counts.get(run.kind) ?? 0;
    // Always keep the newest completed run for each test kind, including failures.
    if (count > 0 && (count >= maxRuns || now - run.finishedAt > maxAgeMs || keptBytes + run.bytes > maxBytes)) candidates.push(run);
    else { counts.set(run.kind, count + 1); keptBytes += run.bytes; }
  }
  if (keptBytes > maxBytes) skipped.push('Latest test evidence exceeds the 512 MiB budget; retained for diagnosis.');
  if (legacy) for (const name of LEGACY) {
    const path = join(dev, name);
    await safePath(root, path);
    const info = await measure(path);
    if (info.modified && now - info.modified > maxAgeMs) candidates.push({ path, ...info });
    else if (info.modified) skipped.push(`${path}: recently modified; retained`);
  }
  async function remove(item) {
    await safePath(root, item.path);
    // Finder can recreate .DS_Store during recursive deletion on macOS.
    if (apply) await rm(item.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  }
  for (const item of candidates) await remove(item);
  if (caches && process.platform === 'win32') skipped.push('Cache cleanup is unavailable on Windows; retained all browser caches.');
  else if (caches) for (const entry of await entries(dev)) {
    if (!entry.isDirectory() || !/^chromium-profile(?:-archive-[\w-]+)?$/.test(entry.name)) continue;
    const profile = join(dev, entry.name);
    const unlock = await lockProfile(profile, cwd);
    if (!unlock) { skipped.push(`${profile}: profile locked; retained`); continue; }
    try {
      // Inspect processes while holding the same lock used by the development launcher.
      const { stdout } = await promisify(execFile)('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 ** 2 });
      if (stdout.includes(`--user-data-dir=${profile}`) || stdout.includes(`--user-data-dir="${profile}"`)) {
        skipped.push(`${profile}: Chrome is using this profile`); continue;
      }
      const cacheItems = [];
      for (const name of CACHES) {
        const path = join(profile, name);
        await safePath(root, path);
        const info = await measure(path);
        if (info.modified) cacheItems.push({ path, ...info });
      }
      if (cacheItems.reduce((sum, item) => sum + item.bytes, 0) > cacheBudgetBytes) {
        for (const item of cacheItems) { candidates.push(item); await remove(item); }
      }
    } finally { await unlock(); }
  }
  return { candidates, skipped, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0) };
}

export async function beginArtifactRun(kind, cwd = process.cwd()) {
  const root = resolve(cwd), directory = join(root, '.dev/artifacts', `${Date.now()}-${kind}-${randomUUID()}`);
  await safePath(root, directory);
  await mkdir(directory, { recursive: true });
  const receipt = { kind, pid: process.pid, startedAt: Date.now() };
  await writeFile(join(directory, 'run.json'), JSON.stringify(receipt));
  return { directory, async finish(status) {
    await writeFile(join(directory, 'run.json'), JSON.stringify({ ...receipt, status, finishedAt: Date.now() }));
    const result = await cleanDevStorage({ cwd, apply: true, caches: false });
    for (const message of result.skipped) console.warn(`Retention: ${message}`);
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--legacy', '--no-caches'].includes(arg))) {
    console.error('Usage: npm run dev:clean -- [--apply] [--legacy] [--no-caches]'); process.exitCode = 1;
  } else {
    try {
      const result = await cleanDevStorage({ apply: args.includes('--apply'), legacy: args.includes('--legacy'), caches: !args.includes('--no-caches') });
      for (const item of result.candidates) console.log(`${args.includes('--apply') ? 'Removed' : 'Would remove'} ${(item.bytes / 1024 ** 2).toFixed(1)} MiB  ${relative(process.cwd(), item.path)}`);
      for (const message of result.skipped) console.log(`Kept: ${message}`);
      console.log(`${args.includes('--apply') ? 'Removed' : 'Reclaimable'}: ${(result.bytes / 1024 ** 2).toFixed(1)} MiB. ${args.includes('--apply') ? '' : 'Preview only; pass --apply to delete.'}`);
    } catch (error) { console.error(`Cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
