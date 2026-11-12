import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { collectCartStage } from '../e2e/stateful-web/stage';

let root = '';
afterEach(async () => { vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'stateful-stage-'));
  const now = Date.now();
  const submitted = { type: 'conversation.submitted', conversationId: 'c', runId: 'r', timestamp: new Date(now).toISOString() };
  const finished = { ...submitted, type: 'conversation.finished', content: { goal: { status: 'completed' } } };
  const requests = [{ responseStatus: 200 }];
  const phases: any[] = [];
  const options = { root, phase: 'stage1', prompt: 'test', timeout: 1000, wanted: [], currency: 'GBP', limit: 0, products: [], phases,
    start: vi.fn(async () => { requests.push({ responseStatus: 401 }); }), setScope: vi.fn(),
    read: vi.fn(async () => [submitted, finished]), requests: () => requests,
    lease: vi.fn(async () => true), cart: vi.fn(async () => ({ currency: 'GBP', subtotal: 0, items: [] })),
    page: vi.fn(async () => ({ verified: true })), stock: vi.fn(async () => []) };
  return { options, phases, submitted, finished };
}
const file = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8'));

it.each(['reject', 'timeout'])('preserves first terminal and requests when lease %s', async mode => {
  vi.useFakeTimers();
  const { options, finished } = await fixture();
  let entered = false;
  options.lease = vi.fn(() => { entered = true; return mode === 'reject' ? Promise.reject(new Error('offline')) : new Promise<boolean>(() => {}); });
  const run = collectCartStage(options);
  for (let i = 0; i < 100 && !entered; i++) await immediate();
  expect(entered).toBe(true);
  expect(await file('stage1-events.json')).toContainEqual(finished);
  expect(await file('stage1-observation.json')).toMatchObject({ terminal: { state: 'on_time' }, modelRequests: [{ responseStatus: 401 }] });
  if (mode === 'timeout') await vi.advanceTimersByTimeAsync(16000);
  const result = await run;
  expect(result).toMatchObject({ terminal: { state: 'on_time' }, runOutcome: 'finished', outcome: 'failed', observationErrors: ['lease'], modelRequests: [{ responseStatus: 401 }], decisionEventsFile: 'stage1-final-events.json' });
  expect(await file(result.decisionEventsFile)).toContainEqual(finished);
});

it('retains original evidence when cart and page fail after raw capture', async () => {
  const { options, finished } = await fixture();
  options.cart = vi.fn(async () => { throw Error('cart'); });
  options.page = vi.fn(async () => { throw Error('page'); });
  const result = await collectCartStage(options);
  expect(result).toMatchObject({ runOutcome: 'finished', outcome: 'failed', observationErrors: ['cart', 'page'], modelRequests: [{ responseStatus: 401 }] });
  expect(await file('stage1-events.json')).toContainEqual(finished);
  expect(await file(result.decisionEventsFile)).toContainEqual(finished);
});

it('retains first observation on final read failure', async () => {
  const { options, finished } = await fixture();
  options.read.mockResolvedValueOnce([...(await options.read())]).mockRejectedValueOnce(new Error('final'));
  const result = await collectCartStage(options);
  expect(result).toMatchObject({ started: true, runOutcome: 'finished', observationErrors: ['events'], modelRequests: [{ responseStatus: 401 }], decisionEventsFile: 'stage1-events.json' });
  expect(await file('stage1-events.json')).toContainEqual(finished);
});

it('records a started phase and requests when the first poll fails', async () => {
  const { options } = await fixture();
  options.read.mockRejectedValueOnce(new Error('poll')).mockRejectedValueOnce(new Error('final'));
  const result = await collectCartStage(options);
  expect(result).toMatchObject({ started: true, runOutcome: 'blocked', observationErrors: ['poll', 'events'], modelRequests: [{ responseStatus: 401 }] });
  expect(await file('stage1-events.json')).toEqual([]);
});

it('keeps timeout when a terminal arrives after the deadline', async () => {
  vi.useFakeTimers();
  const { options, submitted, finished } = await fixture();
  options.start = vi.fn(async () => { await vi.advanceTimersByTimeAsync(1001); });
  options.read = vi.fn(async () => [submitted, finished]);
  const result = await collectCartStage(options);
  expect(result).toMatchObject({ terminal: { state: 'pending' }, runOutcome: 'timed_out', outcome: 'timed_out' });
  expect(await file('stage1-events.json')).toEqual([]);
  expect(await file('stage1-final-events.json')).toContainEqual(finished);
});

it('retains the last successful poll when the next poll fails', async () => {
  vi.useFakeTimers();
  const { options, submitted } = await fixture();
  options.timeout = 3000;
  options.read.mockResolvedValueOnce([submitted]).mockRejectedValueOnce(Error('poll')).mockRejectedValueOnce(Error('final'));
  const run = collectCartStage(options);
  await vi.advanceTimersByTimeAsync(1000);
  const result = await run;
  expect(result).toMatchObject({ terminal: { state: 'pending' }, observationErrors: ['poll', 'events'], modelRequests: [{ responseStatus: 401 }] });
  expect(await file('stage1-events.json')).toEqual([submitted]);
});

it('never clears the cart with unknown lease proof', async () => {
  const { cleanupCart } = await import('../e2e/stateful-web/cleanup');
  const post = vi.fn();
  const context = { request: { post }, pages: () => [] };
  const writes = { drain: async () => ({ active: 0, unknown: false }) };
  const proof = { started: true, acknowledged: true, leaseReleased: false, jobsSettled: true, cleanupSucceeded: true, harnessWritesSettled: true };
  const result = await cleanupCart(context as any, 'https://example.invalid', proof, writes as any);
  expect(result.status).toBe('unverified');
  expect(post).not.toHaveBeenCalled();
});
