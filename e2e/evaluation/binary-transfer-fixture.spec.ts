import { expect, test, type BrowserContext } from "@playwright/test";
import { binaryTransferFixture, binaryTransferScore, type BinaryTransferFixture } from "./binary-transfer-fixture";

async function closeFixture(fixture: BinaryTransferFixture) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
}

async function generate(context: BrowserContext, fixture: BinaryTransferFixture) {
  const page = await context.newPage();
  await page.goto(fixture.origin);
  const source = page.frameLocator('iframe[title="Source"]');
  await source.getByRole("button", { name: "Generate file" }).click();
  await expect(source.locator("#status")).toHaveText("Ready");
  const anchor = source.locator("#file");
  const url = await anchor.getAttribute("href");
  const base64 = await anchor.evaluate(async (element) => {
    const bytes = new Uint8Array(await (await fetch((element as HTMLAnchorElement).href)).arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(binary);
  });
  return { page, url, base64 };
}

for (const seed of [17, 72]) test(`preserves the complete browser-generated binary across origins (seed ${seed})`, async ({ browser, request }) => {
  const fixture = await binaryTransferFixture(seed), context = await browser.newContext();
  try {
    const { page, url, base64 } = await generate(context, fixture);
    const bytes = Buffer.from(base64, "base64"), expected = fixture.evidence().expected;
    expect(url).toMatch(/^blob:http:\/\/localhost:/);
    expect(bytes.length).toBe(65_539);
    expect([...bytes.subarray(0, 5)]).toEqual([0, 255, 128, 13, 10]);
    expect((await request.get(`${fixture.origin}/sample-${seed}.bin`)).status()).toBe(404);
    const destination = page.frameLocator('iframe[title="Destination"]');
    await destination.locator('#file').setInputFiles({ name: expected.name, mimeType: "application/octet-stream", buffer: bytes });
    await expect(destination.locator('#chosen')).toHaveText(expected.name);
    await destination.getByRole("button", { name: "Submit file" }).click();
    await expect(destination.locator('#status')).toHaveText("Submitted");
    expect(binaryTransferScore(fixture.evidence())).toBe(true);
    expect(fixture.evidence().uploads[0]).toMatchObject({ name: expected.name, bytes: expected.bytes, sha256: expected.sha256, accepted: true, generatedBefore: 1 });
  } finally { await context.close(); await closeFixture(fixture); }
});

test("premature, corrupt, malformed, and duplicate uploads cannot be repaired", async ({ browser, request }) => {
  for (const mode of ["premature", "corrupt", "malformed", "duplicate"] as const) {
    const fixture = await binaryTransferFixture(17), context = await browser.newContext();
    try {
      const name = fixture.evidence().expected.name;
      if (mode === "premature") expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64: "AA==" } })).status()).toBe(400);
      const { base64 } = await generate(context, fixture);
      const original = Buffer.from(base64, "base64");
      if (mode === "corrupt") {
        const corrupt = Buffer.from(original); corrupt[32_768] = corrupt[32_768]! ^ 1;
        expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64: corrupt.toString("base64") } })).status()).toBe(400);
      }
      if (mode === "malformed") expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64: "invalid-base64" } })).status()).toBe(400);
      const first = await request.post(`${fixture.origin}/upload`, { data: { name, base64 } });
      expect(first.status()).toBe(mode === "duplicate" ? 201 : 400);
      if (mode === "duplicate") expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64 } })).status()).toBe(400);
      expect(binaryTransferScore(fixture.evidence()), mode).toBe(false);
      expect(fixture.evidence().uploads).toHaveLength(2);
    } finally { await context.close(); await closeFixture(fixture); }
  }
});

test("duplicate source generations cannot be repaired by a correct upload", async ({ browser, request }) => {
  const fixture = await binaryTransferFixture(72), context = await browser.newContext();
  try {
    const { base64 } = await generate(context, fixture), name = fixture.evidence().expected.name;
    expect((await request.post(`${fixture.origin}/generated`, { data: { name } })).status()).toBe(409);
    expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64 } })).status()).toBe(400);
    expect(binaryTransferScore(fixture.evidence())).toBe(false);
  } finally { await context.close(); await closeFixture(fixture); }
});

test("source and upload HTTP evidence can be forged and is not anti-cheat", async ({ request }) => {
  const seed = 17, fixture = await binaryTransferFixture(seed);
  try {
    // A client that knows the fixture's algorithm can forge both requests.
    let state = (seed ^ 0x79bde41f) >>> 0; const bytes = Buffer.alloc(65_539);
    for (let index = 0; index < bytes.length; index++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; bytes[index] = state >>> 24; }
    bytes.set([0, 255, 128, 13, 10], 0);
    const name = fixture.evidence().expected.name;
    expect((await request.post(`${fixture.origin}/generated`, { data: { name } })).status()).toBe(201);
    expect((await request.post(`${fixture.origin}/upload`, { data: { name, base64: bytes.toString("base64") } })).status()).toBe(201);
    expect(binaryTransferScore(fixture.evidence())).toBe(true);
  } finally { await closeFixture(fixture); }
});
