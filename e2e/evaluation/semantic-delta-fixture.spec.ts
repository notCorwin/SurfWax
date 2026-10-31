import { expect, test, type Page } from "@playwright/test";
import { semanticDeltaFixture, semanticDeltaInteractionScore, semanticDeltaScore, type SemanticDeltaFixture } from "./semantic-delta-fixture";

async function close(fixture: SemanticDeltaFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function processNext(page: Page, number: number) {
  const queue = page.frameLocator('iframe[title="Semantic queue"]');
  const next = queue.getByRole("button", { name: /^Next / });
  const box = await next.boundingBox(), viewport = page.viewportSize();
  expect(box).not.toBeNull(); expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  await next.click();
  await expect(queue.locator("#progress")).toHaveText(number === 12 ? "Queue complete" : `Completed ${number} of 12`);
}

for (const seed of [17, 72]) test(`processes the recycled and reordered semantic queue (seed ${seed})`, async ({ page }) => {
  const fixture = await semanticDeltaFixture(seed);
  try {
    await page.goto(fixture.origin);
    const queue = page.frameLocator('iframe[title="Semantic queue"]');
    await expect(queue.locator("#progress")).toHaveText("Completed 0 of 12");
    await expect(queue.locator("li")).toHaveCount(120);
    const frame = page.frames().find((item) => item.url().includes("/queue"));
    if (!frame) throw new Error("Queue frame missing");
    await frame.evaluate(() => {
      (window as any).initialRows = [...document.querySelectorAll('li')];
      (window as any).originalNext = document.querySelector('button[aria-label^="Next "]');
      (window as any).originalNextId = (window as any).originalNext.dataset.id;
    });
    const before = await queue.locator("li button").allTextContents();
    const labels = await queue.locator("li button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? ""));
    expect(labels.filter((name) => name.startsWith("Next "))).toHaveLength(1);
    expect(labels.some((name) => name.includes("海🌊") && name.length > 5000)).toBe(true);
    await processNext(page, 1);
    expect(await frame.evaluate(() => (window as any).originalNext.isConnected
      && (window as any).originalNext.dataset.id !== (window as any).originalNextId)).toBe(true);
    for (let index = 2; index <= 12; index++) await processNext(page, index);
    expect(await frame.evaluate(() => {
      const original = (window as any).initialRows as Element[], current: Element[] = [...document.querySelectorAll('li')];
      return original.length === 120 && current.length === 120 && original.every((row) => current.includes(row));
    })).toBe(true);
    expect(await queue.locator("li button").allTextContents()).not.toEqual(before);
    const evidence = fixture.evidence();
    expect(evidence.remainingIds).toHaveLength(120);
    expect(evidence.expectedIds.every((id) => !evidence.remainingIds.includes(id))).toBe(true);
    expect(evidence.remainingIds.filter((id) => id.startsWith("NEW-"))).toHaveLength(12);
    expect(semanticDeltaScore(evidence)).toBe(true);
    expect(semanticDeltaInteractionScore(evidence)).toBe(true);
  } finally { await close(fixture); }
});

test("a waiting item or stale retry remains in the external ledger", async ({ page }) => {
  const fixture = await semanticDeltaFixture(17);
  try {
    await page.goto(fixture.origin);
    const queue = page.frameLocator('iframe[title="Semantic queue"]');
    await expect(queue.locator("#progress")).toHaveText("Completed 0 of 12");
    await queue.getByRole("button", { name: /^Waiting / }).first().click();
    await expect(queue.locator("#notice")).toContainText("Rejected");
    await processNext(page, 1);
    const first = fixture.evidence().attempts[1]!;
    expect((await page.request.post(`${fixture.origin}/process`, { data: { id: first.id, revision: first.revision, trusted: true } })).status()).toBe(409);
    for (let index = 2; index <= 12; index++) await processNext(page, index);
    expect(fixture.evidence().attempts).toHaveLength(14);
    expect(semanticDeltaScore(fixture.evidence())).toBe(false);
    expect(semanticDeltaInteractionScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("synthetic interaction is distinct from a correct business result", async ({ page }) => {
  const fixture = await semanticDeltaFixture(72);
  try {
    await page.goto(fixture.origin);
    const queue = page.frameLocator('iframe[title="Semantic queue"]');
    await expect(queue.locator("#progress")).toHaveText("Completed 0 of 12");
    await queue.getByRole("button", { name: /^Next / }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(queue.locator("#progress")).toHaveText("Completed 1 of 12");
    for (let index = 2; index <= 12; index++) await processNext(page, index);
    expect(semanticDeltaScore(fixture.evidence())).toBe(true);
    expect(semanticDeltaInteractionScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("direct HTTP can forge the page's trust signal and is not anti-cheat evidence", async ({ request }) => {
  const fixture = await semanticDeltaFixture(17);
  try {
    for (const [revision, id] of fixture.evidence().expectedIds.entries()) {
      expect((await request.post(`${fixture.origin}/process`, { data: { id, revision, trusted: true } })).status()).toBe(200);
    }
    expect(semanticDeltaScore(fixture.evidence())).toBe(true);
    expect(semanticDeltaInteractionScore(fixture.evidence())).toBe(true);
  } finally { await close(fixture); }
});
