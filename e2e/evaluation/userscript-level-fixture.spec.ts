import { expect, test, type BrowserContext } from "@playwright/test";
import { userscriptFixture, userscriptScore, type RegistryEvidence, type UserscriptFixture } from "./userscript-level-fixture";

const names = ["Atlas", "Birch", "Coral", "Drift", "Elm", "Finch", "Grove", "Harbor"];

function fixedRegistry(fixture: UserscriptFixture): RegistryEvidence {
  const fixed = { ...fixture.preset.target, allFrames: true, js: [{ code: "document.documentElement.dataset.stamp = document.body.dataset.expectedStamp;" }] };
  return { registered: [structuredClone(fixed)], active: [structuredClone(fixed)], disabled: [structuredClone(fixture.preset.decoy)] };
}

async function injectCorrectScript(context: BrowserContext) {
  await context.addInitScript(() => {
    if (location.hostname !== "localhost" || !location.pathname.startsWith("/record/")) return;
    addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.stamp = document.body.dataset.expectedStamp; });
  });
}

async function closeFixture(fixture: UserscriptFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

for (const seed of [17, 72]) test(`cross-origin record executions and independent registry satisfy the judge (seed ${seed})`, async ({ browser }) => {
  const fixture = await userscriptFixture(seed), context = await browser.newContext();
  try {
    await injectCorrectScript(context);
    const page = await context.newPage(); await page.goto(fixture.origin);
    expect(fixture.evidence()).toMatchObject({ visits: [], receipts: [], submissions: [] });
    for (const name of names) {
      await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
      await expect(page.frameLocator('iframe[title="Record"]').getByRole("heading", { name: `${name} record` })).toBeVisible();
      await expect(page.frameLocator('iframe[title="Record"]').locator("#stamp")).toHaveText("Ready");
    }
    await page.getByRole("button", { name: "Submit records" }).click();
    await expect(page.locator("#status")).toHaveText("Submitted");
    const evidence = fixture.evidence(), registry = fixedRegistry(fixture);
    expect(evidence.visits.map((visit) => visit.name)).toEqual(names);
    expect(new Set(evidence.visits.map((visit) => visit.documentId)).size).toBe(names.length);
    expect(new Set(Object.values(evidence.expected)).size).toBe(names.length);
    expect(userscriptScore(evidence, registry, fixture.preset, true)).toBe(true);
    expect(userscriptScore(evidence, registry, fixture.preset, false)).toBe(false);
    expect(userscriptScore(evidence, registry, fixture.preset, null)).toBeNull();
    expect(userscriptScore(evidence, { ...registry, registered: [] }, fixture.preset, true)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, registered: [] }, fixture.preset, null)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, active: [] }, fixture.preset, true)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, disabled: [] }, fixture.preset, true)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, registered: [{ ...registry.registered[0]!, allFrames: false }] }, fixture.preset, true)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, disabled: [{ ...registry.disabled[0]!, js: [{ code: "changed" }] }] }, fixture.preset, true)).toBe(false);
    const { id, matches, allFrames, runAt, world, js } = fixture.preset.decoy;
    expect(userscriptScore(evidence, { ...registry, disabled: [{ allFrames, id, js, matches, runAt, world }] }, fixture.preset, true)).toBe(true);
    expect(userscriptScore(evidence, { ...registry, active: [{ ...registry.active[0]!, js: [{ code: "different" }] }] }, fixture.preset, true)).toBe(false);
    const alternate = { ...registry.registered[0]!, world: "USER_SCRIPT" as const, runAt: "document_idle" as const, matches: ["http://localhost/record/*"] };
    expect(userscriptScore(evidence, { ...registry, registered: [alternate], active: [structuredClone(alternate)] }, fixture.preset, true)).toBe(true);
  } finally { await context.close(); await closeFixture(fixture); }
});

test("fresh cross-origin verification detects an ineffective script without changing the task ledger", async ({ browser }) => {
  const fixture = await userscriptFixture(17), correct = await browser.newContext(), broken = await browser.newContext();
  try {
    await injectCorrectScript(correct);
    await broken.addInitScript(() => {
      if (location.hostname === "localhost" && location.pathname.startsWith("/record/")) {
        addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.stamp = "WRONG"; });
      }
    });
    const page = await correct.newPage();
    const initial = await page.goto(fixture.origin);
    const initialHtml = await initial!.text(), before = fixture.evidence();
    const first = fixture.createVerification(), second = fixture.createVerification();
    expect(first.url).not.toBe(second.url);
    expect(first.expectedStamp).not.toBe(second.expectedStamp);
    expect(initialHtml).not.toContain(first.expectedStamp);
    expect(initialHtml).not.toContain(first.url);
    expect((await page.request.get(`${fixture.origin}/verify/${"0".repeat(32)}`)).status()).toBe(404);
    for (const verification of [first, second]) {
      expect((await page.goto(verification.url))?.status()).toBe(200);
      const frame = page.frameLocator('iframe[title="Verification"]');
      await expect(frame.locator("body")).toHaveAttribute("data-verification-ready", "true");
      await expect(frame.locator("body")).toHaveAttribute("data-expected-stamp", verification.expectedStamp);
      await expect(frame.locator("html")).toHaveAttribute("data-stamp", verification.expectedStamp);
      expect(await frame.locator("body").evaluate(() => location.origin)).toBe(fixture.origin.replace("127.0.0.1", "localhost"));
      expect(await frame.locator("body").evaluate(() => location.pathname)).toMatch(/^\/record\/__verify\/[a-f0-9]{32}$/);
    }
    const brokenPage = await broken.newPage(), bad = fixture.createVerification();
    await brokenPage.goto(bad.url);
    const badFrame = brokenPage.frameLocator('iframe[title="Verification"]');
    await expect(badFrame.locator("body")).toHaveAttribute("data-expected-stamp", bad.expectedStamp);
    await expect(badFrame.locator("html")).toHaveAttribute("data-stamp", "WRONG");
    expect(await badFrame.locator("html").getAttribute("data-stamp")).not.toBe(bad.expectedStamp);
    expect(fixture.evidence()).toEqual(before);
  } finally { await correct.close(); await broken.close(); await closeFixture(fixture); }
});

test("early, wrong, duplicate, or out-of-order activity cannot be repaired", async ({ request }) => {
  for (const mode of ["early", "wrong", "duplicate", "reversed"] as const) {
    const fixture = await userscriptFixture(17);
    try {
      const frameOrigin = fixture.origin.replace("127.0.0.1", "localhost");
      expect((await request.get(`${frameOrigin}/record/toString`)).status()).toBe(404);
      if (mode === "early") await request.post(`${fixture.origin}/submit`);
      const order = mode === "reversed" ? [names[1]!, names[0]!, ...names.slice(2)] : names;
      for (const name of order) {
        await request.get(`${frameOrigin}/record/${name}`);
        const evidence = fixture.evidence(), visit = evidence.visits.at(-1)!;
        const receipt = { name, documentId: visit.documentId, stamp: mode === "wrong" && name === "Atlas" ? "wrong" : evidence.expected[name] };
        await request.post(`${frameOrigin}/receipt`, { data: receipt });
        if (mode === "duplicate" && name === "Atlas") await request.post(`${frameOrigin}/receipt`, { data: receipt });
      }
      await request.post(`${fixture.origin}/submit`);
      expect(userscriptScore(fixture.evidence(), fixedRegistry(fixture), fixture.preset, true), mode).toBe(false);
    } finally { await closeFixture(fixture); }
  }
});

test("page or direct HTTP can forge execution receipts; registry evidence is separate, not anti-cheat", async ({ request }) => {
  const fixture = await userscriptFixture(17);
  try {
    const frameOrigin = fixture.origin.replace("127.0.0.1", "localhost");
    for (const name of names) {
      await request.get(`${frameOrigin}/record/${name}`);
      const evidence = fixture.evidence(), visit = evidence.visits.at(-1)!;
      expect((await request.post(`${frameOrigin}/receipt`, { data: { name, documentId: visit.documentId, stamp: evidence.expected[name] } })).status()).toBe(201);
    }
    expect((await request.post(`${fixture.origin}/submit`)).status()).toBe(201);
    const evidence = fixture.evidence();
    expect(userscriptScore(evidence, { registered: [], active: [], disabled: [fixture.preset.target, fixture.preset.decoy] }, fixture.preset, true)).toBe(false);
    // Forged requests can satisfy the judge only if registration and execution evidence are also fabricated.
    expect(userscriptScore(evidence, fixedRegistry(fixture), fixture.preset, true)).toBe(true);
  } finally { await closeFixture(fixture); }
});

test("opening the second document before the first stamp is recorded fails", async ({ request }) => {
  const fixture = await userscriptFixture(17);
  try {
    const frameOrigin = fixture.origin.replace("127.0.0.1", "localhost");
    await request.get(`${frameOrigin}/record/Atlas`);
    await request.get(`${frameOrigin}/record/Birch`);
    const evidence = fixture.evidence();
    for (const visit of evidence.visits) {
      await request.post(`${frameOrigin}/receipt`, { data: { name: visit.name, documentId: visit.documentId, stamp: evidence.expected[visit.name] } });
    }
    for (const name of names.slice(2)) {
      await request.get(`${frameOrigin}/record/${name}`);
      const latest = fixture.evidence(), visit = latest.visits.at(-1)!;
      await request.post(`${frameOrigin}/receipt`, { data: { name, documentId: visit.documentId, stamp: latest.expected[name] } });
    }
    expect((await request.post(`${fixture.origin}/submit`)).status()).toBe(400);
    expect(userscriptScore(fixture.evidence(), fixedRegistry(fixture), fixture.preset, true)).toBe(false);
  } finally { await closeFixture(fixture); }
});
