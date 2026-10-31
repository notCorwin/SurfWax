import { expect, test, type APIRequestContext } from "@playwright/test";
import { manifestFixture, manifestScore, type ManifestFixture } from "./manifest-fixture";

async function close(fixture: ManifestFixture) {
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function readPages(request: APIRequestContext, fixture: ManifestFixture): Promise<string[]> {
  const codes: string[] = [];
  for (let index = 0; index < fixture.evidence().pageCount; index++) {
    const response = await request.get(`${fixture.origin}/api/page?index=${index}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ index, total: 20 });
    expect(body.codes).toHaveLength(60);
    codes.push(...body.codes);
  }
  return codes;
}

for (const seed of [17, 73]) test(`collects a long manifest across all reused pages (seed ${seed})`, async ({ page }) => {
  const fixture = await manifestFixture(seed);
  try {
    expect(fixture.evidence().expectedBytes).toBeGreaterThan(32_768);
    expect(fixture.evidence().expectedBytes).toBeGreaterThan(fixture.evidence().expectedCodeUnits);
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Manifest desk"]');
    const rows = desk.getByRole("list", { name: "Tracking codes" }).getByRole("listitem");
    await expect(desk.locator("#page")).toHaveText("Page 1 of 20");
    await rows.first().evaluate((element) => { (window as any).__originalRow = element; });
    const codes: string[] = [];
    for (let index = 0; index < 20; index++) {
      const displayed = await rows.allTextContents();
      expect(displayed).toHaveLength(60);
      expect(displayed.every((value) => value.startsWith(`PKG-${seed}-`))).toBe(true);
      expect(await desk.getByRole("list", { name: "Tracking codes" }).innerText()).toBe(displayed.join("\n"));
      codes.push(...displayed);
      if (index < 19) {
        await desk.getByRole("button", { name: "Next page" }).click();
        await expect(desk.locator("#page")).toHaveText(`Page ${index + 2} of 20`);
        expect(await rows.first().evaluate((element) => element === (window as any).__originalRow)).toBe(true);
      }
    }
    expect(codes).toHaveLength(1200);
    expect(new Set(codes).size).toBe(1200);
    const manifest = codes.join("\n");
    expect(Buffer.byteLength(manifest, "utf8")).toBe(fixture.evidence().expectedBytes);
    await desk.getByLabel("Complete manifest").fill(manifest);
    await desk.getByRole("button", { name: "Submit manifest" }).click();
    await expect(desk.locator("#status")).toHaveText("Manifest submitted");
    expect(manifestScore(fixture.evidence())).toBe(true);
    expect(new Set(fixture.evidence().pageReads).size).toBe(20);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally { await close(fixture); }
});

test("the seed is reproducible and no page endpoint serves the full dataset", async ({ request }) => {
  const first = await manifestFixture(17), same = await manifestFixture(17), other = await manifestFixture(73);
  try {
    expect(first.evidence().expectedSha256).toBe(same.evidence().expectedSha256);
    expect(first.evidence().expectedSha256).not.toBe(other.evidence().expectedSha256);
    const index = await request.get(first.origin);
    const desk = await request.get(`${first.origin}/desk`);
    expect(await index.text()).not.toContain("PKG-17-");
    expect(await desk.text()).not.toContain("PKG-17-");
    const chunk = await request.get(`${first.origin}/api/page?index=0`);
    expect((await chunk.json()).codes).toHaveLength(60);
    for (const query of ["", "-1", "20", "all", "1.5"]) {
      expect((await request.get(`${first.origin}/api/page?index=${query}`)).status()).toBe(404);
    }
  } finally { await Promise.all([close(first), close(same), close(other)]); }
});

test("wrong, missing, reordered and truncated data remain failures after a correct retry", async ({ request }) => {
  const variants = [
    (codes: string[]) => ["wrong-code", ...codes.slice(1)].join("\n"),
    (codes: string[]) => codes.filter((_, index) => index !== 60).join("\n"),
    (codes: string[]) => { [codes[59], codes[60]] = [codes[60]!, codes[59]!]; return codes.join("\n"); },
    (codes: string[]) => codes.join("\n").slice(0, -1),
  ];
  for (const change of variants) {
    const fixture = await manifestFixture(17);
    try {
      const codes = await readPages(request, fixture);
      const incorrect = await request.post(`${fixture.origin}/submit`, { data: { manifest: change([...codes]) } });
      expect(incorrect.status()).toBe(400);
      expect(manifestScore(fixture.evidence())).toBe(false);
      const correct = await request.post(`${fixture.origin}/submit`, { data: { manifest: codes.join("\n") } });
      expect(correct.status()).toBe(201);
      expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, true]);
      expect(manifestScore(fixture.evidence())).toBe(false);
    } finally { await close(fixture); }
  }
});

test("all pages must be requested before submission; later reads cannot repair it", async ({ request }) => {
  const source = await manifestFixture(73), target = await manifestFixture(73);
  try {
    const codes = await readPages(request, source);
    const response = await request.post(`${target.origin}/submit`, { data: { manifest: codes.join("\n") } });
    expect(response.status()).toBe(201);
    expect(target.evidence().attempts[0]).toMatchObject({ accepted: true, pagesReadBefore: 0 });
    expect(manifestScore(target.evidence())).toBe(false);
    await readPages(request, target);
    expect(manifestScore(target.evidence())).toBe(false);
  } finally { await Promise.all([close(source), close(target)]); }
});

test("HTTP access alone can satisfy the judge, but duplicate submissions cannot", async ({ request }) => {
  const fixture = await manifestFixture(17);
  try {
    // Page reads and a business result are not proof of UI interaction.
    const codes = await readPages(request, fixture);
    const manifest = codes.join("\n");
    expect((await request.post(`${fixture.origin}/submit`, { data: { manifest } })).status()).toBe(201);
    expect(manifestScore(fixture.evidence())).toBe(true);
    expect((await request.post(`${fixture.origin}/submit`, { data: { manifest } })).status()).toBe(201);
    expect(manifestScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});
