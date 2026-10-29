import { expect, test } from "@playwright/test";
import { businessScore, orderFixture } from "./order-fixture";

test("scores business effects in the fixture process instead of mutable page state", async ({ page }) => {
  const fixture = await orderFixture();
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Checkout"]');
    await page.evaluate(() => { (window as any).businessOrders = [{ order: "ORDER-17", service: "express", confirmed: true }]; });
    await frame.locator("#status").evaluate((element) => { element.textContent = "Submitted ORDER-17"; });
    expect(businessScore(fixture.evidence(), "ORDER-17", "express")).toBe(false);
    await expect((await page.request.get(`${fixture.origin}/orders`)).status()).toBe(404);
    await expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);

    await frame.getByLabel("Order reference").fill("ORDER-17");
    await frame.getByLabel("Service").selectOption("express");
    await frame.getByLabel("Confirm details").check();
    await frame.getByRole("button", { name: "Submit order" }).click();
    await expect(frame.locator("#status")).toHaveText("Submitted ORDER-17");
    expect(businessScore(fixture.evidence(), "ORDER-17", "express")).toBe(true);

    // Clearing visible state cannot clear the authoritative receipt.
    await page.evaluate(() => { (window as any).businessOrders = []; delete document.body.dataset.decoyClicks; });
    expect(businessScore(fixture.evidence(), "ORDER-17", "express")).toBe(true);
    const decoy = page.waitForResponse((response) => response.url().endsWith("/decoy"));
    await page.locator("#decoy").click();
    await decoy;
    expect(businessScore(fixture.evidence(), "ORDER-17", "express")).toBe(false);
    expect(fixture.evidence().decoyClicks).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("counts duplicate and invalid submissions", async ({ page }) => {
  const fixture = await orderFixture();
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Checkout"]');
    await frame.getByLabel("Order reference").fill("ORDER-17");
    await frame.getByLabel("Service").selectOption("express");
    await frame.getByLabel("Confirm details").check();
    for (let i = 0; i < 2; i++) {
      const submitted = page.waitForResponse((response) => response.url().endsWith("/orders"));
      await frame.getByRole("button", { name: "Submit order" }).click();
      await submitted;
    }
    expect(fixture.evidence().orders).toHaveLength(2);
    expect(businessScore(fixture.evidence(), "ORDER-17", "express")).toBe(false);
    await page.request.post(`${fixture.origin}/orders`, { data: "not-json" });
    expect(fixture.evidence().orders).toHaveLength(3);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
