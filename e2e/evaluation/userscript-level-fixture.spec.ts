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
    expect(userscriptScore(evidence, registry, fixture.preset)).toBe(true);
    expect(userscriptScore(evidence, { ...registry, registered: [] }, fixture.preset)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, active: [] }, fixture.preset)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, disabled: [] }, fixture.preset)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, registered: [{ ...registry.registered[0]!, allFrames: false }] }, fixture.preset)).toBe(false);
    expect(userscriptScore(evidence, { ...registry, disabled: [{ ...registry.disabled[0]!, js: [{ code: "changed" }] }] }, fixture.preset)).toBe(false);
    const { id, matches, allFrames, runAt, world, js } = fixture.preset.decoy;
    expect(userscriptScore(evidence, { ...registry, disabled: [{ allFrames, id, js, matches, runAt, world }] }, fixture.preset)).toBe(true);
    expect(userscriptScore(evidence, { ...registry, active: [{ ...registry.active[0]!, js: [{ code: "different" }] }] }, fixture.preset)).toBe(false);
    const alternate = { ...registry.registered[0]!, world: "USER_SCRIPT" as const, runAt: "document_idle" as const, matches: ["http://localhost/record/*"] };
    expect(userscriptScore(evidence, { ...registry, registered: [alternate], active: [structuredClone(alternate)] }, fixture.preset)).toBe(true);
  } finally { await context.close(); await closeFixture(fixture); }
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
      expect(userscriptScore(fixture.evidence(), fixedRegistry(fixture), fixture.preset), mode).toBe(false);
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
    expect(userscriptScore(evidence, { registered: [], active: [], disabled: [fixture.preset.target, fixture.preset.decoy] }, fixture.preset)).toBe(false);
    // If registry evidence itself is fabricated, forged requests can satisfy the judge.
    expect(userscriptScore(evidence, fixedRegistry(fixture), fixture.preset)).toBe(true);
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
    expect(userscriptScore(fixture.evidence(), fixedRegistry(fixture), fixture.preset)).toBe(false);
  } finally { await closeFixture(fixture); }
});
