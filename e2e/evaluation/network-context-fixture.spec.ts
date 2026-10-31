import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { networkContextFixture, networkContextScore, type NetworkContextFixture } from "./network-context-fixture";

async function closeFixture(fixture: NetworkContextFixture) {
  for (const server of [fixture.privateServer, fixture.publicServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
async function readCodes(page: Page, request: APIRequestContext, fixture: NetworkContextFixture) {
  await page.goto(fixture.origin);
  const privateCode = await page.evaluate(async () => (await (await fetch('/private-code')).json()).code as string);
  const publicResponse = await request.get(`${fixture.publicOrigin}/public-code`);
  expect(publicResponse.headers()['access-control-allow-origin']).toBeUndefined();
  return { privateCode, publicCode: (await publicResponse.json()).code as string };
}

for (const seed of [17, 72]) test(`accepts authenticated private and independent public codes (seed ${seed})`, async ({ page, request }) => {
  const fixture = await networkContextFixture(seed);
  try {
    const codes = await readCodes(page, request, fixture);
    expect(await page.evaluate(() => document.cookie)).not.toContain('handoff=');
    expect(codes.privateCode).toMatch(/^[0-9a-f]{64}$/);
    expect(codes.publicCode).toMatch(/^[0-9a-f]{64}$/);
    expect(codes.privateCode).not.toBe(codes.publicCode);
    await page.getByLabel('Private code').fill(codes.privateCode);
    await page.getByLabel('Public code').fill(codes.publicCode);
    await page.getByRole('button', {name:'Submit codes'}).click();
    await expect(page.locator('#status')).toHaveText('Submitted');
    expect(networkContextScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});

test('rejects unauthenticated private reads and records failed attempts permanently', async ({ page, request }) => {
  const fixture = await networkContextFixture(17);
  try {
    expect((await request.get(`${fixture.origin}/private-code`)).status()).toBe(401);
    const codes = await readCodes(page, request, fixture);
    await page.getByLabel('Private code').fill(codes.privateCode);
    await page.getByLabel('Public code').fill(codes.publicCode);
    await page.getByRole('button', {name:'Submit codes'}).click();
    await expect(page.locator('#status')).toHaveText('Submitted');
    expect(fixture.evidence().privateReads).toEqual([{ authenticated:false }, { authenticated:true }]);
    expect(networkContextScore(fixture.evidence())).toBe(false);
  } finally { await closeFixture(fixture); }
});

test('page-origin cross-origin access is blocked without CORS and is still counted', async ({ page }) => {
  const fixture = await networkContextFixture(72);
  try {
    await page.goto(fixture.origin);
    const result = await page.evaluate(async (url) => {
      try { await fetch(url); return 'unexpected success'; } catch { return 'blocked'; }
    }, `${fixture.publicOrigin}/public-code`);
    expect(result).toBe('blocked');
    expect(fixture.evidence().publicReads).toHaveLength(1);
    expect(networkContextScore(fixture.evidence())).toBe(false);
  } finally { await closeFixture(fixture); }
});

test('an optional blocked CORS probe followed by a successful read is permitted', async ({ page, request }) => {
  const fixture = await networkContextFixture(17);
  try {
    await page.goto(fixture.origin);
    expect(await page.evaluate(async (url) => {
      try { await fetch(url); return false; } catch { return true; }
    }, `${fixture.publicOrigin}/public-code`)).toBe(true);
    const codes = await readCodes(page, request, fixture);
    expect((await request.post(`${fixture.origin}/submit`, {data:codes})).status()).toBe(201);
    expect(fixture.evidence().publicReads).toHaveLength(2);
    expect(fixture.evidence().publicReads[0]?.pageOrigin).toBe(true);
    expect(networkContextScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});

test('wrong or duplicate submissions remain failures even after a correct submission', async ({ page, request }) => {
  for (const mode of ['wrong', 'duplicate'] as const) {
    const fixture = await networkContextFixture(17);
    try {
      const codes = await readCodes(page, request, fixture);
      const first = mode === 'wrong' ? { ...codes, publicCode: 'wrong' } : codes;
      expect((await request.post(`${fixture.origin}/submit`, {data:first})).status()).toBe(mode === 'wrong' ? 400 : 201);
      expect((await request.post(`${fixture.origin}/submit`, {data:codes})).status()).toBe(400);
      expect(fixture.evidence().submissions).toHaveLength(2);
      expect(networkContextScore(fixture.evidence())).toBe(false);
    } finally { await closeFixture(fixture); }
  }
});

test('request counts and ledger do not prove the browser execution path', async ({ page, request }) => {
  const fixture = await networkContextFixture(72);
  try {
    const codes = await readCodes(page, request, fixture);
    expect((await request.post(`${fixture.origin}/submit`, {data:codes})).status()).toBe(201);
    expect(networkContextScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});
