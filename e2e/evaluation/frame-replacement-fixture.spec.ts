import { expect, test, type Page } from "@playwright/test";
import { frameReplacementFixture, frameReplacementInteractionScore, frameReplacementScore, type FrameReplacementFixture } from "./frame-replacement-fixture";

async function close(fixture: FrameReplacementFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function confirmNext(page: Page, index: number) {
  await page.frameLocator('section[data-next="true"] iframe[title="Work item"]').getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator("#progress")).toHaveText(index === 12 ? "Queue complete" : `Completed ${index} of 12`);
}

for (const seed of [17, 72]) test(`replaces both cross-origin frames after every accepted item (seed ${seed})`, async ({ page }) => {
  const fixture = await frameReplacementFixture(seed);
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#progress")).toHaveText("Completed 0 of 12");
    await expect(page.locator('iframe[title="Work item"]')).toHaveCount(2);
    expect(page.frames().filter((frame) => frame.url().includes("localhost"))).toHaveLength(2);
    for (let index = 1; index <= 12; index++) {
      const previousDocuments = page.frames().filter((frame) => frame.url().includes("/item?"));
      expect(previousDocuments).toHaveLength(2);
      await page.evaluate(() => { (window as any).__previousFrames = [...document.querySelectorAll("iframe")]; });
      await confirmNext(page, index);
      expect(frameReplacementScore(fixture.evidence())).toBe(index === 12);
      expect(await page.evaluate(() => (window as any).__previousFrames.every((frame: HTMLIFrameElement) => !frame.isConnected))).toBe(true);
      await expect.poll(() => previousDocuments.every((frame) => frame.isDetached())).toBe(true);
      if (index < 12) await expect(page.locator('iframe[title="Work item"]')).toHaveCount(2);
    }
    expect(fixture.evidence().completed).toEqual(fixture.evidence().expected);
    expect(new Set(fixture.evidence().expected.map((item) => item.slot))).toEqual(new Set([0, 1]));
    expect(fixture.evidence().expected.some((item, index, all) => index > 0 && item.slot === all[index - 1]!.slot)).toBe(true);
    expect(frameReplacementInteractionScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally { await close(fixture); }
});

test("wrong frame remains recorded even after all correct actions", async ({ page }) => {
  const fixture = await frameReplacementFixture(17);
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#progress")).toHaveText("Completed 0 of 12");
    await page.frameLocator('section[data-next="false"] iframe').getByRole("button", { name: "Confirm" }).click();
    await expect(page.frameLocator('section[data-next="false"] iframe').locator("#status")).toHaveText("Rejected");
    await expect(page.locator("#progress")).toHaveText("Completed 0 of 12");
    for (let index = 1; index <= 12; index++) await confirmNext(page, index);
    const result = fixture.evidence();
    expect(result.completed).toEqual(result.expected);
    expect(result.attempts).toHaveLength(13);
    expect(result.attempts[0]).toMatchObject({ round: 0, accepted: false, trusted: true });
    expect(frameReplacementScore(result)).toBe(false);
  } finally { await close(fixture); }
});

test("synthetic click completes business action but fails interaction evidence", async ({ page }) => {
  const fixture = await frameReplacementFixture(17);
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#progress")).toHaveText("Completed 0 of 12");
    await page.frameLocator('section[data-next="true"] iframe').getByRole("button", { name: "Confirm" }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator("#progress")).toHaveText("Completed 1 of 12");
    for (let index = 2; index <= 12; index++) await confirmNext(page, index);
    expect(frameReplacementScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().attempts[0]).toMatchObject({ accepted: true, trusted: false });
    expect(frameReplacementInteractionScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("stale, malformed and duplicate attempts remain failures; HTTP can forge trust", async ({ request }) => {
  const duplicate = await frameReplacementFixture(17), forged = await frameReplacementFixture(72);
  try {
    const first = duplicate.evidence().expected[0]!;
    expect((await request.post(`${duplicate.origin}/confirm`, { data: { ...first, trusted: true } })).status()).toBe(200);
    expect((await request.post(`${duplicate.origin}/confirm`, { data: { ...first, trusted: true } })).status()).toBe(409);
    expect((await request.post(`${duplicate.origin}/confirm`, { data: { round: 1 } })).status()).toBe(409);
    for (const item of duplicate.evidence().expected.slice(1)) {
      expect((await request.post(`${duplicate.origin}/confirm`, { data: { ...item, trusted: true } })).status()).toBe(200);
    }
    expect(duplicate.evidence().completed).toEqual(duplicate.evidence().expected);
    expect(frameReplacementScore(duplicate.evidence())).toBe(false);
    // The server cannot distinguish a forged isTrusted boolean from a page-reported one.
    for (const item of forged.evidence().expected) {
      expect((await request.post(`${forged.origin}/confirm`, { data: { ...item, trusted: true } })).status()).toBe(200);
    }
    expect(frameReplacementScore(forged.evidence())).toBe(true);
    expect(frameReplacementInteractionScore(forged.evidence())).toBe(true);
  } finally { await Promise.all([close(duplicate), close(forged)]); }
});
