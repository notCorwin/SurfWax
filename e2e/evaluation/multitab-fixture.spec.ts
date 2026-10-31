import { expect, test, type Page } from "@playwright/test";
import { multitabFixture, multitabScore, type MultitabFixture } from "./multitab-fixture";

async function openWindows(page: Page, fixture: MultitabFixture) {
  await page.goto(fixture.origin);
  const launcher = page.frameLocator('iframe[title="Window launcher"]');
  const sourcePromise = page.waitForEvent("popup");
  await launcher.getByRole("button", { name: "Open source window" }).click();
  const source = await sourcePromise;
  await expect(source.getByRole("heading", { name: "Source desk" })).toBeVisible();
  const destinationPromise = page.waitForEvent("popup");
  await launcher.getByRole("button", { name: "Open destination window" }).click();
  const destination = await destinationPromise;
  await expect(destination.getByRole("heading", { name: "Destination desk" })).toBeVisible();
  return { source, destination };
}

for (const seed of [17, 72]) test(`copies from the source popup into the destination popup (seed ${seed})`, async ({ page }) => {
  const fixture = await multitabFixture(seed);
  try {
    const { source, destination } = await openWindows(page, fixture);
    const sourceCode = await source.locator("strong").innerText();
    expect(sourceCode).toBe(fixture.evidence().expectedCode);
    expect(await destination.locator("strong").innerText()).not.toBe(sourceCode);
    expect(new URL(source.url()).hostname).toBe("localhost");
    expect(new URL(destination.url()).hostname).toBe("127.0.0.1");
    await destination.locator("#status").evaluate((element) => { element.textContent = "Transfer submitted"; });
    expect(multitabScore(fixture.evidence())).toBe(false);
    await destination.getByLabel("Transfer code").fill(sourceCode);
    await destination.getByRole("button", { name: "Submit transfer" }).click();
    await expect(destination.locator("#status")).toHaveText("Transfer submitted");
    await expect.poll(() => multitabScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().attempts).toEqual([{ window: "destination", value: sourceCode, accepted: true }]);
    await destination.locator("#status").evaluate((element) => { element.textContent = "Not submitted"; });
    expect(multitabScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a wrong-window submission remains a failure after a correct transfer", async ({ page }) => {
  const fixture = await multitabFixture(17);
  try {
    const { source, destination } = await openWindows(page, fixture);
    const sourceCode = await source.locator("strong").innerText();
    await source.getByLabel("Transfer code").fill(sourceCode);
    await source.getByRole("button", { name: "Submit transfer" }).click();
    await expect(source.locator("#status")).toHaveText("Transfer rejected");
    await destination.getByLabel("Transfer code").fill(sourceCode);
    await destination.getByRole("button", { name: "Submit transfer" }).click();
    await expect(destination.locator("#status")).toHaveText("Transfer submitted");
    expect(fixture.evidence().attempts.map(({ window, accepted }) => ({ window, accepted }))).toEqual([
      { window: "source", accepted: false }, { window: "destination", accepted: true },
    ]);
    expect(multitabScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the destination's decoy code, malformed requests and duplicates are recorded", async ({ page }) => {
  const fixture = await multitabFixture(72);
  try {
    const { source, destination } = await openWindows(page, fixture);
    await destination.getByLabel("Transfer code").fill(await destination.locator("strong").innerText());
    await destination.getByRole("button", { name: "Submit transfer" }).click();
    await expect(destination.locator("#status")).toHaveText("Transfer rejected");
    expect((await page.request.post(`${fixture.origin}/submit/destination`, { data: "not-json" })).status()).toBe(400);
    const sourceCode = await source.locator("strong").innerText();
    await destination.getByLabel("Transfer code").fill(sourceCode);
    for (let index = 0; index < 2; index++) {
      const result = destination.waitForResponse((response) => response.url().endsWith("/submit/destination"));
      await destination.getByRole("button", { name: "Submit transfer" }).click();
      expect((await result).status()).toBe(201);
    }
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, false, true, true]);
    expect(multitabScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
