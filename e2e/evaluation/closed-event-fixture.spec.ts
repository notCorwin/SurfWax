import { expect, test } from "@playwright/test";
import { closedEventFixture, closedEventScore, type ClosedEventFixture } from "./closed-event-fixture";

async function closeFixture(fixture: ClosedEventFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

for (const seed of [17, 72]) test(`collects the complete audit log before the source window closes (seed ${seed})`, async ({ page }) => {
  const fixture = await closedEventFixture(seed);
  try {
    await page.goto(fixture.origin);
    const popupWaiting = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open source" }).click();
    const source = await popupWaiting;
    const messages: string[] = [];
    source.on("console", (message) => messages.push(message.text()));
    await source.getByRole("button", { name: "Generate audit log" }).click();
    await expect(source.locator("#status")).toHaveText("Ready to close");
    await expect.poll(() => messages.length).toBe(189);
    const codes = messages.filter((message) => message.startsWith("AUDIT ")).map((message) => message.slice(6));
    expect(codes).toEqual(fixture.evidence().expectedCodes);
    expect(new Set(codes).size).toBe(180);
    expect(messages.filter((message) => message.startsWith("HEARTBEAT "))).toHaveLength(9);
    const closed = source.waitForEvent("close");
    await source.getByRole("button", { name: "Close source" }).click();
    await closed;
    expect(source.isClosed()).toBe(true);
    const destination = page.frameLocator('iframe[title="Destination"]');
    await destination.getByLabel("Audit codes").fill(codes.join("\n"));
    await destination.getByRole("button", { name: "Submit audit" }).click();
    await expect(destination.locator("#status")).toHaveText("Submitted");
    expect(closedEventScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});

test("early, missing, reordered or duplicate submissions cannot be repaired", async ({ request }) => {
  for (const mode of ["early", "missing", "reordered", "duplicate"] as const) {
    const fixture = await closedEventFixture(17);
    try {
      const codes = fixture.evidence().expectedCodes;
      if (mode === "early") {
        expect((await request.post(`${fixture.origin}/submit`, { data: { codes: codes.join("\n") } })).status()).toBe(400);
        expect((await request.get(`${fixture.origin}/source`)).status()).toBe(200);
        expect((await request.post(`${fixture.origin}/generated`, { data: { count: 180 } })).status()).toBe(409);
        expect((await request.post(`${fixture.origin}/close-source`)).status()).toBe(409);
        expect((await request.post(`${fixture.origin}/submit`, { data: { codes: codes.join("\n") } })).status()).toBe(400);
        expect(closedEventScore(fixture.evidence())).toBe(false);
        continue;
      }
      expect((await request.get(`${fixture.origin}/source`)).status()).toBe(200);
      expect((await request.post(`${fixture.origin}/generated`, { data: { count: 180 } })).status()).toBe(201);
      expect((await request.post(`${fixture.origin}/close-source`)).status()).toBe(204);
      const input = mode === "missing" ? codes.slice(1) : mode === "reordered" ? [codes[1]!, codes[0]!, ...codes.slice(2)] : codes;
      const first = await request.post(`${fixture.origin}/submit`, { data: { codes: input.join("\n") } });
      if (mode === "missing" || mode === "reordered") expect(first.status()).toBe(400);
      if (mode === "duplicate") expect(first.status()).toBe(201);
      expect((await request.post(`${fixture.origin}/submit`, { data: { codes: codes.join("\n") } })).status()).toBe(400);
      expect(closedEventScore(fixture.evidence()), mode).toBe(false);
    } finally { await closeFixture(fixture); }
  }
});

test("direct HTTP can forge source actions and is not proof of event capture or window closure", async ({ request }) => {
  const fixture = await closedEventFixture(72);
  try {
    await request.get(`${fixture.origin}/source`);
    expect((await request.post(`${fixture.origin}/generated`, { data: { count: 180 } })).status()).toBe(201);
    expect((await request.post(`${fixture.origin}/close-source`)).status()).toBe(204);
    expect((await request.post(`${fixture.origin}/submit`, { data: { codes: fixture.evidence().expectedCodes.join("\n") } })).status()).toBe(201);
    expect(closedEventScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});
