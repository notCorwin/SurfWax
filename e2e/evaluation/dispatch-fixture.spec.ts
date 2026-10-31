import { expect, test } from "@playwright/test";
import { dispatchFixture, dispatchScore } from "./dispatch-fixture";

for (const seed of [17, 73]) test(`dispatch review opens a popup and requires a native prompt (seed ${seed})`, async ({ page }) => {
  const fixture = await dispatchFixture(seed);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => { document.body.dataset.status = "dispatched"; });
    expect(dispatchScore(fixture.evidence())).toBe(false);
    expect((await page.request.get(`${fixture.origin}/dispatch`)).status()).toBe(404);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);

    const popupPromise = page.waitForEvent("popup");
    await page.frameLocator('iframe[title="Dispatch desk"]').getByRole("button", { name: "Open dispatch review" }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "Dispatch review" })).toBeVisible();
    const code = await popup.locator("strong").innerText();
    popup.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      expect(dialog.message()).toContain("confirmation code");
      await dialog.accept(code);
    });
    await popup.getByRole("button", { name: "Confirm dispatch" }).click();
    await expect(popup.locator("#status")).toHaveText("Dispatched");
    expect(dispatchScore(fixture.evidence())).toBe(true);
    await popup.evaluate(() => { document.querySelector("#status")!.textContent = "Not dispatched"; });
    expect(dispatchScore(fixture.evidence())).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejected, dismissed and duplicated confirmations permanently fail the score", async ({ page }) => {
  const fixture = await dispatchFixture(17);
  try {
    await page.goto(fixture.origin);
    const popupPromise = page.waitForEvent("popup");
    await page.frameLocator('iframe[title="Dispatch desk"]').getByRole("button", { name: "Open dispatch review" }).click();
    const popup = await popupPromise;
    const code = await popup.locator("strong").innerText();
    popup.once("dialog", (dialog) => dialog.dismiss());
    await popup.getByRole("button", { name: "Confirm dispatch" }).click();
    await expect(popup.locator("#status")).toHaveText("Dispatch rejected");
    expect(dispatchScore(fixture.evidence())).toBe(false);
    popup.once("dialog", (dialog) => dialog.accept("incorrect"));
    const wrong = popup.waitForResponse((response) => response.url().endsWith("/dispatch"));
    await popup.getByRole("button", { name: "Confirm dispatch" }).click();
    await wrong;
    popup.once("dialog", (dialog) => dialog.accept(code));
    const correct = popup.waitForResponse((response) => response.url().endsWith("/dispatch"));
    await popup.getByRole("button", { name: "Confirm dispatch" }).click();
    await correct;
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, false, true]);
    expect(dispatchScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a duplicate valid confirmation is not counted as a successful dispatch", async ({ page }) => {
  const fixture = await dispatchFixture(73);
  try {
    await page.goto(fixture.origin);
    const popupPromise = page.waitForEvent("popup");
    await page.frameLocator('iframe[title="Dispatch desk"]').getByRole("button", { name: "Open dispatch review" }).click();
    const popup = await popupPromise;
    const code = await popup.locator("strong").innerText();
    for (let index = 0; index < 2; index++) {
      popup.once("dialog", (dialog) => dialog.accept(code));
      const response = popup.waitForResponse((item) => item.url().endsWith("/dispatch"));
      await popup.getByRole("button", { name: "Confirm dispatch" }).click();
      expect((await response).status()).toBe(201);
    }
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([true, true]);
    expect(dispatchScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
