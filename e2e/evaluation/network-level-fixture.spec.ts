import { expect, test, type APIRequestContext, type Response } from "@playwright/test";
import { networkFixture, networkScore, type NetworkFixture } from "./network-level-fixture";

async function close(fixture: NetworkFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

/** Drive the public HTTP protocol directly to exercise the judge's limitations. */
async function runDirect(request: APIRequestContext, fixture: NetworkFixture, extraErrors = false) {
  const names = fixture.evidence().names;
  const pending = names.map((name) => request.post(`${fixture.origin}/sample`, { data: { name } }));
  const codes = new Map<string, string>();
  for (const [index, name] of [...names].reverse().entries()) {
    const response = await pending[names.indexOf(name)]!;
    expect(response.status()).toBe(200);
    const value = await response.json();
    expect(value.name).toBe(name);
    codes.set(name, value.code);
    if (extraErrors && index === 0) {
      expect((await request.post(`${fixture.origin}/sample`, { data: { name } })).status()).toBe(409);
      expect((await request.post(`${fixture.origin}/sample`, { data: "not-json" })).status()).toBe(400);
      expect((await request.post(`${fixture.origin}/ack`, { data: { ...value, code: "wrong" } })).status()).toBe(409);
    }
    expect((await request.post(`${fixture.origin}/ack`, { data: value })).status()).toBe(204);
  }
  return names.map((name) => codes.get(name)!);
}

for (const seed of [17, 72]) test(`matches concurrent same-URL responses by name rather than completion order (seed ${seed})`, async ({ page }) => {
  const fixture = await networkFixture(seed);
  try {
    const captures: Array<{ response: Response; body: Promise<{ name: string; code: string }> }> = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/sample" && response.request().method() === "POST") {
        captures.push({ response, body: response.json() });
      }
    });
    await page.goto(fixture.origin);
    const desk = page.frameLocator('iframe[title="Response desk"]');
    await desk.locator("#notice").evaluate((node) => { node.textContent = "Codes submitted"; });
    expect(networkScore(fixture.evidence())).toBe(false);
    await desk.getByRole("button", { name: "Run requests" }).click();
    await expect(desk.locator("#state")).toHaveText("Responses ready");
    expect(captures).toHaveLength(6);
    const bodies = await Promise.all(captures.map(async ({ response, body }) => ({ response, data: await body })));
    expect(new Set(bodies.map(({ response }) => response.url())).size).toBe(1);
    expect(bodies.map(({ data }) => data.name)).toEqual([...fixture.evidence().names].reverse());
    for (const { response, data } of bodies) expect(response.request().postDataJSON()).toEqual({ name: data.name });
    const codeByName = new Map(bodies.map(({ data }) => [data.name, data.code]));
    for (const name of fixture.evidence().names) await desk.getByLabel(`${name} code`, { exact: true }).fill(codeByName.get(name)!);
    await desk.getByRole("button", { name: "Submit codes" }).click();
    await expect(desk.locator("#notice")).toHaveText("Codes submitted");
    expect(networkScore(fixture.evidence())).toBe(true);
    expect(networkScore({ ...fixture.evidence(), responses: [...fixture.evidence().responses].reverse() })).toBe(false);
    expect((await page.request.get(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally { await close(fixture); }
});

test("mixed, missing, reordered, malformed and duplicate submissions remain failures", async ({ request }) => {
  const fixture = await networkFixture(17);
  try {
    const values = await runDirect(request, fixture);
    const mixed = [...values]; [mixed[0], mixed[1]] = [mixed[1]!, mixed[0]!];
    for (const incorrect of [mixed, values.slice(1), [...values].reverse(), [...values, values[0]!]]) {
      expect((await request.post(`${fixture.origin}/submit`, { data: { values: incorrect } })).status()).toBe(400);
      expect(networkScore(fixture.evidence())).toBe(false);
    }
    expect((await request.post(`${fixture.origin}/submit`, { data: "not-json" })).status()).toBe(400);
    expect((await request.post(`${fixture.origin}/submit`, { data: { values } })).status()).toBe(201);
    expect(fixture.evidence().submissions).toHaveLength(6);
    expect(networkScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("duplicate requests and invalid acknowledgements cannot be repaired by a correct submit", async ({ request }) => {
  const fixture = await networkFixture(72);
  try {
    const values = await runDirect(request, fixture, true);
    expect((await request.post(`${fixture.origin}/submit`, { data: { values } })).status()).toBe(201);
    expect(fixture.evidence().requests.filter((item) => !item.accepted)).toHaveLength(2);
    expect(fixture.evidence().acknowledgements.filter((item) => !item.accepted)).toHaveLength(1);
    expect(networkScore(fixture.evidence())).toBe(false);
  } finally { await close(fixture); }
});

test("an early submission is not repaired by later reads, and direct HTTP can otherwise satisfy the judge", async ({ request }) => {
  const early = await networkFixture(17), direct = await networkFixture(17);
  try {
    const values = direct.evidence().expectedCodes;
    expect((await request.post(`${early.origin}/submit`, { data: { values } })).status()).toBe(201);
    await runDirect(request, early);
    expect(networkScore(early.evidence())).toBe(false);
    expect(early.evidence().submissions[0]).toMatchObject({ requestsBefore: 0, responsesBefore: 0, acknowledgementsBefore: 0 });
    // Request and business ledgers alone do not prove UI or a specific tool path.
    expect(await runDirect(request, direct)).toEqual(values);
    expect((await request.post(`${direct.origin}/submit`, { data: { values } })).status()).toBe(201);
    expect(networkScore(direct.evidence())).toBe(true);
    expect((await request.post(`${direct.origin}/submit`, { data: { values } })).status()).toBe(201);
    expect(networkScore(direct.evidence())).toBe(false);
  } finally { await Promise.all([close(early), close(direct)]); }
});
