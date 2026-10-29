import { expect, test } from "@playwright/test";
import { claimsFixture, claimsScore } from "./claims-fixture";

for (const seed of [17, 73]) test(`scores the seeded, paginated claims workflow independently (seed ${seed})`, async ({ page }) => {
  const fixture = await claimsFixture(seed);
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Claims queue"]');
    await expect(frame.locator("#page")).toHaveText("Page 1 of 3");
    await frame.locator("tbody tr").first().evaluate((row) => { (window as any).__firstClaimRow = row; });
    for (let index = 0; index < 3; index++) {
      // The order is randomized; choose the eligible row by the values shown on this page.
      const rows = frame.locator("tbody tr");
      let approved = 0;
      for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
        const current = rows.nth(rowIndex);
        const cells = await current.locator("td").allTextContents();
        if (cells[1] === "APAC" && Number(cells[2]!.slice(1)) <= 500 && cells[3] === "pending") {
          await current.getByRole("button", { name: `Approve ${cells[0]}` }).click();
          await expect(current.locator("td").nth(3)).toHaveText("approved");
          approved++;
        }
      }
      expect(approved).toBe(1);
      if (index < 2) {
        await frame.getByRole("button", { name: "Next page" }).click();
        expect(await frame.locator("tbody tr").first().evaluate((element) => element === (window as any).__firstClaimRow)).toBe(true);
      }
    }
    expect(claimsScore(fixture.evidence())).toBe(true);
    await frame.locator("#notice").evaluate((element) => { element.textContent = "Fake success"; });
    expect(claimsScore(fixture.evidence())).toBe(true);
    expect((await page.request.get(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("wrong or duplicate claims permanently fail the business judge", async ({ page }) => {
  const fixture = await claimsFixture(17);
  try {
    const initial = fixture.evidence();
    const wrong = initial.claims.find((claim) => claim.status === "pending" && !initial.expectedIds.includes(claim.id))!;
    const endpoint = `${fixture.origin}/approve`;
    expect((await page.request.post(endpoint, { data: { id: wrong.id, revision: wrong.revision } })).status()).toBe(200);
    expect((await page.request.post(endpoint, { data: { id: wrong.id, revision: wrong.revision } })).status()).toBe(409);
    expect(claimsScore(fixture.evidence())).toBe(false);
    expect(fixture.evidence().attempts).toHaveLength(2);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
