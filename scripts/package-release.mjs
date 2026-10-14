import { readFile, mkdir, mkdtemp, rm, writeFile, link, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { zipSync } from 'fflate';
import { validateBuild } from './validate-build.mjs';

const output = resolve(process.env.SURFWAX_RELEASE_DIR ?? '.dev/releases');
const buildDirectory = resolve(process.argv[2] ?? process.env.SURFWAX_DEV_OUT_DIR ?? 'dist');
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const outputRelative = relative(repository, output);
const outputIsInsideRepository = !isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`);
if (outputIsInsideRepository && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', `${output}${sep}`]).status !== 0) {
  throw new Error('SURFWAX_RELEASE_DIR must be outside the Git worktree or ignored by Git so generated artifacts cannot make the worktree dirty.');
}
const outputRelativeToBuild = relative(buildDirectory, output);
const outputIsInsideBuild = !isAbsolute(outputRelativeToBuild) && outputRelativeToBuild !== '..' && !outputRelativeToBuild.startsWith(`..${sep}`);
if (outputIsInsideBuild) throw new Error('SURFWAX_RELEASE_DIR must not equal or be nested under the build directory because Vite clears that directory before each build.');
const worktreeStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
if (worktreeStatus.trim()) throw new Error('Release packaging requires a clean Git worktree; commit or remove all staged, unstaged, and untracked changes first.');

const { version, files, directory } = await validateBuild(buildDirectory);
await mkdir(output, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : `v${version}`;
if (process.env.GITHUB_REF_TYPE === 'tag' && tag !== `v${version}`) throw new Error(`Release tag ${tag} differs from package version v${version}`);
const archive = join(output, `surf-wax-${version}.zip`);
// Staging shares the destination filesystem so a completed file can be published atomically.
const staging = await mkdtemp(join(output, `.surf-wax-${version}-`));
const candidate = join(staging, `surf-wax-${version}.zip`);
const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH ?? execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim());
if (!Number.isFinite(epochSeconds)) throw new Error('SOURCE_DATE_EPOCH must be a finite Unix timestamp.');
const epochInstant = new Date(epochSeconds * 1000);
const epoch = epochInstant.getUTCFullYear() < 1980
  ? new Date(1980, 0, 1)
  : epochInstant.getUTCFullYear() > 2099
    ? new Date(2099, 11, 31, 23, 59, 58)
    : new Date(epochInstant.getUTCFullYear(), epochInstant.getUTCMonth(), epochInstant.getUTCDate(), epochInstant.getUTCHours(), epochInstant.getUTCMinutes(), epochInstant.getUTCSeconds());
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let checksum;
let reused = false;
try {
  const paths = files
    .map(file => ({ file, archivePath: relative(directory, file).split(sep).join('/') }))
    .sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  const archiveEntries = Object.create(null);
  for (const { file, archivePath } of paths) {
    archiveEntries[archivePath] = [new Uint8Array(await readFile(file)), { mtime: epoch }];
  }
  await writeFile(candidate, zipSync(archiveEntries, { level: 9 }));
  checksum = sha256(await readFile(candidate));
  const checksumText = `${checksum}  surf-wax-${version}.zip\n`;
  try {
    if (sha256(await readFile(archive)) !== checksum) throw new Error(`Release archive for version ${version} already exists with different SHA-256; refusing to overwrite ${archive}. Use a new version or a separate release directory.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    if (await readFile(`${archive}.sha256`, 'utf8') !== checksumText) throw new Error(`Existing checksum differs for version ${version}; refusing to overwrite ${archive}.sha256`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await link(candidate, archive); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha256(await readFile(archive)) !== checksum) throw new Error(`Release archive for version ${version} already exists with different SHA-256; refusing to overwrite ${archive}. Use a new version or a separate release directory.`);
    reused = true;
  }
  const stagedChecksum = join(staging, 'checksum');
  await writeFile(stagedChecksum, checksumText);
  try { await link(stagedChecksum, `${archive}.sha256`); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(`${archive}.sha256`, 'utf8') !== checksumText) throw new Error(`Existing checksum differs for version ${version}; refusing to overwrite ${archive}.sha256`);
  }
  const notes = join(staging, 'release-notes.md');
  await writeFile(notes, `# Surf Wax ${version}\n\nCommit: ${commit}\n\nChrome 138+; Manifest V3. This archive is tied to this version and commit.\n\nThe side panel uses shadcn/ui, GFM/math/code rendering and frame-batched streaming. Model requests recover indefinitely with a maximum 5-second delay; closing the panel aborts model and tool work. New sessions snapshot the system prompt and complete tool catalog in the canonical event log. User Scripts and interaction protection cover all touched pages and frames. All checks, packaging, and delivery are manual. Checks run locally under Node 24, including Chrome 138/current and 120Hz render traces; this package was generated from a clean Git worktree.\n\nDownload the ZIP and checksum, verify SHA-256, extract it, and use Chrome's Load unpacked on the directory containing manifest.json. Chrome Web Store installations update through the store; unpacked installations must be updated manually.\n\nRequired permissions: debugger, downloads, scripting, sidePanel, storage, tabs, unlimitedStorage, userScripts; website access: all URLs. Downloads are created only when you explicitly choose to save a file; no runtime permission prompt is required.\n\nConversation data and full browser/tool results stay in the local canonical event log and are sent directly to your configured model endpoint when used as model context. See PRIVACY.md in the repository for details.\n`);
  // The unversioned notes describe this invocation; immutable versioned assets above never replace files.
  await rename(notes, join(output, 'release-notes.md'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(`${reused ? 'Reused' : 'Created'} ${archive}\nSHA-256: ${checksum}`);
