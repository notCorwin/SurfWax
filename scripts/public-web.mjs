import { spawn } from 'node:child_process';
import { runBrowserTests } from './run-browser-tests.mjs';
const [command, id, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !['list', 'preflight', 'run'].includes(command)) throw new Error('Usage: npm run eval:public-web -- list | preflight [task-id] | run <task-id>');
  if (command === 'run') {
    if (!id) throw new Error('Provide a task id; use list to see available tasks');
    await runBrowserTests('e2e', { args: ['e2e/public-web-evaluation.spec.ts'], env: { ...process.env, SURFWAX_PUBLIC_WEB_EVAL: '1', SURFWAX_PUBLIC_WEB_TASK: id } });
  } else {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'e2e/public-web/cli.ts', command, ...(id ? [id] : [])], { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Public website evaluation failed'); process.exitCode = 1; }
