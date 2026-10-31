import { expect, test, type Page } from "@playwright/test";
import { recoveryFixture, recoveryScore, type RecoveryFixture } from "./recovery-fixture";

async function submit(page: Page, fixture: RecoveryFixture) {
  const desk = page.frameLocator('iframe[title="Transaction desk"]');
  await desk.getByLabel("Transaction reference").fill(fixture.evidence().expectedReference);
  await desk.getByRole("button", { name: "Submit transaction" }).click();
  await expect(desk.locator("#status")).toHaveText("Confirmation unavailable. Check status before retrying.");
  return desk;
}

for (const seed of [17, 73]) test(`verifies a committed transaction after losing its response (seed ${seed})`, async ({ page }) => {
  const fixture = await recoveryFixture(seed);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Transaction desk"]');
    await desk.locator("#status").evaluate((output) => { output.textContent = "Completed"; });
    expect(recoveryScore(fixture.evidence())).toBe(false);
    await submit(page, fixture);
    const beforeCheck = fixture.evidence();
    expect(beforeCheck.committedReference).toBe(beforeCheck.expectedReference);
    expect(beforeCheck.attempts).toHaveLength(1);
    expect(beforeCheck.attempts[0]).toMatchObject({ accepted: true, responseLost: true });
    expect(recoveryScore(beforeCheck)).toBe(false);
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#status")).toHaveText(`Completed ${beforeCheck.expectedReference}`);
    expect(recoveryScore(fixture.evidence())).toBe(true);
    const afterCheck = fixture.evidence();
    expect(recoveryScore({ ...afterCheck, checks: afterCheck.checks.map((check) => ({ ...check, afterResponseLost: false })) })).toBe(false);
    await desk.locator("#status").evaluate((output) => { output.textContent = "Not submitted"; });
    expect(recoveryScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("checking before submission does not verify the later committed write", async ({ page }) => {
  const fixture = await recoveryFixture(17);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Transaction desk"]');
    await desk.getByLabel("Transaction reference").fill(fixture.evidence().expectedReference);
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#status")).toContainText("Not found");
    await submit(page, fixture);
    expect(fixture.evidence().checks).toHaveLength(1);
    expect(recoveryScore(fixture.evidence())).toBe(false);
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#status")).toContainText("Completed");
    expect(recoveryScore(fixture.evidence())).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("wrong, malformed and duplicate submissions cannot be erased by eventual success", async ({ page }) => {
  const fixture = await recoveryFixture(17);
  try {
    await page.goto(fixture.origin);
    expect((await page.request.post(`${fixture.origin}/submit`, { data: { reference: "wrong" } })).status()).toBe(400);
    expect((await page.request.post(`${fixture.origin}/submit`, { data: "not-json" })).status()).toBe(400);
    const desk = await submit(page, fixture);
    const duplicate = page.waitForResponse((response) => response.url().endsWith("/submit"));
    await desk.getByRole("button", { name: "Submit transaction" }).click();
    expect((await duplicate).status()).toBe(409);
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#status")).toContainText("Completed");
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, false, true, false]);
    expect(recoveryScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a duplicate or a decoy click invalidates an otherwise correct transaction", async ({ page }) => {
  const duplicateFixture = await recoveryFixture(17);
  const decoyFixture = await recoveryFixture(73);
  try {
    await page.goto(duplicateFixture.origin);
    const desk = await submit(page, duplicateFixture);
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#status")).toContainText("Completed");
    expect(recoveryScore(duplicateFixture.evidence())).toBe(true);
    const duplicate = page.waitForResponse((response) => response.url().endsWith("/submit"));
    await desk.getByRole("button", { name: "Submit transaction" }).click();
    expect((await duplicate).status()).toBe(409);
    expect(recoveryScore(duplicateFixture.evidence())).toBe(false);

    await page.goto(decoyFixture.origin);
    const otherDesk = await submit(page, decoyFixture);
    await otherDesk.getByRole("button", { name: "Check status" }).click();
    await expect(otherDesk.locator("#status")).toContainText("Completed");
    expect(recoveryScore(decoyFixture.evidence())).toBe(true);
    const decoy = page.waitForResponse((response) => response.url().endsWith("/decoy"));
    await page.getByRole("button", { name: "Submit transaction" }).click();
    await decoy;
    expect(recoveryScore(decoyFixture.evidence())).toBe(false);
  } finally {
    await Promise.all([duplicateFixture, decoyFixture].map((fixture) => new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))));
  }
});
