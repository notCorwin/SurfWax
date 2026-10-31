import { expect, test } from "@playwright/test";
import { sequenceFixture, sequenceInteractionScore, sequenceScore } from "./sequence-fixture";

for (const seed of [17, 73]) test(`keyboard reorders replaced shadow nodes across nested origins (seed ${seed})`, async ({ page }) => {
  const fixture = await sequenceFixture(seed);
  try {
    await page.goto(fixture.origin);
    const editor = page.frameLocator('iframe[title="Dispatch workspace"]').frameLocator('iframe[title="Sequence editor"]');
    const list = editor.getByRole("list", { name: "Shipment order" });
    const desired = fixture.evidence().expected;
    const initial = fixture.evidence().initial;
    const distance = initial.reduce((total, name, index) => total + initial.slice(index + 1).filter((other) => desired.sequence.indexOf(name) > desired.sequence.indexOf(other)).length, 0);
    expect(distance).toBeGreaterThanOrEqual(7);
    expect(sequenceScore(fixture.evidence())).toBe(false);
    await list.getByRole("button").first().evaluate((element) => { (window as any).__original = element; });
    let moves = 0;
    for (let index = 0; index < desired.sequence.length; index++) {
      let current = await list.getByRole("button").allTextContents();
      while (current.indexOf(desired.sequence[index]!) > index) {
        const item = list.getByRole("button", { name: desired.sequence[index], exact: true });
        await item.focus();
        await item.press("ArrowUp");
        current = await list.getByRole("button").allTextContents();
        moves++;
      }
    }
    expect(moves).toBeGreaterThan(0);
    expect(await list.getByRole("button").first().evaluate((element) => element === (window as any).__original)).toBe(false);
    await editor.getByLabel("Dispatch reference").fill(desired.reference);
    await editor.getByLabel("Confirm dispatch").check();
    await editor.getByRole("button", { name: "Send dispatch" }).click();
    await expect(editor.locator("output")).toHaveText("Dispatch sent");
    expect(sequenceScore(fixture.evidence())).toBe(true);
    expect(sequenceInteractionScore(fixture.evidence())).toBe(true);
    // Visible state and a fabricated receipt are not evidence of business effects.
    await editor.locator("output").evaluate((element) => { element.textContent = "Not sent"; });
    expect(sequenceScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
    const decoy = page.waitForResponse((response) => response.url().endsWith("/decoy"));
    await page.getByRole("button", { name: "Send dispatch" }).click();
    await decoy;
    expect(sequenceScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("business success alone and synthetic keyboard events do not count as observed keyboard interaction", async ({ page }) => {
  const direct = await sequenceFixture(17);
  const synthetic = await sequenceFixture(73);
  try {
    expect((await page.request.post(`${direct.origin}/dispatch`, { data: direct.evidence().expected })).status()).toBe(201);
    expect(sequenceScore(direct.evidence())).toBe(true);
    expect(sequenceInteractionScore(direct.evidence())).toBe(false);

    await page.goto(synthetic.origin);
    const editor = page.frameLocator('iframe[title="Dispatch workspace"]').frameLocator('iframe[title="Sequence editor"]');
    const list = editor.getByRole("list", { name: "Shipment order" });
    const expected = synthetic.evidence().expected;
    for (let index = 0; index < expected.sequence.length; index++) {
      let current = await list.getByRole("button").allTextContents();
      while (current.indexOf(expected.sequence[index]!) > index) {
        await list.getByRole("button", { name: expected.sequence[index], exact: true }).evaluate((button) => {
          button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        });
        current = await list.getByRole("button").allTextContents();
      }
    }
    await editor.getByLabel("Dispatch reference").fill(expected.reference);
    await editor.getByLabel("Confirm dispatch").check();
    await editor.getByRole("button", { name: "Send dispatch" }).click();
    await expect(editor.locator("output")).toHaveText("Dispatch sent");
    expect(sequenceScore(synthetic.evidence())).toBe(true);
    expect(sequenceInteractionScore(synthetic.evidence())).toBe(false);
  } finally {
    await Promise.all([direct, synthetic].map((fixture) => new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))));
  }
});

test("rejects fabricated page state, invalid and duplicate submissions, and decoy actions", async ({ page }) => {
  const fixture = await sequenceFixture(17);
  try {
    await page.goto(fixture.origin);
    const editor = page.frameLocator('iframe[title="Dispatch workspace"]').frameLocator('iframe[title="Sequence editor"]');
    await editor.locator("output").evaluate((element) => { element.textContent = "Dispatch sent"; });
    expect(sequenceScore(fixture.evidence())).toBe(false);
    const expected = fixture.evidence().expected;
    const url = `${fixture.origin}/dispatch`;
    expect((await page.request.post(url, { data: { ...expected, sequence: [...expected.sequence].reverse() } })).status()).toBe(400);
    expect((await page.request.post(url, { data: expected })).status()).toBe(201);
    expect((await page.request.post(url, { data: expected })).status()).toBe(201);
    expect((await page.request.post(url, { data: "not-json" })).status()).toBe(400);
    expect(fixture.evidence().attempts).toHaveLength(4);
    expect(sequenceScore(fixture.evidence())).toBe(false);
    const decoy = page.waitForResponse((response) => response.url().endsWith("/decoy"));
    await page.getByRole("button", { name: "Send dispatch" }).click();
    await decoy;
    expect(fixture.evidence().decoyClicks).toBe(1);
    expect(sequenceScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
