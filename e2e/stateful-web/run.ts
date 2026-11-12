import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { configure, openExtension, readEvents, dispose, closeServer } from '../fixtures';
import { modelProxy, usageEvidence } from '../evaluation/model-proxy';
import { deadlineEvidence } from '../evaluation/deadline-evidence';
import { toolLifecycleEvidence } from '../evaluation/tool-lifecycle';
import { browserJobsSettled } from '../evaluation/job-evidence';
import { sanitizeCart, verifyCart, sameCart, type Item } from './oracle';

const base = 'https://shop.pimoroni.com';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function runCart(timeout: number): Promise<string> {
  const root = resolve('.dev/verification/stateful-web', `${Date.now()}-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const report: any = { task: 'pimoroni-cart', startedAt: new Date().toISOString(), timeoutMs: timeout, phases: [], outcome: 'setup_failed', cleanup: 'not started' };
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined, proxy: Awaited<ReturnType<typeof modelProxy>> | undefined;
  let touched = false, phase = 'setup';
  try {
    const endpoint = process.env.SURFWAX_EVAL_BASE_URL, key = process.env.SURFWAX_EVAL_API_KEY, model = process.env.SURFWAX_EVAL_MODEL;
    if (!endpoint || !key || !model) throw Error('Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY and SURFWAX_EVAL_MODEL');
    proxy = await modelProxy(endpoint, key);
    opened = await openExtension(undefined, { viewport: null });
    const settings = await configure(opened.context, opened.page, proxy.baseURL, 256000, { goalMode: true });
    await settings.getByLabel('Model ID', { exact: true }).fill(model);
    await settings.getByLabel('API Key', { exact: true }).fill(proxy.token);
    await settings.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => settings.evaluate(async ({ model, token }) => { const s = (await chrome.storage.local.get('side-agent:model-config'))['side-agent:model-config'] as any; return s?.profiles?.custom?.model === model && s?.profiles?.custom?.providerSettings?.apiKey === token; }, { model, token: proxy!.token })).toBe(true);
    await settings.close();
    const ctx = opened.context;
    const request = async (path: string, data?: unknown) => { const response = data === undefined ? await ctx.request.get(base + path, { timeout: 30000 }) : await ctx.request.post(base + path, { data, timeout: 30000 }); if (!response.ok()) throw Error('Website request failed'); return response.json(); };
    phase = 'preflight';
    const catalog = await request('/products.json?limit=250');
    const candidates = catalog.products.flatMap((p: any) => p.variants.filter((v: any) => v.available && Number(v.price) > 0).map((v: any) => ({ variantId: String(v.id), name: p.title, variant: v.title, price: Math.round(Number(v.price) * 100), url: `${base}/products/${p.handle}` })));
    const selected: typeof candidates = []; const names = new Set<string>();
    for (const item of candidates) if (!names.has(item.name)) { selected.push(item); names.add(item.name); if (selected.length === 3) break; }
    if (selected.length !== 3) throw Error('Insufficient available products');
    const [a, b, c] = selected;
    const initial = sanitizeCart(await request('/cart.js'));
    if (initial.items.length) throw Error('Fresh cart is not empty');
    report.catalog = { fetchedAt: new Date().toISOString(), hash: hash(catalog), products: selected, currency: initial.currency };
    const expected = (entries: [any, number][]): Item[] => entries.map(([p, quantity]) => ({ variantId: p.variantId, price: p.price, quantity }));
    const first = expected([[a, 1], [b, 1]]), second = expected([[a, 1], [b, 2], [c, 1]]);
    const budget1 = first.reduce((n, i) => n + i.price * i.quantity, 0), budget2 = second.reduce((n, i) => n + i.price * i.quantity, 0);
    touched = true;
    await request('/cart/add.js', { items: [{ id: a.variantId, quantity: 1 }, { id: b.variantId, quantity: 2 }] });
    const prepared = sanitizeCart(await request('/cart.js'));
    if (!verifyCart(prepared, expected([[a, 1], [b, 2]]), initial.currency, a.price + 2 * b.price)) throw Error('Initial cart or current prices differ from catalog');
    const target = await ctx.newPage();
    if (!(await target.goto(base + '/cart', { waitUntil: 'load', timeout: 45000 }))?.ok()) throw Error('Cart page unavailable');
    await target.bringToFront();
    const label = (p: any) => `${p.name} (${p.variant}), ${p.url}`;
    const run = async (prompt: string, wanted: Item[], budget: number) => {
      const start = Date.now(), end = start + timeout;
      await opened!.page.getByTestId('composer-input').fill(prompt);
      await opened!.page.getByTestId('composer-input').press('Enter');
      let events: any[] = [];
      while (Date.now() < end) { events = await readEvents(opened!.page); if (deadlineEvidence(events, start, end).state !== 'pending') break; await new Promise(r => setTimeout(r, 1000)); }
      events = await readEvents(opened!.page);
      const terminal = deadlineEvidence(events, start, end), lifecycle = toolLifecycleEvidence(events), jobs = browserJobsSettled(events);
      const actual = sanitizeCart(await request('/cart.js'));
      const valid = verifyCart(actual, wanted, initial.currency, budget);
      const pageAtCart = ctx.pages().some(p => { try { const u = new URL(p.url()); return u.origin === base && u.pathname.replace(/\/$/, '') === '/cart'; } catch { return false; } });
      const outcome = terminal.state === 'pending' || terminal.state === 'late' ? 'timed_out' : terminal.state !== 'on_time' || terminal.terminal !== 'conversation.finished' ? 'blocked' : valid && lifecycle.complete === true && jobs === true && pageAtCart ? 'passed' : 'failed';
      const goalReviews = events.filter(e => e.type === 'agent.goal.review.finished').length;
      const result = { goalReviews, prompt, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start, terminal, lifecycle, jobs, actual, actualHash: hash(actual), valid, pageAtCart, outcome, usage: usageEvidence(events), modelRequests: structuredClone(proxy!.requests) };
      report.phases.push(result); return result;
    };
    phase = 'stage1';
    const one = await run(`Please keep one ${label(a)} in my cart. I accidentally added too many ${label(b)}; change that to one. Keep the merchandise subtotal at or below ${initial.currency} ${(budget1 / 100).toFixed(2)} and leave the cart open when done.`, first, budget1);
    report.outcome = one.outcome;
    if (one.outcome === 'passed') {
      phase = 'recovery';
      for (const p of ctx.pages()) if (p !== opened.page && p.url().startsWith(base)) await p.close();
      const reopened = await ctx.newPage();
      if (!(await reopened.goto(base + '/cart', { waitUntil: 'load', timeout: 45000 }))?.ok()) throw Error('Cart page unavailable during recovery');
      await reopened.bringToFront();
      const recovered = sanitizeCart(await request('/cart.js'));
      report.recovery = { beforeHash: one.actualHash, afterHash: hash(recovered), actual: recovered, consistent: sameCart(one.actual, recovered) };
      if (!report.recovery.consistent) { report.outcome = 'failed'; }
      else {
        phase = 'stage2';
        const two = await run(`Change of plans: keep one ${label(a)}, adjust ${label(b)} to two, and add one ${label(c)}. Keep the merchandise subtotal at or below ${initial.currency} ${(budget2 / 100).toFixed(2)} and leave the cart open.`, second, budget2);
        report.outcome = two.outcome;
      }
    }
  } catch { report.outcome = phase === 'preflight' || phase === 'recovery' ? 'blocked' : 'setup_failed'; report.reason = `Evaluation could not complete during ${phase}`; }
  finally {
    if (opened && touched) {
      try { const clear = await opened.context.request.post(base + '/cart/clear.js', { data: {}, timeout: 30000 }); const check = await opened.context.request.get(base + '/cart.js', { timeout: 30000 }); const cart = sanitizeCart(await check.json()); if (!clear.ok() || !check.ok() || cart.items.length || cart.subtotal !== 0) throw Error(); report.cleanup = 'verified empty'; }
      catch { report.cleanup = 'failed'; report.outcome = 'cleanup_failed'; }
    } else report.cleanup = 'no write attempted';
    try { if (opened) { await dispose(opened.context, opened.userDataDirectory); await rm(opened.userDataDirectory, { recursive: true, force: true }); } report.profileCleanup = 'completed'; } catch { report.profileCleanup = 'failed'; report.outcome = 'cleanup_failed'; }
    if (proxy) await closeServer(proxy.server).catch(() => { report.outcome = 'cleanup_failed'; });
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ outcome: report.outcome, report: resolve(root, 'report.json') }));
  }
  return report.outcome;
}
