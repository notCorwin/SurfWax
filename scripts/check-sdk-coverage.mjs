import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { publicJson } from './public-json.mjs';

const catalog = await publicJson('https://models.dev/api.json');
const loader = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
let supported;
try { ({ MODEL_SDKS: supported } = await loader.ssrLoadModule('/src/types.ts')); }
finally { await loader.close(); }
const listed = [...new Set(Object.values(catalog).map(provider => provider.npm).filter(Boolean))].sort();
const missing = listed.filter(sdk => !supported.includes(sdk));
const report = { source: 'https://models.dev/api.json', fetchedAt: new Date().toISOString(), providers: Object.keys(catalog).length,
  catalogSdks: listed, supportedSdks: supported, missing };
await mkdir('.dev/verification', { recursive: true });
await writeFile('.dev/verification/sdk-coverage.json', JSON.stringify(report, null, 2));
if (missing.length) throw new Error(`Unsupported Models.dev SDKs: ${missing.join(', ')}`);
console.log(`Models.dev: ${listed.length} SDKs, ${report.providers} providers; coverage complete (${supported.length} registered).`);
