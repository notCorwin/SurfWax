import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const sorted = values => [...new Set(values)].sort();
// Legal document names may carry a license identifier or text extension, but
// never a source-code extension (e.g. Lucide's copyright.mjs icon).
const legalName = /^(?:licen[sc]e|copying|copyright|notice|ofl)(?:[-_][a-z0-9_-]+(?:\.\d+)*)?(?:\.(?:txt|md|markdown|rst))?$/i;
const metadataName = /^(?:\.DS_Store|\._.*)$/;
const json = value => `${JSON.stringify(value)}\n`;

// Opt-in binding for a publisher-declared license supplemented with official standard
// terms. Other missing licenses remain unresolved; SPDX is never expanded by guessing.
export function verifyPublisherDeclarations(root, pkg, locked, supplements) {
  for (const supplement of supplements.filter(item => item.package === pkg.name && item.publisherDeclaration)) {
    const declaration = supplement.publisherDeclaration;
    const read = path => readFileSync(resolve(root, path));
    const bytes = read(declaration.file);
    if (hash(bytes) !== declaration.sha256 || hash(read(supplement.file)) !== supplement.sha256) throw new Error(`Publisher license evidence hash mismatch: ${pkg.name}`);
    const published = JSON.parse(bytes);
    const installed = JSON.parse(read(`${pkg.packagePath}/package.json`));
    if (!supplement.versions.includes(pkg.version)
      || [pkg, installed, published].some(item => item.name !== supplement.package || item.version !== declaration.version || item.license !== declaration.license)
      || locked?.version !== declaration.version || locked?.license !== declaration.license
      || locked?.integrity !== declaration.integrity || locked?.resolved !== declaration.tarball
      || published.gitHead !== declaration.gitHead || published.dist?.integrity !== declaration.integrity || published.dist?.tarball !== declaration.tarball) {
      throw new Error(`Publisher license declaration differs from locked/installed release: ${pkg.name}; review license materials for the new package`);
    }
  }
}

export function thirdPartyLicenses() {
  let root;
  return {
    name: 'surf-wax-third-party-licenses',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { root = config.root; },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
        const packages = new Map();
        const issues = [];
        const supplements = JSON.parse(readFileSync(join(root, 'scripts/licenses/sources.json')));
        const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });
        const file = path => readFileSync(resolve(root, path));
        const owner = id => {
          const path = slash(id.replace(/^\0/, '').split('?')[0]);
          const marker = path.lastIndexOf('/node_modules/');
          if (marker < 0) return;
          const rest = path.slice(marker + 14).split('/');
          const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
          const directory = path.slice(0, marker + 14) + name;
          const key = slash(relative(root, directory));
          if (!packages.has(key)) {
            const metadata = JSON.parse(file(`${key}/package.json`));
            if (lock.packages[key]?.version !== metadata.version) throw new Error(`Third-party package does not match lockfile: ${key}`);
            packages.set(key, { name: metadata.name, version: metadata.version, packagePath: key, license: metadata.license ?? null,
              integrity: lock.packages[key].integrity ?? null, modules: [], resources: [], documents: [] });
          }
          return packages.get(key);
        };
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            for (const [id, module] of Object.entries(output.modules)) {
              if (module.renderedLength === 0) continue;
              const pkg = owner(id);
              if (pkg) pkg.modules.push({ source: slash(relative(root, id.replace(/^\0/, '').split('?')[0])), output: output.fileName });
              else if (id.includes('node_modules')) issues.push(`Cannot determine module owner: ${id}`);
            }
          } else {
            for (const original of output.originalFileNames ?? []) {
              const pkg = owner(resolve(root, original));
              if (pkg) pkg.resources.push({ source: slash(relative(root, resolve(root, original))), output: output.fileName, sha256: hash(output.source) });
            }
            if (/\.(?:woff2?|ttf|otf)$/.test(output.fileName) && !(output.originalFileNames?.length)) issues.push(`Font has no source mapping: ${output.fileName}`);
          }
        }
        // Vite may inline small fonts in CSS instead of emitting a separate asset.
        // Match their exact bytes, not their hashed output filename or package license field.
        for (const pkg of packages.values()) {
          const fontDirectories = sorted(pkg.resources.filter(item => /\.(woff2?|ttf|otf)$/.test(item.source)).map(item => item.source.slice(0, item.source.lastIndexOf('/'))));
          for (const directory of fontDirectories) for (const name of readdirSync(resolve(root, directory)).sort()) {
            const source = `${directory}/${name}`;
            if (!/\.(woff2?|ttf|otf)$/.test(name) || pkg.resources.some(item => item.source === source)) continue;
            const bytes = file(source);
            for (const asset of Object.values(bundle).filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))) {
              if (!Buffer.from(asset.source).toString('utf8').includes(`base64,${bytes.toString('base64')}`)) continue;
              pkg.resources.push({ source, output: asset.fileName, sha256: hash(asset.source), sourceSha256: hash(bytes), encoding: 'inline-base64' });
            }
          }
        }
        const documents = [];
        const addDocument = (pkg, source, bytes, provenance) => {
          if (!bytes.toString('utf8').trim()) { issues.push(`Empty legal document: ${source}`); return; }
          const output = `third-party/licenses/${hash(bytes)}.txt`;
          if (!documents.some(item => item.output === output)) { emit(output, bytes); documents.push({ output, sha256: hash(bytes) }); }
          pkg.documents.push({ source, output, sha256: hash(bytes), ...(provenance ? { provenance } : {}) });
        };
        for (const pkg of packages.values()) {
          const visit = path => {
            for (const entry of readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const child = `${path}/${entry.name}`;
              if (entry.isDirectory()) visit(child);
              else if (entry.isFile() && legalName.test(entry.name)) addDocument(pkg, child, file(child));
            }
          };
          visit(pkg.packagePath);
          verifyPublisherDeclarations(root, pkg, lock.packages[pkg.packagePath], supplements);
          pkg.licenseEvidence = supplements.filter(item => item.package === pkg.name && item.versions.includes(pkg.version));
          for (const supplement of pkg.licenseEvidence) {
            if (supplement.unresolved) issues.push(supplement.unresolved);
            if (!supplement.file) continue;
            const bytes = file(supplement.file);
            if (hash(bytes) !== supplement.sha256) throw new Error(`Vendored license hash mismatch: ${supplement.file}`);
            addDocument(pkg, supplement.file, bytes, supplement.upstream);
          }
          // This package ships its full MIT text in README rather than LICENSE.
          if (pkg.name === 'data-uri-to-buffer' && pkg.version === '4.0.1') addDocument(pkg, `${pkg.packagePath}/README.md`, file(`${pkg.packagePath}/README.md`));
          const hasFullLicense = pkg.documents.some(item =>
            /^(?:licen[sc]e|copying)(?:[.\-_]|$)/i.test(item.source.slice(pkg.packagePath.length + 1))
            || (item.provenance && /licen[sc]e/i.test(item.source))
            || (pkg.name === 'data-uri-to-buffer' && item.source.endsWith('/README.md')));
          if (!hasFullLicense) issues.push(`Missing full license text: ${pkg.name}@${pkg.version} (${pkg.packagePath}); license field alone is insufficient`);
          if (pkg.name === 'katex' && pkg.resources.some(item => /\.(woff2?|ttf)$/.test(item.source))) {
            // Preserve copyright, reserved names and license metadata from the actual TTFs.
            const names = new Set();
            pkg.noticeSources = [];
            const stems = sorted(pkg.resources.filter(item => /\.(woff2?|ttf)$/.test(item.source)).map(item => item.source.replace(/\.(woff2?|ttf)$/, '')));
            for (const stem of stems) {
              // TTF metadata is a build input, not a distributed fallback font.
              // Derive names from actual distributed faces, never a fixed list.
              const source = `${stem}.ttf`, bytes = file(source);
              pkg.noticeSources.push({ source, sha256: hash(bytes) });
              for (const text of fontNames(bytes)) names.add(text);
            }
            if (!names.size) issues.push('KaTeX fonts: no embedded copyright/license records found');
            addDocument(pkg, `${pkg.packagePath}/dist/fonts/*.ttf#name`, Buffer.from(sorted(names).join('\n\n') + '\n'));
          }
          pkg.modules.sort((a, b) => `${a.source}:${a.output}`.localeCompare(`${b.source}:${b.output}`, 'en'));
          pkg.resources.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
        }
        // Public assets are copied by Vite, outside Rollup's module graph. Keep an explicit,
        // small ownership boundary; new public files require a source decision.
        const publicAssets = [];
        const visitPublic = path => {
          for (const entry of readdirSync(resolve(root, 'public', path), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const source = path ? `${path}/${entry.name}` : entry.name;
            if (metadataName.test(entry.name)) throw new Error(`Finder metadata must not be distributed: public/${source}`);
            if (entry.isDirectory()) visitPublic(source);
            else {
              const ownership = /^icons\/icon-(16|32|48|128)\.png$/.test(source) ? 'Surf Wax project asset' : /^third-party\/playwright\/(LICENSE|NOTICE)$/.test(source) ? 'Playwright adapted keyboard commands in src/chrome/automation-utils.ts' : null;
              if (!ownership) issues.push(`Unknown public asset ownership: public/${source}`);
              publicAssets.push({ source: `public/${source}`, output: source, owner: ownership, sha256: hash(file(`public/${source}`)) });
            }
          }
        };
        visitPublic('');
        const report = { schemaVersion: 1, scope: 'Actual output modules, emitted package resources and copied public inputs. Original texts retained; not a legal compliance guarantee.',
          lockfileSha256: hash(file('package-lock.json')), packages: [...packages.values()].sort((a, b) => a.packagePath < b.packagePath ? -1 : 1),
          publicAssets, outputs: Object.values(bundle).filter(item => item.type === 'chunk').map(item => ({ output: item.fileName, sha256: hash(item.code) })).sort((a, b) => a.output < b.output ? -1 : 1), issues: sorted(issues) };
        emit('third-party/manifest.json', json(report));
        emit('third-party/README.txt', 'Third-party materials\n\nSee manifest.json for package versions, lockfile integrity, actual module/resource output mappings and legal text SHA-256 and provenance. Publisher-declared standard terms are explicitly identified in licenseEvidence; they are not claimed as upstream package files.\nPublic Playwright LICENSE and NOTICE are retained unchanged; keyboard mappings are adapted in src/chrome/automation-utils.ts.\nKaTeX font name-table notices and SIL OFL 1.1 are separate from the KaTeX code MIT license. Lucide LICENSE includes Feather-derived MIT text.\nThis inventory is build evidence, not legal advice or a legal compliance guarantee.\n' + (report.issues.length ? `\nUNRESOLVED (release validation fails):\n${report.issues.join('\n')}\n` : ''));
        if (report.issues.length) this.warn(`Third-party materials have unresolved issues; validate-build will reject release:\n${report.issues.join('\n')}`);
      },
    },
  };
}

// OpenType name records: Windows uses UTF-16BE; Macintosh records here are ASCII.
function fontNames(bytes) {
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const table = 12 + i * 16;
    if (bytes.toString('ascii', table, table + 4) !== 'name') continue;
    const base = bytes.readUInt32BE(table + 8), strings = base + bytes.readUInt16BE(base + 4);
    const result = [];
    for (let j = 0; j < bytes.readUInt16BE(base + 2); j++) {
      const record = base + 6 + j * 12;
      if (![0, 13, 14].includes(bytes.readUInt16BE(record + 6))) continue;
      const start = strings + bytes.readUInt16BE(record + 10);
      const value = Buffer.from(bytes.subarray(start, start + bytes.readUInt16BE(record + 8)));
      result.push(bytes.readUInt16BE(record) === 3 ? value.swap16().toString('utf16le') : value.toString('ascii'));
    }
    return result;
  }
  return [];
}
