import { createServer } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { test, expect, closeServer } from './fixtures';
import { systemChromePath } from '../scripts/development-extension.mjs';
import { cleanupCart, trackCartWrites, type StopProof } from './stateful-web/cleanup';

// Local HTTP is the external storefront boundary; the cleanup and browser are real.
test('cart cleanup waits for completed writes, closes pages, clears and independently verifies', async () => {
  let release!: () => void;
  let started!: () => void;
  const writeStarted = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let quantity = 1, clearRequests = 0, pagesAtClear = -1;
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/en-gb/cart') { started(); await held; quantity = 2; response.end('{}'); }
    else if (request.url === '/cart/clear.js') { clearRequests++; pagesAtClear = context!.pages().length; quantity = 0; response.end('{}'); }
    else if (request.url === '/cart.js') response.end(JSON.stringify({ items: quantity ? [{}] : [], item_count: quantity, items_subtotal_price: quantity * 100 }));
    else { response.setHeader('content-type', 'text/html'); response.end('<title>Cart boundary</title>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: systemChromePath(), headless: true });
  context = await browser.newContext();
  const writes = trackCartWrites(context, origin);
  const proof: StopProof = { started: true, acknowledged: true, leaseReleased: true, jobsSettled: true, cleanupSucceeded: true, harnessWritesSettled: true };
  try {
    const page = await context.newPage();
    await page.goto(origin);
    const pending = page.evaluate(() => fetch('/en-gb/cart', { method: 'POST' }).then(response => response.json()));
    await writeStarted;
    const cleaned = cleanupCart(context, origin, proof, writes);
    expect(clearRequests).toBe(0);
    release();
    await pending;
    expect(await cleaned).toMatchObject({ status: 'verified_empty', pagesClosed: 1, writes: { active: 0, unknown: false }, clearStatus: 200, verifyStatus: 200 });
    expect(pagesAtClear).toBe(0);
    expect(quantity).toBe(0);
    expect(clearRequests).toBe(1);
  } finally { release(); writes.dispose(); await browser.close(); await closeServer(server); }
});

test('cart cleanup refuses unacknowledged stops and unknown effects but permits settled setup-only writes', async () => {
  let cleared = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/cart/update.js') { request.socket.destroy(); return; }
    if (request.url === '/cart/clear.js') { cleared++; response.end('{}'); }
    else response.end('{"items":[],"item_count":0,"items_subtotal_price":0}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath: systemChromePath(), headless: true });
  const context = await browser.newContext(), writes = trackCartWrites(context, origin);
  const proof: StopProof = { started: true, acknowledged: true, leaseReleased: true, jobsSettled: true, cleanupSucceeded: true, harnessWritesSettled: true };
  try {
    for (const unsafe of [{ acknowledged: false }, { leaseReleased: false }, { cleanupSucceeded: false }, { jobsSettled: null }, { jobsSettled: false }, { harnessWritesSettled: false }]) {
      expect(await cleanupCart(context, origin, { ...proof, ...unsafe }, writes)).toMatchObject({ status: 'unverified' });
      expect(cleared).toBe(0);
    }
    expect(await cleanupCart(context, origin, { ...proof, started: false, acknowledged: false, leaseReleased: false, jobsSettled: null }, writes)).toMatchObject({ status: 'verified_empty' });
    expect(cleared).toBe(1);
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => fetch('/cart/update.js', { method: 'POST' }).catch(() => null));
    expect(await cleanupCart(context, origin, proof, writes)).toMatchObject({ status: 'unverified', writes: { unknown: true } });
    expect(cleared).toBe(1);
  } finally { writes.dispose(); await browser.close(); await closeServer(server); }
});
