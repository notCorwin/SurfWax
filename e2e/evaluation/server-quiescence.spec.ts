import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { trackServerResponses } from "./server-quiescence";
import { trackFixtureRequests } from "./network-quiescence";
import { waitForEvaluationQuiescence } from "./quiescence";

async function fixtureServer() {
  let notifyStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/attachment") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="payload.bin"' });
      response.write("first-");
      notifyStarted();
      await held;
      if (!response.destroyed) response.end("second");
    } else if (request.url === "/write" && request.method === "POST") {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      response.writeHead(200).end(Buffer.concat(parts));
    } else if (request.url === "/early" && request.method === "POST") {
      response.writeHead(200).end("early response");
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end('<a href="/attachment" download>Download</a>');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return { server, origin: `http://127.0.0.1:${address.port}`, started, release };
}

test("an in-flight browser download remains active until the response finishes", async ({ page }) => {
  const fixture = await fixtureServer();
  const tracker = trackServerResponses(fixture.server, (request) => request.url === "/attachment");
  const browserTracker = trackFixtureRequests(page.context(), [fixture.origin]);
  try {
    await page.goto(fixture.origin);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download" }).click();
    await fixture.started;
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 100 })).toEqual({ settled: false, active: 1, finished: 0, interrupted: 0 });
    expect(await browserTracker.wait({ quietMs: 25, timeoutMs: 1000 })).toBe(true);
    expect((await waitForEvaluationQuiescence(browserTracker, tracker, 25, 100)).settled).toBe(false);
    fixture.release();
    const download = await downloadPromise;
    expect(await readFile(await download.path(), "utf8")).toBe("first-second");
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toEqual({ settled: true, active: 0, finished: 1, interrupted: 0 });
    expect((await waitForEvaluationQuiescence(browserTracker, tracker, 25, 2000)).settled).toBe(true);
  } finally {
    fixture.release();
    tracker.dispose();
    browserTracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an early response does not hide an incomplete request body", async () => {
  const fixture = await fixtureServer();
  const tracker = trackServerResponses(fixture.server);
  const address = fixture.server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const socket = createConnection(address.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const response = new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.write("POST /early HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\na");
    await response;
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 100 })).toEqual({ settled: false, active: 1, finished: 0, interrupted: 0 });
    socket.write("bcd");
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toEqual({ settled: true, active: 0, finished: 1, interrupted: 0 });
  } finally {
    socket.destroy();
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a cancelled partial download is recorded as interrupted without preventing later quiet", async ({ browser }) => {
  const fixture = await fixtureServer();
  const tracker = trackServerResponses(fixture.server, (request) => request.url === "/attachment");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(fixture.origin);
    await page.getByRole("link", { name: "Download" }).click();
    await fixture.started;
    await context.close();
    await expect.poll(() => tracker.snapshot()).toEqual({ active: 0, finished: 0, interrupted: 1 });
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toEqual({ settled: true, active: 0, finished: 0, interrupted: 1 });
  } finally {
    await context.close();
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("tracks normal request bodies and cleans up listeners and waiters", async ({ request }) => {
  const fixture = await fixtureServer();
  const baseline = fixture.server.listenerCount("request");
  const tracker = trackServerResponses(fixture.server);
  try {
    expect(fixture.server.listenerCount("request")).toBe(baseline + 1);
    const result = await request.post(`${fixture.origin}/write`, { data: "one write" });
    expect(await result.text()).toBe("one write");
    expect(await tracker.wait({ quietMs: 25, timeoutMs: 2000 })).toEqual({ settled: true, active: 0, finished: 1, interrupted: 0 });
    const waiting = tracker.wait({ quietMs: 1000, timeoutMs: 2000 });
    tracker.dispose();
    expect(await waiting).toEqual({ settled: false, active: 0, finished: 1, interrupted: 0 });
    expect(fixture.server.listenerCount("request")).toBe(baseline);
  } finally {
    fixture.release();
    tracker.dispose();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
