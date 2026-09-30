import { readFile, mkdir, mkdtemp, copyFile, utimes, rm, writeFile, link, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, relative, dirname, join } from 'node:path';
import { validateBuild } from './validate-build.mjs';

const { version, files, directory } = await validateBuild(process.argv[2] ?? 'dist');
const output = resolve(process.env.SURFWAX_RELEASE_DIR ?? '.dev/releases');
await mkdir(output, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : `v${version}`;
if (process.env.GITHUB_REF_TYPE === 'tag' && tag !== `v${version}`) throw new Error(`Release tag ${tag} differs from package version v${version}`);
const archive = join(output, `surf-wax-${version}.zip`);
// Staging shares the destination filesystem so a completed file can be published atomically.
const staging = await mkdtemp(join(output, `.surf-wax-${version}-`));
const contents = join(staging, 'contents');
const candidate = join(staging, `surf-wax-${version}.zip`);
const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim()) * 1000);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let checksum;
let reused = false;
try {
  const paths = files.map(file => relative(directory, file)).sort();
  for (const path of paths) {
    const destination = join(contents, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(directory, path), destination);
    await utimes(destination, epoch, epoch);
  }
  execFileSync('zip', ['-X', '-q', candidate, ...paths], { cwd: contents });
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
  await writeFile(notes, `# Surf Wax ${version}\n\nCommit: ${commit}\n\nChrome 138+; Manifest V3. This archive is tied to this version and commit.\n\nDownload the ZIP and checksum, verify SHA-256, extract it, and use Chrome's Load unpacked on the directory containing manifest.json. Chrome Web Store installations update through the store; unpacked installations must be updated manually.\n\nRequired permissions: debugger, scripting, sidePanel, storage, tabs, unlimitedStorage, userScripts; website access: all URLs. downloads is requested only when you choose to save a file.\n\nConversation data and full browser/tool results stay in the local canonical event log and are sent directly to your configured model endpoint when used as model context. See PRIVACY.md in the repository for details.\n`);
  // The unversioned notes describe this invocation; immutable versioned assets above never replace files.
  await rename(notes, join(output, 'release-notes.md'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(`${reused ? 'Reused' : 'Created'} ${archive}\nSHA-256: ${checksum}`);
