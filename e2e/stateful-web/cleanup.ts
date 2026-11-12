import { fromLogValue, type LogEvent } from '../../src/logging';
import type { BrowserContext, Request } from '@playwright/test';

export type StopProof = {
  started: boolean;
  acknowledged: boolean;
  leaseReleased: boolean;
  jobsSettled: boolean | null;
  harnessWritesSettled: boolean;
  cleanupSucceeded: boolean;
};

/** Only the store's cart writes matter here; analytics never delay cleanup. */
export function trackCartWrites(context: BrowserContext, origin: string) {
  const active = new Set<Request>();
  const waiters = new Set<() => void>();
  let unknown = false;
  const wake = () => { for (const done of [...waiters]) done(); };
  const start = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === origin && !['HEAD', 'OPTIONS'].includes(request.method()) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart(?:\.js|\/.*)?\/?$/i.test(url.pathname) && (request.method() !== 'GET' || !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart(?:\.js)?\/?$/i.test(url.pathname))) active.add(request);
  };
  const finish = async (request: Request) => {
    if (!active.has(request)) return;
    try {
      const response = await request.response();
      let successfulRedirect = false;
      if (response && [301, 302, 303, 307, 308].includes(response.status())) {
        const location = response.headers()['location'];
        if (location) {
          const target = new URL(location, request.url());
          successfulRedirect = target.origin === origin && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i.test(target.pathname);
        }
      }
      if (!response?.ok() && !successfulRedirect) unknown = true;
    }
    catch { unknown = true; }
    finally { active.delete(request); wake(); }
  };
  const fail = (request: Request) => {
    if (!active.delete(request)) return;
    unknown = true;
    wake();
  };
  context.on('request', start);
  context.on('requestfinished', finish);
  context.on('requestfailed', fail);
  return {
    async drain(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (active.size && Date.now() < deadline) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
          waiters.add(done);
        });
      }
      return { active: active.size, unknown };
    },
    dispose() {
      context.off('request', start);
      context.off('requestfinished', finish);
      context.off('requestfailed', fail);
      wake();
    },
  };
}

/** The caller owns final context disposal even when stopping or clearing fails. */
export async function cleanupCart(context: BrowserContext, origin: string, proof: StopProof, writes: ReturnType<typeof trackCartWrites>) {
  const result = { status: 'unverified', proof, pagesClosed: 0, writes: await writes.drain(), clearStatus: null as number | null, verifyStatus: null as number | null, reason: '' };
  if (!proof.harnessWritesSettled || proof.started && (!proof.acknowledged || !proof.leaseReleased || !proof.cleanupSucceeded || proof.jobsSettled !== true)) {
    result.reason = 'Run shutdown or dispatched effects could not be verified';
    return result;
  }
  if (result.writes.active || result.writes.unknown) {
    result.reason = 'A cart write is still pending or has an unknown result';
    return result;
  }
  try {
    // Closing every page prevents both storefront timers and the side panel
    // from dispatching more work. APIRequestContext remains available.
    for (const page of context.pages()) { await page.close(); result.pagesClosed++; }
    result.writes = await writes.drain();
    if (result.writes.active || result.writes.unknown) {
      result.reason = 'A cart write did not settle while pages were closing';
      return result;
    }
    const cleared = await context.request.post(`${origin}/cart/clear.js`, { data: {}, timeout: 15_000 });
    result.clearStatus = cleared.status();
    if (!cleared.ok()) throw new Error('Cart clear request failed');
    const verified = await context.request.get(`${origin}/cart.js`, { timeout: 15_000 });
    result.verifyStatus = verified.status();
    if (!verified.ok()) throw new Error('Cart verification request failed');
    const cart = await verified.json();
    if (!Array.isArray(cart.items) || cart.items.length || cart.item_count !== 0 || cart.items_subtotal_price !== 0) throw new Error('Cart is not empty');
    result.status = 'verified_empty';
    return result;
  } catch {
    result.status = 'failed';
    result.reason = 'Cart cleanup could not be independently verified';
    return result;
  }
}

/** Background ownership is released only after this terminal has been committed. */
export function backgroundCleanupSucceeded(events: LogEvent[], runId: string): boolean {
  const owned = events.filter(event => event.runId === runId);
  if (owned.some(event => ['run.cleanup.failed', 'browser.input.cleanup.failed'].includes(event.type))) return false;
  const terminals = owned.filter(event => event.type === 'run.cleanup.finished');
  if (terminals.length !== 1) return false;
  try {
    const terminal = terminals[0];
    const output = fromLogValue(terminal.output, terminal.valueEncoding) as { ok?: unknown } | null;
    const content = fromLogValue(terminal.content, terminal.valueEncoding) as { failures?: unknown } | null;
    return output?.ok === true && content?.failures === 0;
  } catch { return false; }
}
