import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { uploadFixture, uploadScore, type UploadFixture } from "./upload-fixture";

async function retrieve(page: Page, fixture: UploadFixture) {
  const desk = page.frameLocator('iframe[title="Document desk"]');
  const result: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];
  for (const file of fixture.evidence().expected) {
    const wait = page.waitForEvent("download");
    await desk.getByRole("link", { name: `Download ${file.name}` }).click();
    const download = await wait;
    expect(download.suggestedFilename()).toBe(file.name);
    result.push({ name: file.name, mimeType: "application/octet-stream", buffer: await readFile(await download.path()) });
  }
  return result;
}

async function choose(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const desk = page.frameLocator('iframe[title="Document desk"]');
  const wait = page.waitForEvent("filechooser");
  await desk.getByRole("button", { name: "Choose files" }).click();
  const chooser = await wait;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(files);
}

for (const seed of [17, 73]) test(`downloads and reattaches exact binary files through a cross-origin chooser (seed ${seed})`, async ({ page }) => {
  const fixture = await uploadFixture(seed);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Document desk"]');
    await desk.locator("#status").evaluate((element) => { element.textContent = "Dossier submitted"; });
    expect(uploadScore(fixture.evidence())).toBe(false);
    await desk.locator("#status").evaluate((element) => { element.textContent = "Not submitted"; });
    const files = await retrieve(page, fixture);
    expect(files[1]!.buffer.length).toBeGreaterThan(32768);
    expect(files[1]!.buffer.subarray(0, 4)).toEqual(Buffer.from([0, 255, 128, 10]));
    // File order is irrelevant; bytes and names are not.
    await choose(page, files.reverse());
    await desk.getByRole("button", { name: "Submit dossier" }).click();
    await expect(desk.locator("#status")).toHaveText("Dossier submitted");
    expect(uploadScore(fixture.evidence())).toBe(true);
    await desk.locator("#status").evaluate((element) => { element.textContent = "Not submitted"; });
    expect(uploadScore(fixture.evidence())).toBe(true);
    expect((await page.request.get(`${fixture.origin}/upload`)).status()).toBe(404);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects altered, missing, renamed and malformed files permanently even after a correct submission", async ({ page }) => {
  const fixture = await uploadFixture(17);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Document desk"]');
    const files = await retrieve(page, fixture);
    const altered = files.map((file) => ({ ...file, buffer: Buffer.from(file.buffer) }));
    altered[1]!.buffer[100] ^= 1;
    await choose(page, altered);
    await desk.getByRole("button", { name: "Submit dossier" }).click();
    await expect(desk.locator("#status")).toHaveText("Dossier rejected");
    expect(fixture.evidence().attempts[0]!.accepted).toBe(false);
    await choose(page, [files[0]!]);
    const missing = page.waitForResponse((response) => response.url().endsWith("/upload"));
    await desk.getByRole("button", { name: "Submit dossier" }).click();
    expect((await missing).status()).toBe(400);
    await choose(page, [{ ...files[0]!, name: "wrong-name.txt" }, files[1]!]);
    const renamed = page.waitForResponse((response) => response.url().endsWith("/upload"));
    await desk.getByRole("button", { name: "Submit dossier" }).click();
    expect((await renamed).status()).toBe(400);
    expect((await page.request.post(`${fixture.origin}/upload`, { data: "not-json" })).status()).toBe(400);
    await choose(page, files);
    const correct = page.waitForResponse((response) => response.url().endsWith("/upload"));
    await desk.getByRole("button", { name: "Submit dossier" }).click();
    expect((await correct).status()).toBe(201);
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, false, false, false, true]);
    expect(uploadScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a duplicate valid upload fails the independent judge", async ({ page }) => {
  const fixture = await uploadFixture(73);
  try {
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Document desk"]');
    const files = await retrieve(page, fixture);
    await choose(page, files);
    for (let index = 0; index < 2; index++) {
      const response = page.waitForResponse((item) => item.url().endsWith("/upload"));
      await desk.getByRole("button", { name: "Submit dossier" }).click();
      expect((await response).status()).toBe(201);
      await expect(desk.getByRole("button", { name: "Submit dossier" })).toBeEnabled();
    }
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([true, true]);
    expect(uploadScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
