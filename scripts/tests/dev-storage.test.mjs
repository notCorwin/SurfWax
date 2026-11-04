import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { beginArtifactRun, cleanDevStorage, lockProfile } from '../dev-storage.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'surfwax-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function file(path, text = 'keep') { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); }

test('cleanup previews before deleting, bounds completed evidence and preserves active/unknown data', async t => {
  const cwd = await fixture(t), now = Date.now();
  for (let index = 0; index < 5; index++) {
    const dir = join(cwd, '.dev/artifacts', String(index));
    await file(join(dir, 'run.json'), JSON.stringify({ kind: 'e2e', pid: process.pid, startedAt: now - index * 1000, finishedAt: now - index * 1000, status: 'failed' }));
    await file(join(dir, 'trace.json'), 'x'.repeat(100));
  }
  const active = await beginArtifactRun('performance', cwd);
  await file(join(cwd, '.dev/artifacts/unknown/secret'), 'untouched');
  await file(join(cwd, '.dev/chromium-profile/Default/IndexedDB/session'), 'conversation');
  const preview = await cleanDevStorage({ cwd, caches: false, now, maxBytes: 1 });
  assert.equal(preview.candidates.length, 4); // newest remains even above budget
  assert.equal((await readdir(join(cwd, '.dev/artifacts'))).length, 7);
  assert.ok(preview.skipped.some(value => value.includes('unfinished run')));
  await cleanDevStorage({ cwd, caches: false, apply: true, now });
  assert.deepEqual((await readdir(join(cwd, '.dev/artifacts'))).filter(name => /^\d$/.test(name)), ['0', '1', '2']);
  assert.equal(await readFile(join(cwd, '.dev/chromium-profile/Default/IndexedDB/session'), 'utf8'), 'conversation');
  assert.equal(await readFile(join(cwd, '.dev/artifacts/unknown/secret'), 'utf8'), 'untouched');
  await active.finish('failed');
  assert.equal(JSON.parse(await readFile(join(active.directory, 'run.json'), 'utf8')).status, 'failed');
});

test('legacy cleanup requires explicit opt-in and preserves recent outputs, releases and profile data', async t => {
  const cwd = await fixture(t), old = new Date(Date.now() - 30 * 86400000);
  const path = join(cwd, '.dev/profile-results');
  await file(join(path, 'trace.json'));
  await utimes(join(path, 'trace.json'), old, old); await utimes(path, old, old);
  await file(join(cwd, '.dev/fix-dist/manifest.json'));
  await utimes(join(cwd, '.dev/fix-dist/manifest.json'), old, old);
  await utimes(join(cwd, '.dev/fix-dist'), old, old);
  await file(join(cwd, '.dev/releases/accepted/package.zip'));
  assert.equal((await cleanDevStorage({ cwd, caches: false })).candidates.length, 0);
  const result = await cleanDevStorage({ cwd, caches: false, legacy: true, apply: true });
  assert.equal(result.candidates.length, 1);
  await assert.rejects(readFile(join(path, 'trace.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(cwd, '.dev/fix-dist/manifest.json'), 'utf8'), 'keep');
  assert.equal(await readFile(join(cwd, '.dev/releases/accepted/package.zip'), 'utf8'), 'keep');
});

test('cache cleanup keeps archived sessions and removes only regenerable cache paths', async t => {
  if (process.platform === 'win32') return t.skip('Cache cleanup deliberately disabled without process inspection');
  const cwd = await fixture(t), profile = join(cwd, '.dev/chromium-profile-archive-test/Default');
  await file(join(profile, 'Cache/data'));
  await file(join(profile, 'Code Cache/data'));
  await file(join(profile, 'IndexedDB/events'));
  await file(join(profile, 'Cookies'));
  assert.equal((await cleanDevStorage({ cwd, apply: true, cacheBudgetBytes: 256 * 1024 ** 2 })).candidates.length, 0);
  const preview = await cleanDevStorage({ cwd });
  assert.equal(preview.candidates.length, 2);
  assert.equal(await readFile(join(profile, 'Cache/data'), 'utf8'), 'keep');
  await cleanDevStorage({ cwd, apply: true });
  await assert.rejects(readFile(join(profile, 'Cache/data')), { code: 'ENOENT' });
  assert.equal(await readFile(join(profile, 'IndexedDB/events'), 'utf8'), 'keep');
  assert.equal(await readFile(join(profile, 'Cookies'), 'utf8'), 'keep');
});

test('cleanup refuses symlink ancestors and never follows symlinks inside generated outputs', async t => {
  const cwd = await fixture(t), outside = await fixture(t);
  await file(join(outside, 'sentinel'));
  await mkdir(join(cwd, '.dev'));
  await symlink(outside, join(cwd, '.dev/artifacts'));
  await assert.rejects(beginArtifactRun('e2e', cwd), /symlink/);
  await assert.rejects(cleanDevStorage({ cwd, caches: false }), /symlink/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
});


test('completion order protects a long-running failure and unfinished orphan evidence', async t => {
  const cwd = await fixture(t), now = Date.now();
  for (let index = 0; index < 4; index++) {
    await file(join(cwd, '.dev/artifacts', String(index), 'run.json'), JSON.stringify({
      kind: 'e2e', pid: 2147483647, startedAt: now - (4 - index) * 10000,
      ...(index === 0 ? {} : { finishedAt: now - index * 1000 }), status: 'failed',
    }));
  }
  await file(join(cwd, '.dev/artifacts/long/run.json'), JSON.stringify({ kind: 'e2e',
    startedAt: now - 86400000, finishedAt: now, status: 'failed' }));
  const result = await cleanDevStorage({ cwd, apply: true, caches: false, maxRuns: 1 });
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(await readdir(join(cwd, '.dev/artifacts')), ['0', 'long']);
});

test('profile launch and cleanup share an exclusive lock', async t => {
  const cwd = await fixture(t), profile = join(cwd, '.dev/chromium-profile');
  await file(join(profile, 'Default/Cache/data'));
  const release = await lockProfile(profile, cwd);
  try {
    assert.equal(await lockProfile(profile, cwd), null);
    const result = await cleanDevStorage({ cwd, apply: true });
    assert.equal(result.candidates.length, 0);
    assert.equal(await readFile(join(profile, 'Default/Cache/data'), 'utf8'), 'keep');
  } finally { await release(); }
  const releaseAgain = await lockProfile(profile, cwd);
  assert.equal(typeof releaseAgain, 'function'); await releaseAgain();
});

test('legacy cleanup inspects every ancestor including intermediate junctions', async t => {
  const cwd = await fixture(t), outside = await fixture(t);
  await file(join(outside, 'alignment-2026-10-04T153056Z/sentinel'));
  await mkdir(join(cwd, '.dev'));
  await symlink(outside, join(cwd, '.dev/verification'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanDevStorage({ cwd, caches: false, legacy: true, apply: true }), /symlink/);
  assert.equal(await readFile(join(outside, 'alignment-2026-10-04T153056Z/sentinel'), 'utf8'), 'keep');
});
