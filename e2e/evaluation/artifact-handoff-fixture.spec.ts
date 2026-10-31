import { expect, test, type Page } from "@playwright/test";
import { artifactHandoffFixture, artifactHandoffScore, type ArtifactHandoffFixture } from "./artifact-handoff-fixture";

async function closeFixture(fixture: ArtifactHandoffFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function sourceText(page: Page, fixture: ArtifactHandoffFixture) {
  await page.goto(fixture.origin);
  const desk = page.frameLocator('iframe[title="Handoff desk"]');
  await expect(desk.getByLabel("Source data")).toHaveValue(/^ROW-0000-/);
  return desk.getByLabel("Source data").inputValue();
}

for (const seed of [17, 72]) test(`copies the entire generated multibyte source (seed ${seed})`, async ({ page, request }) => {
  const fixture = await artifactHandoffFixture(seed);
  try {
    const text = await sourceText(page, fixture);
    const expected = fixture.evidence();
    expect(text.length).toBe(expected.expectedCodeUnits);
    expect(text.length).toBeGreaterThan(40_000);
    expect(Buffer.byteLength(text, "utf8")).toBe(expected.expectedBytes);
    expect(text).toContain("海🌊");
    expect(text).toContain("e\u0301");
    expect((await request.get(`${fixture.origin}/source`)).status()).toBe(404);
    const desk = page.frameLocator('iframe[title="Handoff desk"]');
    await desk.getByLabel("Complete copy").fill(text);
    await desk.getByRole("button", { name: "Submit copy" }).click();
    await expect(desk.locator("#status")).toHaveText("Submitted");
    expect(artifactHandoffScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().attempts).toEqual([{ bytes: expected.expectedBytes, sha256: expected.expectedSha256, accepted: true }]);
  } finally { await closeFixture(fixture); }
});

test("different seeds produce different source data and independent digests", async ({ page }) => {
  const first = await artifactHandoffFixture(17), second = await artifactHandoffFixture(72);
  try {
    const left = await sourceText(page, first), right = await sourceText(page, second);
    expect(left).not.toBe(right);
    expect(first.evidence().expectedSha256).not.toBe(second.evidence().expectedSha256);
  } finally { await closeFixture(first); await closeFixture(second); }
});

test("truncation, same-length corruption, normalization, malformed input and duplicate submissions cannot be repaired", async ({ page, request }) => {
  for (const mode of ["truncated", "corrupt", "normalized", "malformed", "duplicate"] as const) {
    const fixture = await artifactHandoffFixture(17);
    try {
      const text = await sourceText(page, fixture);
      const damaged = mode === "truncated" ? text.slice(0, -1) : mode === "corrupt" ? text.replace("ROW-", "WOW-") : text.normalize("NFC");
      if (mode === "corrupt") expect(Buffer.byteLength(damaged, "utf8")).toBe(fixture.evidence().expectedBytes);
      const bad = mode === "malformed" ? { value: text } : { payload: mode === "duplicate" ? text : damaged };
      expect((await request.post(`${fixture.origin}/submit`, { data: bad })).status(), mode).toBe(mode === "duplicate" ? 201 : 400);
      expect((await request.post(`${fixture.origin}/submit`, { data: { payload: text } })).status()).toBe(400);
      const evidence = fixture.evidence();
      expect(evidence.attempts).toHaveLength(2);
      expect(artifactHandoffScore(evidence), mode).toBe(false);
    } finally { await closeFixture(fixture); }
  }
});

test("direct HTTP can submit the right data without using an artifact", async ({ page, request }) => {
  const fixture = await artifactHandoffFixture(72);
  try {
    const text = await sourceText(page, fixture);
    expect((await request.post(`${fixture.origin}/submit`, { data: { payload: text } })).status()).toBe(201);
    // The business ledger does not prove which browser or artifact tools were used.
    expect(artifactHandoffScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});
