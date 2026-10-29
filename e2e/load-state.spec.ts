import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("waits for the root document instead of a child frame's load event", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const target = await opened.context.newPage();
    await target.route("**/load-state-root", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Root load</title><iframe id="child" src="about:blank"></iframe><img src="/held-load">' }));
    await target.route("**/held-load", async (route) => { await hold; await route.fulfill({ status: 204, body: "" }); });
    await target.route("**/child-load-state", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Child load</title>loaded" }));
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `await page.goto(${JSON.stringify(`${provider.origin}/load-state-root`)}); return await page.evaluate(() => document.readyState);` }, "navigate-root"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "interactive" }); return commandResponse("execute_program", { timeoutMs: 30_000, code: "await page.waitForLoadState('domcontentloaded'); return await page.evaluate(() => document.readyState);" }, "dom-ready"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "interactive" }); return commandResponse("execute_program", { timeoutMs: 30_000, code: "await page.waitForLoadState('load'); return await page.evaluate(() => document.readyState);" }, "root-ready"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "complete" }); return commandResponse("execute_program", { timeoutMs: 8000, code: "await page.evaluate(() => { location.hash = 'part'; }); await page.waitForLoadState('domcontentloaded'); return await page.url();" }, "hash-load"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: `${provider.origin}/load-state-root#part` }); return commandResponse("execute_program", { timeoutMs: 8000, code: "await page.goto('about:blank'); await page.waitForLoadState('load'); return await page.url();" }, "blank-load"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "about:blank" }); return commandResponse("execute_program", { timeoutMs: 8000, code: "await page.goto('about:blank#part'); return await page.url();" }, "blank-hash-denied"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining('Cannot access contents of url') } } }); return textResponse("ROOT_LOAD_STATE_OK"); },
      textResponse("页面加载检查"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("wait for the root document to load");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => provider.requests.filter((request) => Array.isArray(request.tools)).length).toBe(3);
    const crossOrigin = provider.origin.replace("127.0.0.1", "localhost");
    await target.evaluate((url) => { document.querySelector<HTMLIFrameElement>("#child")!.src = url; }, `${crossOrigin}/child-load-state`);
    await expect.poll(() => target.frames().map((frame) => frame.url())).toContain(`${crossOrigin}/child-load-state`);
    await target.frames().find((frame) => frame.url() === `${crossOrigin}/child-load-state`)!.waitForLoadState("load");
    await target.waitForTimeout(250);
    expect(await target.evaluate(() => document.readyState)).toBe("interactive");
    expect(provider.requests.filter((request) => Array.isArray(request.tools))).toHaveLength(3);
    release();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ROOT_LOAD_STATE_OK", { timeout: 45_000 });
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("waits for the new lifecycle when document.open reuses the loader", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const target = await opened.context.newPage();
    await target.route("**/held-document-script", async (route) => { await hold; await route.fulfill({ contentType: "application/javascript", body: "window.deferredFinished = true" }); });
    await target.goto(`${provider.origin}/automation`);
    const markup = `<!doctype html><title>Replacement</title><script>window.documentEvents=[];document.addEventListener('DOMContentLoaded',()=>window.documentEvents.push('DOMContentLoaded'));window.addEventListener('load',()=>window.documentEvents.push('load'));</script><script defer src="/held-document-script"></script><main>replacement</main>`;
    responses.push(
      commandResponse("execute_program", { timeoutMs: 15000, code: `await page.evaluate((markup) => { document.open(); document.write(markup); document.close(); }, ${JSON.stringify(markup)}); return 'rewritten';` }, "rewrite-document"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "rewritten" }); return commandResponse("execute_program", { timeoutMs: 30000, code: "await page.waitForLoadState('load'); return await page.evaluate(() => ({events: window.documentEvents, finished: window.deferredFinished}));" }, "rewritten-load"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { events: ["DOMContentLoaded", "load"], finished: true } }); return textResponse("DOCUMENT_REWRITE_LOAD_OK"); },
      textResponse("等待替换文档"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("wait for the rewritten document");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => provider.requests.filter((request) => Array.isArray(request.tools)).length).toBe(2);
    await expect(target).toHaveTitle("Replacement");
    expect(await target.evaluate(() => ({ state: document.readyState, events: (window as any).documentEvents, finished: (window as any).deferredFinished ?? null }))).toEqual({ state: "complete", events: [], finished: null });
    await target.waitForTimeout(250);
    expect(provider.requests.filter((request) => Array.isArray(request.tools))).toHaveLength(2);
    release();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DOCUMENT_REWRITE_LOAD_OK", { timeout: 45_000 });
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const scenario of ["already loaded", "document rewrite in progress"] as const) test(`reports unknown after late attach: ${scenario}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const target = await opened.context.newPage();
    await target.route("**/held-late-script", async (route) => { await hold; await route.fulfill({ contentType: "application/javascript", body: "window.deferredFinished = true" }); });
    await target.goto(`${provider.origin}/automation`);
    if (scenario === "document rewrite in progress") {
      await target.evaluate(() => { document.open(); document.write('<!doctype html><title>Late rewrite</title><script defer src="/held-late-script"></script>'); document.close(); });
      await expect(target).toHaveTitle("Late rewrite");
      expect(await target.evaluate(() => ({ ready: document.readyState, finished: (window as any).deferredFinished ?? null }))).toEqual({ ready: "complete", finished: null });
    }
    responses.push(
      commandResponse("execute_program", { timeoutMs: 8000, code: "await page.waitForLoadState('load'); return 'loaded';" }, "late-load"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining("load-state-unknown") } } }); return textResponse("LATE_LOAD_UNKNOWN_OK"); },
      textResponse("检查加载状态"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("check the current document load state");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LATE_LOAD_UNKNOWN_OK", { timeout: 25000 });
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
