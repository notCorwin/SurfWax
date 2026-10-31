import { expect, type Page } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "../fixtures";
import { pointerFixture, pointerInteractionScore, pointerScore } from "./pointer-fixture";

async function drag(page: Page, parcel: string, dock: string) {
  const desk = page.frameLocator('iframe[title="Loading desk"]');
  const source = desk.getByRole("button", { name: parcel, exact: true });
  const target = desk.getByRole("button", { name: dock, exact: true });
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox();
  if (!start) throw new Error("Missing parcel geometry");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2);
  await target.scrollIntoViewIfNeeded();
  const end = await target.boundingBox();
  if (!end) throw new Error("Missing dock geometry");
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/drop");
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.up();
  return (await response).status();
}

for (const seed of [17, 72]) test(`drags across a nested scroll area in a cross-origin frame (seed ${seed})`, async ({ page }) => {
  const fixture = await pointerFixture(seed);
  try {
    await page.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    expect(pointerScore(fixture.evidence())).toBe(false);
    expect(await drag(page, expected.parcel, expected.dock)).toBe(201);
    await expect(page.frameLocator('iframe[title="Loading desk"]').locator("#status")).toHaveText("Parcel delivered");
    expect(pointerScore(fixture.evidence())).toBe(true);
    expect(pointerInteractionScore(fixture.evidence())).toBe(true);
    const witness = fixture.evidence().attempts[0]!.witness as { startScroll: number; endScroll: number };
    expect(witness.endScroll - witness.startScroll).toBeGreaterThan(100);
    expect((await page.request.post(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an incorrect drop and a later correct drop cannot pass", async ({ page }) => {
  const fixture = await pointerFixture(17);
  try {
    await page.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    expect(await drag(page, expected.parcel, "Dock-17-B")).toBe(400);
    expect(await drag(page, expected.parcel, expected.dock)).toBe(201);
    expect(fixture.evidence().attempts.map((attempt) => attempt.accepted)).toEqual([false, true]);
    expect(pointerScore(fixture.evidence())).toBe(false);
    expect(pointerInteractionScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("duplicate drops and direct submission do not establish a single observed interaction", async ({ page }) => {
  const duplicate = await pointerFixture(72);
  const direct = await pointerFixture(17);
  try {
    await page.goto(duplicate.origin);
    const expected = duplicate.evidence().expected;
    expect(await drag(page, expected.parcel, expected.dock)).toBe(201);
    expect(await drag(page, expected.parcel, expected.dock)).toBe(201);
    expect(pointerScore(duplicate.evidence())).toBe(false);
    expect(pointerInteractionScore(duplicate.evidence())).toBe(false);

    const response = await page.request.post(`${direct.origin}/drop`, { data: { ...direct.evidence().expected, witness: null } });
    expect(response.status()).toBe(201);
    expect(pointerScore(direct.evidence())).toBe(true);
    expect(pointerInteractionScore(direct.evidence())).toBe(false);
  } finally {
    await Promise.all([duplicate, direct].map((fixture) => new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))));
  }
});

test("extension drag tool can perform the cross-origin nested-scroll level", async () => {
  test.setTimeout(90_000);
  const fixture = await pointerFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    const frame = { by: "css", value: 'iframe[title="Loading desk"]' };
    const source = { by: "role", value: "button", name: expected.parcel, exact: true, frame };
    const destination = { by: "role", value: "button", name: expected.dock, exact: true, frame };
    let result: any;
    responses.push(commandResponse("drag", { source, destination, timeoutMs: 30_000 }, "pointer-drag"),
      (request) => {
        result = JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
        return textResponse("POINTER_TOOL_FINISHED");
      }, textResponse("Freight"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("POINTER_TOOL_FINISHED", { timeout: 60_000 });
    expect(result).toMatchObject({ ok: true });
    await expect.poll(() => pointerScore(fixture.evidence())).toBe(true);
    expect(pointerInteractionScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
