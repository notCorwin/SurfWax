import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';

import { verifyPublisherDeclarations } from './third-party-licenses.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function validateThirdParty(root, output, files) {
  const read = async path => {
    const full = resolve(output, path), rel = relative(output, full);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Invalid third-party output path: ${path}`);
    return readFile(full);
  };
  const report = JSON.parse(await read('third-party/manifest.json'));
  const lockBytes = await readFile(resolve(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  if (report.schemaVersion !== 1 || report.lockfileSha256 !== hash(lockBytes) || !report.packages?.length) throw new Error('Missing or stale third-party inventory; rebuild with locked dependencies');
  const checkHash = async item => {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || hash(await read(item.output)) !== item.sha256) throw new Error(`Third-party content hash mismatch: ${item.output}`);
  };
  for (const item of [...report.outputs, ...report.publicAssets]) await checkHash(item);
  const mappedOutputs = new Set(report.outputs.map(item => item.output));
  const supplements = JSON.parse(await readFile(resolve(root, 'scripts/licenses/sources.json')));
  for (const pkg of report.packages) {
    verifyPublisherDeclarations(root, pkg, lock.packages[pkg.packagePath], supplements);
    const expectedEvidence = supplements.filter(item => item.package === pkg.name && item.versions.includes(pkg.version));
    if (JSON.stringify(pkg.licenseEvidence) !== JSON.stringify(expectedEvidence)) throw new Error(`Stale third-party license provenance: ${pkg.name}; rebuild`);
    for (const supplement of expectedEvidence.filter(item => item.file)) {
      if (!pkg.documents.some(doc => doc.source === supplement.file && doc.sha256 === supplement.sha256 && doc.provenance === supplement.upstream)) throw new Error(`Missing supplemental license text: ${pkg.name}`);
    }
    if (lock.packages[pkg.packagePath]?.version !== pkg.version || lock.packages[pkg.packagePath]?.integrity !== pkg.integrity) throw new Error(`Third-party package differs from lockfile: ${pkg.packagePath}`);
    if (!pkg.modules.length && !pkg.resources.length) throw new Error(`Third-party package lacks distributed source mapping: ${pkg.name}`);
    if (!pkg.documents.length && !report.issues.length) throw new Error(`Missing legal text: ${pkg.name}`);
    for (const module of pkg.modules) {
      if (!module.source.startsWith(`${pkg.packagePath}/`) || !mappedOutputs.has(module.output)) throw new Error(`Invalid third-party module mapping: ${pkg.name}`);
    }
    for (const resource of pkg.resources) {
      if (!resource.source.startsWith(`${pkg.packagePath}/`)) throw new Error(`Invalid resource owner: ${resource.output}`);
      await checkHash(resource);
    }
    for (const source of pkg.noticeSources ?? []) {
      if (!source.source.startsWith(`${pkg.packagePath}/`) || hash(await readFile(resolve(root, source.source))) !== source.sha256) throw new Error(`Font notice source differs from locked build input: ${source.source}`);
    }
    for (const document of pkg.documents) {
      await checkHash(document);
      const text = (await read(document.output)).toString('utf8');
      if (!/copyright|permission|license|licence|reserved font name/i.test(text) || !text.trim()) throw new Error(`Incomplete legal text: ${document.output}`);
    }
    if (pkg.name === 'lucide-react') {
      const text = (await Promise.all(pkg.documents.map(async doc => (await read(doc.output)).toString('utf8')))).join('\n');
      if (!text.includes('Cole Bemis') || !text.includes('Lucide') || !text.includes('The MIT License')) throw new Error('Lucide/Feather original notices are incomplete');
    }
    if (pkg.name === 'katex' && pkg.resources.length) {
      const text = (await Promise.all(pkg.documents.map(async doc => (await read(doc.output)).toString('utf8')))).join('\n');
      if (!pkg.noticeSources?.length) throw new Error('KaTeX font notice source provenance is missing');
      if (!text.includes('Khan Academy') || !text.includes('Design Science') || !text.includes('Reserved Font Name') || !text.includes('SIL OPEN FONT LICENSE Version 1.1') || !text.includes('TERMINATION')) throw new Error('KaTeX font notices or full OFL text are missing');
    }
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    const item = report.publicAssets.find(item => item.source === `public/third-party/playwright/${name}`);
    if (!item || hash(await readFile(resolve(root, item.source))) !== item.sha256) throw new Error(`Playwright original ${name} differs from source`);
  }
  for (const path of files) {
    const name = relative(output, path).split(sep).join('/');
    if (/(?:^|\/)(?:\.DS_Store|\._[^/]*)$/.test(name)) throw new Error(`Finder metadata must not be distributed: ${name}`);
    if (/\.(?:woff2?|ttf|otf)$/.test(name) && !report.packages.some(pkg => pkg.resources.some(item => item.output === name))) throw new Error(`Unattributed distributed font: ${name}`);
  }
  if (report.issues.length) throw new Error(`Unresolved third-party materials; release blocked:\n${report.issues.join('\n')}`);
  return report;
}
