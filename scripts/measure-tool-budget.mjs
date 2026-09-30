import { createServer } from 'vite';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const loader = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
const records = [];
try {
  const modules = [['current', '/src/chrome/tool.ts']];
  const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
  if (baseline) modules.unshift(['baseline', resolve(baseline)]);
  for (const [label, path] of modules) {
    const module = await loader.ssrLoadModule(path);
    const registry = module.TOOL_REGISTRY ?? Object.entries(module.createCommandTools({})).map(([name, tool]) => ({ name, ...tool }));
    const definitions = JSON.stringify(registry.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: z.toJSONSchema(inputSchema) })));
    const summary = module.TOOL_SUMMARY;
    const result = { label, count: registry.length, definitionsBytes: Buffer.byteLength(definitions), summaryBytes: Buffer.byteLength(summary) };
    const tokenized = spawnSync(process.env.SURFWAX_TOKENIZER_PYTHON ?? 'python3', ['-c', 'import json,sys,tiktoken; source=json.load(sys.stdin); print(json.dumps({name:{key:len(tiktoken.get_encoding(name).encode(value)) for key,value in source.items()} for name in ["cl100k_base","o200k_base"]}))'], { input: JSON.stringify({ definitions, summary }), encoding: 'utf8', env: process.env });
    if (tokenized.status === 0) result.tokens = JSON.parse(tokenized.stdout);
    else result.tokens = { unavailable: 'Install tiktoken 0.11.0 in an isolated Python environment to measure fixed BPE encodings; byte counts do not imply token savings.' };
    records.push(result);
  }
} finally { await loader.close(); }
const report = JSON.stringify({ method: 'UTF-8 JSON of ordered name, description, Zod JSON inputSchema; raw TOOL_SUMMARY. Fixed BPE token counts are not provider billing usage.', records }, null, 2) + '\n';
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9);
if (output) await writeFile(resolve(output), report);
console.log(report);
