import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = resolve(process.argv[2] ?? '.dev/releases');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = join(directory, `surf-wax-${version}.zip`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = (await readFile(`${source}.sha256`, 'utf8')).trim().split(/\s+/)[0];
if (sha256(await readFile(source)) !== expected) throw new Error('Verified versioned archive checksum differs');
const preview = join(directory, 'surf-wax-autobuild.zip');
await copyFile(source, preview);
await writeFile(`${preview}.sha256`, `${sha256(await readFile(preview))}  surf-wax-autobuild.zip\n`);
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(join(directory, 'autobuild-notes.md'), `# Surf Wax Autobuild\n\nThis is the mutable test channel, not a formal version release. It is a prerelease and never Latest.\n\nCommit: ${commit}\nManifest version: ${version}\n\nCD validates the eight required permissions, builds the extension archive and verifies its checksum. Run npm run verify:local with Node 24 before pushing: documentation, Models.dev SDK coverage, types, build, unit tests, Chrome 138/current E2E and rendering trace performance are local CI.\n\nVerify surf-wax-autobuild.zip.sha256, extract the ZIP and use Chrome's Load unpacked on the directory containing manifest.json. Future successful master builds replace these two fixed test-channel assets; formal v* releases retain their own immutable versioned ZIP and checksum.\n`);
console.log(`Prepared Autobuild for ${commit} (${version})`);
