import { expect, it, vi } from 'vitest';
vi.mock('../e2e/fixtures', () => ({}));
import { recordEvaluationFailure, WebsiteError } from '../e2e/stateful-web/run';

it.each([new WebsiteError('cart recovery', null), new Error('observation')])('records recovery failure after a passing first stage', error => {
  const first = { outcome: 'passed' };
  const report = { outcome: 'passed', phases: [first] };
  recordEvaluationFailure(report, error, 'recovery');
  expect(report).toMatchObject({ outcome: error instanceof WebsiteError ? 'blocked' : 'setup_failed', phase: 'recovery', phases: [first] });
  expect(first.outcome).toBe('passed');
});
