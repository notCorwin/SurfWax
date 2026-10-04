import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Public verification catalogs; curl also honors the host's system TLS setup. */
export async function publicJson(url) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }); }
  catch {
    const { stdout } = await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '10', '--max-time', '30', url],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  if (!response.ok) throw new Error(`Public catalog failed (${response.status}): ${url}`);
  return response.json();
}
