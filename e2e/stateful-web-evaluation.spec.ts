import { test, expect } from './fixtures';
import { runCart } from './stateful-web/run';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('Pimoroni two-stage cart', async () => {
  test.skip(process.env.SURFWAX_STATEFUL_WEB_EVAL !== '1', 'Explicit opt-in required');
  const timeout = Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3600000) throw Error('Invalid per-stage timeout');
  test.setTimeout(timeout * 2 + 240000);
  expect(await runCart(timeout)).toBe('passed');
});
