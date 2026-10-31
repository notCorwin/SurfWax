import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { trackFixtureRequests } from "./network-quiescence";

async function fixtureServer() {
  let submitted!: () => void;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => { submitted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (path === "/submit") {
      submitted();
      await held;
      response.writeHead(200).end("saved");
    } else if (path === "/fail") {
      request.socket.destroy();
    } else if (path === "/popup") {
      response.writeHead(200, { "content-type": "text/html" }).end("<script>fetch('/submit', {method:'POST'})</script>Popup");
    } else {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      response.writeHead(200, { "content-type": "text/html" }).end(`<button onclick="window.open('http://localhost:${address.port}/popup')">Open</button>`);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return { server, origin: `http://127.0.0.1:${address.port}`, popupOrigin: `http://localhost:${address.port}`, observed, release };
}

test("waits for a popup's delayed submission even while the original page is idle", async ({ context, page }) => {
  const fixture = await fixtureServer();
  const tracker = trackFixtureRequests(context, [fixture.origin, fixture.popupOrigin]);
  try {
    await page.goto(fixture.origin);
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open" }).click();
    await popup;
    await fixture.observed;
    await page.waitForLoadState("networkidle");
    const waiting = tracker.wait({ quietMs: 100, timeoutMs: 3000 });
    expect(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve("pending"), 150))])).toBe("pending");
    fixture.release();
    expect(await waiting).toBe(true);
  } finally {
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("times out on in-flight requests and treats failed requests as settled", async ({ context, page }) => {
  const fixture = await fixtureServer();
  const tracker = trackFixtureRequests(context, [fixture.origin]);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => { void fetch('/submit', { method: 'POST' }).catch(() => {}); });
    await fixture.observed;
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 100 })).toBe(false);
    fixture.release();
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toBe(true);
    await page.evaluate(() => fetch('/fail').catch(() => {}));
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toBe(true);
    expect(await tracker.wait({ quietMs: 100, timeoutMs: 5 })).toBe(false);
  } finally {
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("dispose removes listeners and resolves active waiters without claiming success", async ({ context, page }) => {
  const fixture = await fixtureServer();
  const eventNames = ["request", "requestfinished", "requestfailed"] as const;
  const emitter = context as unknown as { listenerCount(event: string): number };
  const before = eventNames.map((name) => emitter.listenerCount(name));
  const tracker = trackFixtureRequests(context, [fixture.origin]);
  try {
    expect(eventNames.map((name) => emitter.listenerCount(name))).toEqual(before.map((count) => count + 1));
    await page.goto(fixture.origin);
    const response = page.waitForResponse((item) => item.url().endsWith("/submit"));
    await page.evaluate(() => { void fetch('/submit', { method: 'POST' }).catch(() => {}); });
    await fixture.observed;
    const waiting = tracker.wait({ quietMs: 25, timeoutMs: 2000 });
    tracker.dispose();
    expect(await waiting).toBe(false);
    expect(await tracker.wait({ quietMs: 0, timeoutMs: 0 })).toBe(false);
    expect(eventNames.map((name) => emitter.listenerCount(name))).toEqual(before);
    fixture.release();
    await response;
  } finally {
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
