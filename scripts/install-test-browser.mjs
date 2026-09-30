import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const channel = process.argv[2] ?? 'current';
if (!['current', '138'].includes(channel)) throw new Error('Choose current or 138');
const platform = process.platform === 'linux' ? 'linux64' : process.platform === 'darwin' ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64' : 'win64';
const source = channel === 'current' ? 'last-known-good-versions-with-downloads.json' : 'known-good-versions-with-downloads.json';
const response = await fetch(`https://googlechromelabs.github.io/chrome-for-testing/${source}`);
if (!response.ok) throw new Error(`Chrome for Testing catalog failed: ${response.status}`);
const catalog = await response.json();
const release = channel === 'current' ? catalog.channels.Stable : catalog.versions.filter(item => item.version.startsWith('138.')).at(-1);
const asset = release?.downloads.chrome.find(item => item.platform === platform);
if (!asset) throw new Error(`No Chrome ${channel} download for ${platform}`);
const directory = resolve('.dev/test-browsers', release.version);
const executable = resolve(directory, `chrome-${platform}`, process.platform === 'darwin' ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' : process.platform === 'win32' ? 'chrome.exe' : 'chrome');
try { await access(executable); } catch {
  await mkdir(directory, { recursive: true });
  const download = await fetch(asset.url);
  if (!download.ok) throw new Error(`Chrome download failed: ${download.status}`);
  const archive = resolve(directory, 'chrome.zip');
  await writeFile(archive, new Uint8Array(await download.arrayBuffer()));
  execFileSync('unzip', ['-q', '-o', archive, '-d', directory]);
}
console.log(executable);
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `executable=${executable}\nversion=${release.version}\n`, { flag: 'a' });
