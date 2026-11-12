import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fromLogValue } from '../../src/logging';
import { deadlineEvidence } from '../evaluation/deadline-evidence';
import { toolLifecycleEvidence } from '../evaluation/tool-lifecycle';
import { browserJobsSettled } from '../evaluation/job-evidence';
import { usageEvidence } from '../evaluation/model-proxy';
import { backgroundCleanupSucceeded } from './cleanup';
import { providerFailure } from './diagnosis';
import { verifyCart, type Cart, type Item } from './oracle';

type Scope = { conversationId: string; runId: string };
const scoped = (events: any[], scope: Scope) => events.filter(event => event.conversationId === scope.conversationId && event.runId === scope.runId
  || event.runId === scope.runId && ['run.cleanup.finished', 'run.cleanup.failed', 'browser.input.cleanup.failed'].includes(event.type)
  || event.type === 'artifact.part' && event.artifactPart?.owner === scope.conversationId);
async function bounded<T>(action: () => Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Observation timed out')), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Collect one actual phase, preserving the first decision independently of later observations. */
export async function collectCartStage(options: {
  root: string; phase: string; prompt: string; timeout: number; wanted: Item[]; currency: string; limit: number;
  products: { variantId: string; price: number }[]; phases: any[];
  start: () => Promise<void>; setScope: (scope: Scope | undefined) => void; read: () => Promise<any[]>;
  requests: () => { responseStatus: number | null }[]; lease: () => Promise<boolean>;
  cart: () => Promise<Cart>; page: () => Promise<{ verified: boolean }>; stock: (actual: Cart) => Promise<{ available: boolean | null }[]>;
}) {
  const { root, phase, prompt, timeout, wanted, currency, limit, products } = options;
  const start = Date.now(), end = start + timeout, offset = options.requests().length;
  let all: any[] = [], scope: Scope | undefined;
  const errors: string[] = [];
  const observe = async <T>(name: string, action: () => Promise<T>, ms = 35000): Promise<T | undefined> => {
    try { return await bounded(action, ms); } catch { errors.push(name); return undefined; }
  };
  options.setScope(undefined);
  const result: any = { prompt, startedAt: new Date(start).toISOString(), started: true, observationErrors: errors };
  options.phases.push(result);
  const started = await observe('start', async () => { await options.start(); return true; }, 5000);
  if (started) while (Date.now() < end) {
    const next = await observe('poll', options.read, Math.max(1, Math.min(5000, end - Date.now())));
    if (!next || Date.now() > end) break;
    all = next;
    const submission = [...all].reverse().find(event => event.type === 'conversation.submitted' && Date.parse(event.timestamp) >= start);
    if (submission) { scope = { conversationId: submission.conversationId, runId: submission.runId }; options.setScope(scope); }
    if (scope && deadlineEvidence(scoped(all, scope), start, end).state !== 'pending') break;
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(1, Math.min(1000, end - Date.now()))));
  }
  const observed = scope ? scoped(all, scope) : all;
  const terminal = deadlineEvidence(observed, start, end);
  const requests = structuredClone(options.requests().slice(offset));
  const provider = providerFailure(requests);
  const runOutcome = terminal.state === 'pending' || terminal.state === 'late' ? (provider.unavailable ? 'blocked' : 'timed_out')
    : terminal.state === 'on_time' && terminal.terminal === 'conversation.finished' ? 'finished' : 'blocked';
  Object.assign(result, { scope, terminal, runOutcome, outcome: runOutcome === 'finished' ? 'failed' : runOutcome,
    elapsedMs: Date.now() - start, provider, modelRequests: requests, usage: usageEvidence(observed), initialEventsFile: `${phase}-events.json` });
  const initialSaved = await observe('initial_events_file', async () => { await writeFile(resolve(root, result.initialEventsFile), JSON.stringify(observed, null, 2), { flag: 'wx', mode: 0o600 }); return true; }, 5000);
  if (!initialSaved) result.initialEventsFile = null;
  result.observationFile = `${phase}-observation.json`;
  await observe('observation_file', async () => { await writeFile(resolve(root, result.observationFile), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); return true; }, 5000);
  const lease = terminal.state === 'on_time' ? await observe('lease', options.lease, 16000) : false;
  const latest = await observe('events', options.read, 5000);
  let events = latest ? (scope ? scoped(latest, scope) : latest) : observed;
  if (latest) {
    const file = `${phase}-final-events.json`;
    const saved = await observe('final_events_file', async () => { await writeFile(resolve(root, file), JSON.stringify(events, null, 2), { flag: 'wx', mode: 0o600 }); return true; }, 5000);
    if (!saved) events = observed;
    result.decisionEventsFile = saved ? file : result.initialEventsFile;
  } else result.decisionEventsFile = result.initialEventsFile;
  const lifecycle = toolLifecycleEvidence(events), jobs = browserJobsSettled(events);
  const cleanupSucceeded = !!scope && backgroundCleanupSucceeded(events, scope.runId);
  const actual = await observe('cart', options.cart);
  const valid = !!actual && verifyCart(actual, wanted, currency, limit);
  const page = await observe('page', options.page);
  const priceChanged = !!actual && actual.items.some(item => products.some(product => product.variantId === item.variantId && product.price !== (item.originalPrice ?? item.price)));
  const stock = actual && !valid && terminal.state === 'on_time' ? await observe('stock', () => options.stock(actual)) : [];
  const finished = observed.filter(event => event.type === 'conversation.finished').at(-1);
  const goal = finished ? (fromLogValue(finished.content, finished.valueEncoding) as any)?.goal : undefined;
  const outcome = runOutcome !== 'finished' ? runOutcome : priceChanged || stock?.some(item => item.available === false) ? 'blocked'
    : goal?.status === 'completed' && valid && lifecycle.complete === true && jobs === true && cleanupSucceeded && lease === true && page?.verified && errors.length === 0 ? 'passed' : 'failed';
  Object.assign(result, { lifecycle, jobs, cleanupSucceeded, leaseReleased: lease ?? false, actual,
    actualHash: actual ? createHash('sha256').update(JSON.stringify(actual)).digest('hex') : undefined,
    valid, page, priceChanged, stock, goalStatus: goal?.status, outcome });
  return result;
}
