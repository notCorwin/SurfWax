import { expect, test, type APIRequestContext, type FrameLocator } from "@playwright/test";
import { rollingFixture, rollingInteractionScore, rollingScore, type RollingFixture } from "./rolling-fixture";

async function close(fixture: RollingFixture) {
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function processNext(frame: FrameLocator, completed: number) {
  const next = frame.locator('tbody tr[data-next="true"]');
  await expect(next).toHaveCount(1);
  await expect(next.locator("td").nth(1)).toHaveText("Next");
  await next.getByRole("button", { name: "Process", exact: true }).click();
  await expect(frame.locator("#progress")).toHaveText(completed === 30 ? "Queue complete" : `Completed ${completed} of 30`);
}

async function processByApi(request: APIRequestContext, fixture: RollingFixture) {
  const response = await request.get(`${fixture.origin}/current`);
  expect(response.status()).toBe(200);
  const state = await response.json();
  expect(state.rows).toHaveLength(5);
  const next = state.rows.find((row: { label: string }) => row.label === "Next");
  expect(next).toBeTruthy();
  expect((await request.post(`${fixture.origin}/process`, { data: { id: next.id, revision: state.revision } })).status()).toBe(200);
  return { id: next.id as string, revision: state.revision as number };
}

for (const seed of [17, 72]) test(`processes every changing Next row without mistaken actions (seed ${seed})`, async ({ page }) => {
  const fixture = await rollingFixture(seed);
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Rolling queue"]');
    await expect(frame.locator("#progress")).toHaveText("Completed 0 of 30");
    expect(rollingScore(fixture.evidence())).toBe(false);
    const firstRow = frame.locator("tbody tr").first();
    await firstRow.evaluate((row) => { (window as any).__savedRow = row; (window as any).__savedButton = row.querySelector("button"); });
    const firstIdentity = await firstRow.locator("td").first().textContent();
    let previousSlot = -1;
    for (let index = 0; index < 30; index++) {
      const next = frame.locator('tbody tr[data-next="true"]');
      const slot = await next.evaluate((row) => [...row.parentElement!.children].indexOf(row));
      expect(slot).not.toBe(previousSlot);
      previousSlot = slot;
      expect(await next.locator("td").first().textContent()).toBe(fixture.evidence().expectedIds[index]);
      await processNext(frame, index + 1);
      if (index === 0) {
        expect(await firstRow.evaluate((row) => row === (window as any).__savedRow && row.querySelector("button") === (window as any).__savedButton)).toBe(true);
        expect(await firstRow.locator("td").first().textContent()).not.toBe(firstIdentity);
      }
      if (index < 29) expect(rollingScore(fixture.evidence())).toBe(false);
    }
    expect(rollingScore(fixture.evidence())).toBe(true);
    expect(rollingInteractionScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().attempts).toHaveLength(30);
    expect(fixture.evidence().completedIds).toEqual(fixture.evidence().expectedIds);
    await frame.locator("#progress").evaluate((output) => { output.textContent = "Not done"; });
    expect(rollingScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally { await close(fixture); }
});

test("a reused old target becomes a wrong job and cannot be repaired by completing the queue", async ({ page }) => {
  const fixture = await rollingFixture(17);
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Rolling queue"]');
    await expect(frame.locator("#progress")).toHaveText("Completed 0 of 30");
    const original = frame.locator('tbody tr[data-next="true"]');
    const slot = await original.evaluate((row) => [...row.parentElement!.children].indexOf(row));
    const originalId = await original.locator("td").first().textContent();
    await original.evaluate((row) => { (window as any).__oldTarget = row.querySelector("button"); });
    await processNext(frame, 1);
    const oldSlot = frame.locator("tbody tr").nth(slot);
    expect(await oldSlot.getByRole("button").evaluate((button) => button === (window as any).__oldTarget)).toBe(true);
    expect(await oldSlot.locator("td").first().textContent()).not.toBe(originalId);
    expect(await oldSlot.locator("td").nth(1).textContent()).toBe("Waiting");
    await oldSlot.getByRole("button", { name: "Process" }).click();
    await expect(frame.locator("#notice")).toContainText("Rejected");
    await expect(frame.locator("#progress")).toHaveText("Completed 1 of 30");
    for (let index = 1; index < 30; index++) await processNext(frame, index + 1);
    const result = fixture.evidence();
    expect(result.completedIds).toEqual(result.expectedIds);
    expect(result.attempts).toHaveLength(31);
    expect(result.attempts[1]).toMatchObject({ revision: 1, accepted: false });
    expect(rollingScore(result)).toBe(false);
  } finally { await close(fixture); }
});

test("a synthetic click can produce the business result without trusted interaction evidence", async ({ page }) => {
  const fixture = await rollingFixture(17);
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Rolling queue"]');
    await expect(frame.locator("#progress")).toHaveText("Completed 0 of 30");
    await frame.locator('tbody tr[data-next="true"]').getByRole("button", { name: "Process" }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(frame.locator("#progress")).toHaveText("Completed 1 of 30");
    for (let index = 1; index < 30; index++) await processNext(frame, index + 1);
    expect(rollingScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().attempts[0]).toMatchObject({ accepted: true, trusted: false });
    expect(rollingInteractionScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("the independent judge records stale duplicates, and direct HTTP can bypass the UI", async ({ request }) => {
  const exact = await rollingFixture(17), duplicate = await rollingFixture(72);
  try {
    // The business ledger is independent of page text, but HTTP access can satisfy it without UI interaction.
    for (let index = 0; index < 29; index++) {
      await processByApi(request, exact);
      expect(rollingScore(exact.evidence())).toBe(false);
    }
    await processByApi(request, exact);
    expect(rollingScore(exact.evidence())).toBe(true);
    expect(rollingInteractionScore(exact.evidence())).toBe(false);
    const first = await processByApi(request, duplicate);
    expect((await request.post(`${duplicate.origin}/process`, { data: first })).status()).toBe(409);
    for (let index = 1; index < 30; index++) await processByApi(request, duplicate);
    expect(duplicate.evidence().completedIds).toEqual(duplicate.evidence().expectedIds);
    expect(duplicate.evidence().attempts).toHaveLength(31);
    expect(duplicate.evidence().attempts[1]).toMatchObject({ id: first.id, revision: first.revision, accepted: false });
    expect(rollingScore(duplicate.evidence())).toBe(false);
    expect((await request.get(`${exact.origin}/reset`)).status()).toBe(404);
  } finally { await Promise.all([close(exact), close(duplicate)]); }
});
