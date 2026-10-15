import { readFile, mkdir, mkdtemp, rm, writeFile, link, rename } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, relative, join, isAbsolute, sep, dirname, basename } from 'node:path';
import { zipSync } from 'fflate';
import { validateBuild } from './validate-build.mjs';

process.env.TZ = 'UTC';

const canonicalPath = path => {
  let existing = resolve(path);
  const missing = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
};
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Release packaging requires Node 24.');
const isInside = (parent, candidate) => {
  const path = relative(parent, candidate);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const buildRequested = process.argv[2] === '--build';
const repository = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const gitDirectory = realpathSync(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim());
const gitEntry = resolve(repository, '.git');
const outputRequested = resolve(process.env.SURFWAX_RELEASE_DIR ?? '.dev/releases');
const buildDirectoryRequested = resolve((buildRequested ? undefined : process.argv[2]) ?? process.env.SURFWAX_DEV_OUT_DIR ?? 'dist');
if (isInside(gitEntry, outputRequested)) throw new Error('SURFWAX_RELEASE_DIR must not be inside the Git metadata directory.');
if (isInside(gitEntry, buildDirectoryRequested)) throw new Error('SURFWAX_DEV_OUT_DIR must not be inside the Git metadata directory because Vite clears the build directory.');
const output = canonicalPath(outputRequested);
const buildDirectory = canonicalPath(buildDirectoryRequested);
if (isInside(gitDirectory, output)) throw new Error('SURFWAX_RELEASE_DIR must not be inside the Git metadata directory.');
if (isInside(gitDirectory, buildDirectory)) throw new Error('SURFWAX_DEV_OUT_DIR must not be inside the Git metadata directory because Vite clears the build directory.');
const outputIsInsideRepository = isInside(repository, output);
if (outputIsInsideRepository && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', `${output}${sep}`]).status !== 0) {
  throw new Error('SURFWAX_RELEASE_DIR must be outside the Git worktree or ignored by Git so generated artifacts cannot make the worktree dirty.');
}
if (isInside(buildDirectory, repository)) throw new Error('SURFWAX_DEV_OUT_DIR must not equal or contain the Git worktree because Vite clears the build directory.');
const outputIsInsideBuild = isInside(buildDirectory, output);
if (outputIsInsideBuild) throw new Error('SURFWAX_RELEASE_DIR must not equal or be nested under the build directory because Vite clears that directory before each build.');
const publicDirectory = canonicalPath(resolve(repository, 'public'));
const outputIsInsidePublic = isInside(publicDirectory, output);
if (outputIsInsidePublic) throw new Error('SURFWAX_RELEASE_DIR must not equal or be nested under public because Vite copies that directory into every build.');
if (isInside(publicDirectory, buildDirectory)) throw new Error('SURFWAX_DEV_OUT_DIR must not equal or be nested under public because Vite copies that directory into every build.');
const ignoredPublicInputs = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'public'], { encoding: 'utf8' });
if (ignoredPublicInputs.trim()) throw new Error(`Release packaging refuses ignored files under public because Vite copies them into the build:\n${ignoredPublicInputs.trim()}`);
const buildIsInsideRepository = isInside(repository, buildDirectory);
if (buildIsInsideRepository && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', `${buildDirectory}${sep}`]).status !== 0) {
  throw new Error('SURFWAX_DEV_OUT_DIR must be outside the Git worktree or ignored by Git so the build cannot make the worktree dirty.');
}
const assertCleanWorktree = () => {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
  if (status.trim()) throw new Error('Release packaging requires a clean Git worktree; commit or remove all staged, unstaged, and untracked changes first.');
};
assertCleanWorktree();

const packageVersion = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
const expectedTag = `v${packageVersion}`;
const refTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (refTag && refTag !== expectedTag) throw new Error(`Release tag ${refTag} differs from package version ${expectedTag}`);
const versionTagsAtHead = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'], { cwd: repository, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const mismatchedVersionTags = versionTagsAtHead.filter(tag => tag !== expectedTag);
if (mismatchedVersionTags.length > 0) throw new Error(`Checked-out version tag ${mismatchedVersionTags.join(', ')} differs from package version ${expectedTag}`);

if (buildRequested) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installEnvironment = { ...process.env };
  delete installEnvironment.NODE_ENV;
  delete installEnvironment.NPM_CONFIG_PRODUCTION;
  delete installEnvironment.npm_config_production;
  execFileSync(npm, ['ci', '--include=dev'], { cwd: repository, stdio: 'inherit', env: installEnvironment });
  execFileSync(npm, ['run', 'verify:local'], { cwd: repository, stdio: 'inherit', env: installEnvironment });
  assertCleanWorktree();
}

const verification = JSON.parse(await readFile(join(repository, '.dev/verification/local-ci.json'), 'utf8').catch(() => '{}'));
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (verification.success !== true || verification.commit !== currentCommit || verification.version !== packageVersion
  || Number(String(verification.node ?? '').replace(/^v/, '').split('.')[0]) !== 24) {
  throw new Error('Release packaging requires a successful Node 24 verify:local result for this exact version and commit.');
}

const { version, files, directory } = await validateBuild(buildDirectory);
if (version !== packageVersion) throw new Error(`Built version ${version} differs from package version ${packageVersion}`);
await mkdir(output, { recursive: true });
const commit = currentCommit;
const archive = join(output, `surf-wax-${version}.zip`);
// Staging shares the destination filesystem so a completed file can be published atomically.
const staging = await mkdtemp(join(output, `.surf-wax-${version}-`));
const candidate = join(staging, `surf-wax-${version}.zip`);
const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH ?? execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim());
if (!Number.isFinite(epochSeconds)) throw new Error('SOURCE_DATE_EPOCH must be a finite Unix timestamp.');
const epoch = new Date(Math.min(Date.UTC(2099, 11, 31, 23, 59, 58), Math.max(Date.UTC(1980, 0, 1), epochSeconds * 1000)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let checksum;
let reused = false;
try {
  const paths = files
    .map(file => ({ file, archivePath: relative(directory, file).split(sep).join('/') }))
    .sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0);
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
  await writeFile(notes, `# Surf Wax ${version}\n\nCommit: ${commit}\n\nChrome 138+; Manifest V3. This archive is tied to this version and commit.\n\nThe side panel uses Base UI, GFM/math/code rendering and frame-batched streaming. Model requests recover indefinitely with a maximum 5-second delay; closing the panel aborts model and tool work. New sessions snapshot the system prompt and complete tool catalog in the canonical event log. User Scripts and interaction protection cover all touched pages and frames. The exact commit passed the Node 24 local CI matrix, including Chrome 138/current, dependency audit and 120Hz render traces, before this package was generated from a clean Git worktree.\n\nDownload the ZIP and checksum, verify SHA-256, extract it, and use Chrome's Load unpacked on the directory containing manifest.json. To retain the same unpacked extension identity and local data, replace the files in the existing extension directory and reload it instead of loading a new versioned directory. Chrome Web Store installations update through the store.\n\nRequired permissions: debugger, downloads, scripting, sidePanel, storage, tabs, unlimitedStorage, userScripts; website access: all URLs. Agent-created files remain internal until you approve each download in the Side Panel.\n\nConversation data and full browser/tool results stay in the local canonical event log and are sent directly to your configured model endpoint when used as model context. Deleting a conversation adds an undoable tombstone; the settings action permanently clears event and artifact data from IndexedDB. See PRIVACY.md in the repository for details.\n`);
  // The unversioned notes describe this invocation; immutable versioned assets above never replace files.
  await rename(notes, join(output, 'release-notes.md'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(`${reused ? 'Reused' : 'Created'} ${archive}\nSHA-256: ${checksum}`);
