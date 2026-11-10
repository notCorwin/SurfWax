import { createInterface } from 'node:readline';
import { createServer } from 'vite';
import { resolve } from 'node:path';

// Vite resolves the same TS source as the extension; it does not build or serve it.
const loader = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), server: { middlewareMode: true, watch: null }, appType: 'custom' });
let runtime;
try {
  const { connectToolRuntime, PROGRAM_TOOL_REGISTRY } = await loader.ssrLoadModule('/src/standalone/runtime.ts');
  if (process.argv.includes('--list')) {
    process.stdout.write(JSON.stringify(PROGRAM_TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema.toJSONSchema() }))) + '\n');
  } else {
    runtime = await connectToolRuntime(process.env.SURFWAX_CDP_URL ?? 'http://127.0.0.1:9222');
    process.stderr.write('Surf Wax tools ready. Send JSON lines: {"id":1,"name":"inspect_page","input":{}}\n');
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let request;
      try {
        request = JSON.parse(line);
        const result = await runtime.call(request.name, request.input ?? {});
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id, error: error.message }) + '\n'); }
    }
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
finally { await runtime?.close(); await loader.close(); }
