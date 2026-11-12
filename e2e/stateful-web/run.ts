import { fromLogValue } from '../../src/logging';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { fitWindowToScreen } from '../../scripts/development-extension.mjs';
import { configure, openExtension, readEvents, dispose, closeServer } from '../fixtures';
import { modelProxy, usageEvidence } from '../evaluation/model-proxy';
import { buildFingerprint, fileFingerprint } from '../evaluation/build-fingerprint';
import { deadlineEvidence } from '../evaluation/deadline-evidence';
import { toolLifecycleEvidence } from '../evaluation/tool-lifecycle';
import { browserJobsSettled } from '../evaluation/job-evidence';
import { sanitizeCart, verifyCart, sameCart, type Item } from './oracle';
import { providerFailure, missingStock } from './diagnosis';
import { cleanupCart, trackCartWrites, backgroundCleanupSucceeded, type StopProof } from './cleanup';

type Opened = Awaited<ReturnType<typeof openExtension>>;
type Scope = { conversationId: string; runId: string };
type Product = { variantId: string; name: string; variant: string; price: number; url: string };
const base = 'https://shop.pimoroni.com';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scoped = (events: any[], scope: Scope) => events.filter(event => event.conversationId === scope.conversationId && event.runId === scope.runId
  || event.runId === scope.runId && ['run.cleanup.finished', 'run.cleanup.failed', 'browser.input.cleanup.failed'].includes(event.type)
  || event.type === 'artifact.part' && event.artifactPart?.owner === scope.conversationId);

async function bounded<T>(operation: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Evaluation observation timed out')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function leaseReleased(page: Page): Promise<boolean> {
  const reply = await bounded(page.evaluate(() => chrome.runtime.sendMessage({ type: 'surf-wax:run-status' })));
  if (!reply || typeof reply !== 'object' || reply.error) throw new Error('Run coordinator unavailable');
  return !reply.identity;
}

/** The terminal is recorded before executor teardown; the background lease is released afterwards. */
async function stopAgent(opened: Opened, scope: Scope | undefined, started: boolean, harnessWritesSettled: boolean) {
  const proof: StopProof = { started, acknowledged: !started, leaseReleased: !started, jobsSettled: started ? null : true, cleanupSucceeded: !started, harnessWritesSettled };
  let events: any[] = [];
  if (!started) return { proof, events };
  if (!scope) return { proof, events };
  try {
    const stop = opened.page.getByRole('button', { name: '停止生成', exact: true });
    if (await stop.isVisible()) await stop.click({ timeout: 5000 });
    await expect.poll(async () => {
      proof.leaseReleased = await leaseReleased(opened.page);
      events = scoped(await bounded(readEvents(opened.page)), scope);
      proof.acknowledged = events.some(event => ['conversation.finished', 'conversation.failed', 'conversation.aborted'].includes(event.type));
      proof.cleanupSucceeded = backgroundCleanupSucceeded(events, scope.runId);
      proof.jobsSettled = browserJobsSettled(events);
      return proof.acknowledged && proof.leaseReleased && proof.cleanupSucceeded && proof.jobsSettled === true;
    }, { timeout: 20_000, intervals: [500] }).toBe(true);
  } catch { /* Missing shutdown evidence prevents business cleanup; final context disposal is still mandatory. */ }
  return { proof, events };
}

/** Verify the actual active tab, rather than an old cart tab left open by setup. */
async function finalCartPage(opened: Opened, products: Product[], wanted: Item[]) {
  const selection = await bounded(opened.page.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const target = (await chrome.debugger.getTargets()).find(target => target.tabId === tab?.id);
    return { tabId: tab?.id, url: tab?.url, targetId: target?.id };
  }));
  if (!selection.url || !selection.targetId) return { verified: false, selection };
  const url = new URL(selection.url);
  if (url.origin !== base || url.pathname.replace(/\/$/, '') !== '/cart') return { verified: false, selection };
  for (const page of opened.context.pages()) {
    const session = await opened.context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      if (targetInfo.targetId !== selection.targetId) continue;
      const rows = await page.locator('input[type=number]:visible').evaluateAll((elements, products) => elements.map(element => {
        const input = element as HTMLInputElement;
        for (let row = input.parentElement; row && row !== document.body; row = row.parentElement) {
          const visible = [...row.querySelectorAll('input[type=number]')].filter(node => node.getClientRects().length > 0);
          if (visible.length !== 1) break;
          const links = [...row.querySelectorAll<HTMLAnchorElement>('a[href]')];
          const matches = products.filter(product => links.some(link => {
            const url = new URL(link.href), expected = new URL(product.url);
            return url.origin === expected.origin && url.pathname === expected.pathname
              && (!url.searchParams.has('variant') || url.searchParams.get('variant') === product.variantId);
          }));
          if (matches.length === 1) return { variantId: matches[0].variantId, quantity: Number(input.value) };
        }
        return { variantId: null, quantity: Number(input.value) };
      }), products);
      return { verified: rows.length === wanted.length && wanted.every(item => rows.filter(row => row.variantId === item.variantId && row.quantity === item.quantity).length === 1), selection, rows };
    } finally { await session.detach(); }
  }
  return { verified: false, selection };
}

class WebsiteError extends Error {
  constructor(readonly operation: string, readonly status: number | null) { super(`Website ${operation} could not be verified${status === null ? '' : ` (HTTP ${status})`}`); }
}

export async function runCart(timeout: number): Promise<string> {
  const root = resolve('.dev/verification/stateful-web', `${Date.now()}-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const report: any = { task: 'pimoroni-cart', startedAt: new Date().toISOString(), timeoutMs: timeout, phases: [], outcome: 'setup_failed' };
  let opened: Opened | undefined, proxy: Awaited<ReturnType<typeof modelProxy>> | undefined;
  let writes: ReturnType<typeof trackCartWrites> | undefined;
  let touched = false, agentStarted = false, harnessWritesSettled = true, phase = 'setup';
  let scope: Scope | undefined;
  const evaluationFiles = ['e2e/stateful-web/run.ts', 'e2e/stateful-web/cleanup.ts', 'e2e/stateful-web/oracle.ts', 'e2e/stateful-web/diagnosis.ts', 'e2e/fixtures.ts', 'e2e/evaluation/job-evidence.ts'];
  report.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.gitDirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  report.evaluationSource = await Promise.all(evaluationFiles.map(path => fileFingerprint(resolve(path))));
  try {
    const endpoint = process.env.SURFWAX_EVAL_BASE_URL, key = process.env.SURFWAX_EVAL_API_KEY, model = process.env.SURFWAX_EVAL_MODEL;
    if (!endpoint || !key || !model) throw new Error('Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY and SURFWAX_EVAL_MODEL');
    proxy = await modelProxy(endpoint, key);
    report.extensionBuild = await buildFingerprint(resolve(process.env.SURFWAX_EXTENSION_PATH ?? 'dist'));
    opened = await openExtension(undefined, { viewport: null });
    await fitWindowToScreen(opened.context, opened.page);
    writes = trackCartWrites(opened.context, base);
    report.model = model;
    report.browser = opened.context.browser()?.version();
    const settings = await configure(opened.context, opened.page, proxy.baseURL, 256000, { goalMode: true });
    await settings.getByLabel('Model ID', { exact: true }).fill(model);
    await settings.getByLabel('API Key', { exact: true }).fill(proxy.token);
    await settings.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => settings.evaluate(async ({ model, token }) => {
      const saved = (await chrome.storage.local.get('side-agent:model-config'))['side-agent:model-config'] as any;
      return saved?.profiles?.custom?.model === model && saved?.profiles?.custom?.providerSettings?.apiKey === token;
    }, { model, token: proxy!.token })).toBe(true);
    await settings.close();
    const ctx = opened.context;
    const request = async (path: string, data?: unknown) => {
      try {
        const response = data === undefined ? await ctx.request.get(base + path, { timeout: 30000 }) : await ctx.request.post(base + path, { data, timeout: 30000 });
        if (!response.ok()) throw new WebsiteError(path, response.status());
        return await response.json();
      } catch (error) {
        if (data !== undefined) harnessWritesSettled = false;
        throw error instanceof WebsiteError ? error : new WebsiteError(path, null);
      }
    };
    phase = 'preflight';
    const catalog = await request('/products.json?limit=250');
    if (!Array.isArray(catalog.products)) throw new WebsiteError('catalog data', null);
    const selected: Product[] = [];
    for (const product of catalog.products) {
      const variant = product.variants?.find((variant: any) => variant.available && Number(variant.price) > 0);
      if (!variant || selected.some(item => item.name === product.title)) continue;
      const price = Math.round(Number(variant.price) * 100);
      if (!Number.isSafeInteger(price)) continue;
      selected.push({ variantId: String(variant.id), name: product.title, variant: variant.title, price, url: `${base}/products/${product.handle}` });
      if (selected.length === 3) break;
    }
    if (selected.length !== 3) throw new WebsiteError('available product selection', null);
    const [a, b, c] = selected;
    const initial = sanitizeCart(await request('/cart.js'));
    if (initial.items.length) throw new Error('Fresh isolated cart is not empty');
    report.catalog = { fetchedAt: new Date().toISOString(), hash: hash(catalog), products: selected, currency: initial.currency };
    const expected = (entries: [Product, number][]): Item[] => entries.map(([product, quantity]) => ({ variantId: product.variantId, price: product.price, quantity }));
    const first = expected([[a, 1], [b, 1]]), second = expected([[a, 1], [b, 2], [c, 1]]);
    const budget = (items: Item[]) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    touched = true;
    await request('/cart/add.js', { items: [{ id: a.variantId, quantity: 1 }, { id: b.variantId, quantity: 2 }] });
    const prepared = sanitizeCart(await request('/cart.js'));
    const seed = expected([[a, 1], [b, 2]]);
    if (!verifyCart(prepared, seed, initial.currency, budget(seed))) throw new WebsiteError('initial stock or price', null);
    report.initialCart = prepared;
    const target = await ctx.newPage();
    if (!(await target.goto(base + '/cart', { waitUntil: 'load', timeout: 45000 }))?.ok()) throw new WebsiteError('cart page', null);
    await target.bringToFront();
    const label = (product: Product) => `${product.name}（${product.variant}），${product.url}`;
    const run = async (prompt: string, wanted: Item[], limit: number) => {
      const start = Date.now(), end = start + timeout, requestOffset = proxy!.requests.length;
      await opened!.page.getByTestId('composer-input').fill(prompt);
      agentStarted = true;
      scope = undefined;
      await opened!.page.getByTestId('composer-input').press('Enter');
      let all: any[] = [], progressAt = 0;
      while (Date.now() < end) {
        all = await bounded(readEvents(opened!.page));
        const submission = [...all].reverse().find(event => event.type === 'conversation.submitted' && Date.parse(event.timestamp) >= start);
        if (submission) scope = { conversationId: submission.conversationId, runId: submission.runId };
        if (Date.now() - progressAt >= 30000) { console.log(JSON.stringify({ phase, elapsedMs: Date.now() - start, toolCalls: all.filter(event => event.type === 'tool.started' && event.runId === scope?.runId).length })); progressAt = Date.now(); }
        if (scope && deadlineEvidence(scoped(all, scope), start, end).state !== 'pending') break;
        await new Promise(resolveWait => setTimeout(resolveWait, Math.max(1, Math.min(1000, end - Date.now()))));
      }
      if (scope && deadlineEvidence(scoped(all, scope), start, end).state === 'on_time') {
        await expect.poll(() => leaseReleased(opened!.page), { timeout: 15000, intervals: [500] }).toBe(true);
      }
      all = await bounded(readEvents(opened!.page));
      const events = scope ? scoped(all, scope) : [];
      await writeFile(resolve(root, `${phase}-events.json`), JSON.stringify(events, null, 2), { flag: 'wx', mode: 0o600 });
      const terminal = deadlineEvidence(events, start, end), lifecycle = toolLifecycleEvidence(events), jobs = browserJobsSettled(events);
      const cleanupSucceeded = !!scope && backgroundCleanupSucceeded(events, scope.runId);
      const actual = sanitizeCart(await request('/cart.js'));
      const valid = verifyCart(actual, wanted, initial.currency, limit);
      const page = await finalCartPage(opened!, selected, wanted);
      const priceChanged = actual.items.some(item => selected.some(product => product.variantId === item.variantId && product.price !== (item.originalPrice ?? item.price)));
      const requests = structuredClone(proxy!.requests.slice(requestOffset));
      const provider = providerFailure(requests);
      const stock = !valid && terminal.state === 'on_time' ? await missingStock(ctx.request, wanted, actual, selected) : [];
      const soldOut = stock.some(item => item.available === false);
      const finished = events.filter(event => event.type === 'conversation.finished').at(-1);
      const goal = finished ? (fromLogValue(finished.content, finished.valueEncoding) as any)?.goal : undefined;
      const outcome = (terminal.state === 'pending' || terminal.state === 'late') && provider.unavailable ? 'blocked'
        : terminal.state === 'pending' || terminal.state === 'late' ? 'timed_out'
        : priceChanged || soldOut ? 'blocked' : terminal.state !== 'on_time' || terminal.terminal !== 'conversation.finished' ? 'blocked'
          : goal?.status === 'completed' && valid && lifecycle.complete === true && jobs === true && cleanupSucceeded && page.verified ? 'passed' : 'failed';
      const result = { scope, prompt, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start, terminal, lifecycle, jobs, cleanupSucceeded, actual,
        actualHash: hash(actual), valid, page, priceChanged, stock, provider, goalStatus: goal?.status, outcome, usage: usageEvidence(events), modelRequests: requests };
      report.phases.push(result);
      return result;
    };
    phase = 'stage1';
    const one = await run(`请保留购物车中原有的 ${label(a)} 一件。我多加了 ${label(b)}，请改成一件。商品小计不超过 ${initial.currency} ${(budget(first) / 100).toFixed(2)}。核对购物车页面的商品、数量及小计，完成后停留在购物车。`, first, budget(first));
    report.outcome = one.outcome;
    if (one.outcome === 'passed') {
      phase = 'recovery';
      for (const page of ctx.pages()) if (page !== opened.page && new URL(page.url()).origin === base) await page.close();
      const reopened = await ctx.newPage();
      if (!(await reopened.goto(base + '/cart', { waitUntil: 'load', timeout: 45000 }))?.ok()) throw new WebsiteError('cart recovery', null);
      await reopened.bringToFront();
      const recovered = sanitizeCart(await request('/cart.js'));
      report.recovery = { beforeHash: one.actualHash, afterHash: hash(recovered), actual: recovered, consistent: sameCart(one.actual, recovered) };
      if (!report.recovery.consistent) report.outcome = 'failed';
      else {
        phase = 'stage2';
        const two = await run(`需求有变：继续保留 ${label(a)} 一件，把 ${label(b)} 改为两件，再加入 ${label(c)} 一件。商品小计不超过 ${initial.currency} ${(budget(second) / 100).toFixed(2)}。确认页面上的商品、数量及小计后停留在购物车。`, second, budget(second));
        report.outcome = two.outcome;
      }
    }
  } catch (error) {
    report.outcome = error instanceof WebsiteError ? 'blocked' : 'setup_failed';
    report.reason = error instanceof WebsiteError ? error.message : `Evaluation observation failed during ${phase}`;
    report.phase = phase;
  } finally {
    report.taskOutcome = report.outcome;
    try {
      if (opened && touched && writes) {
        const stop = await stopAgent(opened, scope, agentStarted, harnessWritesSettled);
        await writeFile(resolve(root, 'final-events.json'), JSON.stringify(stop.events, null, 2), { flag: 'wx', mode: 0o600 });
        report.cleanup = await cleanupCart(opened.context, base, stop.proof, writes);
        if (report.cleanup.status !== 'verified_empty' && report.outcome === 'passed') report.outcome = 'cleanup_failed';
      } else report.cleanup = { status: 'not_needed' };
    } catch { report.cleanup = { status: 'failed', reason: 'Shutdown evidence or cleanup could not be recorded' }; if (report.outcome === 'passed') report.outcome = 'cleanup_failed'; }
    finally {
      writes?.dispose();
      try {
        if (opened) { await dispose(opened.context, opened.userDataDirectory); await rm(opened.userDataDirectory, { recursive: true, force: true }); }
        report.profileCleanup = 'completed';
      } catch { report.profileCleanup = 'failed'; if (report.outcome === 'passed') report.outcome = 'cleanup_failed'; }
      if (proxy) await closeServer(proxy.server).catch(() => { report.proxyCleanup = 'failed'; if (report.outcome === 'passed') report.outcome = 'cleanup_failed'; });
    }
    const sourceAfter = await Promise.all(evaluationFiles.map(path => fileFingerprint(resolve(path)))).catch(() => null);
    const buildAfter = await buildFingerprint(resolve(process.env.SURFWAX_EXTENSION_PATH ?? 'dist')).catch(() => null);
    report.evaluationSourceStable = !!sourceAfter && JSON.stringify(sourceAfter) === JSON.stringify(report.evaluationSource);
    report.extensionBuildStable = !!buildAfter && buildAfter.sha256 === report.extensionBuild?.sha256;
    if (report.outcome === 'passed' && (!report.evaluationSourceStable || !report.extensionBuildStable)) { report.outcome = 'setup_failed'; report.reason = 'Evaluation source or extension build changed during the run'; }
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outcome: report.outcome, cleanup: report.cleanup?.status, report: resolve(root, 'report.json') }));
  }
  return report.outcome;
}
