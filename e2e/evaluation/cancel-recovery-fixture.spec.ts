import { expect, test } from "@playwright/test";
import { cancelRecoveryFixture, cancelRecoveryScore, type CancelRecoveryFixture } from "./cancel-recovery-fixture";

async function closeFixture(fixture: CancelRecoveryFixture) {
  fixture.release(); fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

for (const seed of [17, 72]) test(`checks a committed transaction while confirmation is held (seed ${seed})`, async ({ page }) => {
  const fixture = await cancelRecoveryFixture(seed);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Recovery desk"]');
    await desk.getByLabel("Transaction reference").fill(fixture.evidence().expectedReference);
    await desk.getByRole("button", { name: "Submit transaction" }).click();
    await fixture.committed;
    await expect(desk.locator("#submit-status")).toHaveText("Waiting for confirmation");
    await desk.getByRole("button", { name: "Check status" }).click();
    await expect(desk.locator("#check-status")).toHaveText(`Completed ${fixture.evidence().expectedReference}`);
    expect(cancelRecoveryScore(fixture.evidence())).toBe(true);
    fixture.release();
    await expect(desk.locator("#submit-status")).toHaveText("Submitted");
    expect(cancelRecoveryScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});

test("rejects wrong, duplicate, early and late checks and decoy actions", async ({ request }) => {
  for (const mode of ["wrong-submit", "duplicate", "early", "late", "wrong-check", "decoy"] as const) {
    const fixture = await cancelRecoveryFixture(17);
    const reference = fixture.evidence().expectedReference;
    try {
      if (mode === "early") await request.get(`${fixture.origin}/status?reference=${reference}`);
      if (mode === "wrong-submit") await request.post(`${fixture.origin}/submit`, { data: { reference: "wrong" } });
      const pending = request.post(`${fixture.origin}/submit`, { data: { reference } });
      await fixture.committed;
      if (mode === "duplicate") expect((await request.post(`${fixture.origin}/submit`, { data: { reference } })).status()).toBe(409);
      if (mode === "late") fixture.release();
      if (mode === "decoy") await request.post(`${fixture.origin}/decoy`);
      await request.get(`${fixture.origin}/status?reference=${mode === "wrong-check" ? "wrong" : reference}`);
      fixture.release();
      expect((await pending).status()).toBe(201);
      expect(cancelRecoveryScore(fixture.evidence()), mode).toBe(false);
    } finally { await closeFixture(fixture); }
  }
});

test("the business ledger alone does not prove a browser job was cancelled", async ({ request }) => {
  const fixture = await cancelRecoveryFixture(72);
  try {
    const reference = fixture.evidence().expectedReference;
    const pending = request.post(`${fixture.origin}/submit`, { data: { reference } });
    await fixture.committed;
    await request.get(`${fixture.origin}/status?reference=${reference}`);
    expect(cancelRecoveryScore(fixture.evidence())).toBe(true);
    fixture.release();
    expect((await pending).status()).toBe(201);
  } finally { await closeFixture(fixture); }
});
