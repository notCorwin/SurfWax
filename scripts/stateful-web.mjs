import { runBrowserTests } from './run-browser-tests.mjs';
if (process.argv.slice(2).join(' ') !== 'cart') throw Error('Usage: npm run eval:stateful-web -- cart');
await runBrowserTests('e2e', { args: ['e2e/stateful-web-evaluation.spec.ts'], env: { ...process.env, SURFWAX_STATEFUL_WEB_EVAL: '1' } });
