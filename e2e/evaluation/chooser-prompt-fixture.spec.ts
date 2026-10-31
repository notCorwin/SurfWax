import { expect, test, type Page } from "@playwright/test";
import { chooserPromptFixture, chooserPromptScore } from "./chooser-prompt-fixture";

async function upload(page: Page, desk: string, data: { name: string; contents: string; answer: string | null }) {
  const frame = page.frameLocator(`iframe[title="${desk}"]`);
  const chooser = page.waitForEvent("filechooser");
  await frame.getByRole("button", { name: "Choose receipt" }).click();
  const selected = await chooser;
  page.once("dialog", (dialog) => data.answer === null ? dialog.dismiss() : dialog.accept(data.answer));
  const response = page.waitForResponse((item) => new URL(item.url()).pathname.startsWith("/receive/"));
  await selected.setFiles({ name: data.name, mimeType: "text/plain", buffer: Buffer.from(data.contents, "utf8") });
  return (await response).status();
}

for (const seed of [17, 72]) test(`file chooser immediately requires a prompt in the intake frame (seed ${seed})`, async ({ page }) => {
  const fixture = await chooserPromptFixture(seed);
  try {
    await page.goto(fixture.origin);
    expect(await page.locator("iframe").evaluateAll((frames) => frames.map((frame) => frame.getAttribute("title")))).toEqual(
      seed % 2 === 0 ? ["Archive desk", "Intake desk"] : ["Intake desk", "Archive desk"],
    );
    const frame = page.frameLocator('iframe[title="Intake desk"]');
    await frame.locator("#status").evaluate((node) => { node.textContent = "Receipt accepted"; });
    expect(chooserPromptScore(fixture.evidence())).toBe(false);
    const expected = { name: await frame.locator("#filename").innerText(), contents: await frame.locator("#contents").innerText(), answer: await frame.locator("#answer").innerText() };
    expect(await upload(page, "Intake desk", expected)).toBe(201);
    await expect(frame.locator("#status")).toHaveText("Receipt accepted");
    expect(chooserPromptScore(fixture.evidence())).toBe(true);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
});

test("cancelled prompt, wrong data, wrong desk and malformed requests are retained", async ({ page }) => {
  const fixture = await chooserPromptFixture(17);
  try {
    await page.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    expect(await upload(page, "Intake desk", { ...expected, answer: null })).toBe(400);
    expect(await upload(page, "Intake desk", { ...expected, contents: expected.contents + "!" })).toBe(400);
    expect(await upload(page, "Intake desk", { ...expected, answer: "incorrect" })).toBe(400);
    expect(await upload(page, "Intake desk", { ...expected, name: "wrong.txt" })).toBe(400);
    expect(await upload(page, "Archive desk", expected)).toBe(400);
    expect((await page.request.post(`${fixture.origin}/receive/intake`, { data: "not-json" })).status()).toBe(400);
    expect(await upload(page, "Intake desk", expected)).toBe(201);
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, false, false, false, false, false, true]);
    expect(chooserPromptScore(fixture.evidence())).toBe(false);
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
});

test("business success alone does not prove chooser or prompt interaction", async ({ page }) => {
  const fixture = await chooserPromptFixture(17);
  try {
    expect((await page.request.post(`${fixture.origin}/receive/intake`, { data: fixture.evidence().expected })).status()).toBe(201);
    expect(chooserPromptScore(fixture.evidence())).toBe(true);
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
});

test("duplicate correct submissions fail independently of the page", async ({ page }) => {
  const fixture = await chooserPromptFixture(72);
  try {
    await page.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    expect(await upload(page, "Intake desk", expected)).toBe(201);
    expect(chooserPromptScore(fixture.evidence())).toBe(true);
    expect(await upload(page, "Intake desk", expected)).toBe(201);
    expect(chooserPromptScore(fixture.evidence())).toBe(false);
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
});
