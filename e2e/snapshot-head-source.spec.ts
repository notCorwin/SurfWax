import { expect, type Page } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";
import { itemLine, inspectText } from "./snapshot-format";

test.use({ screenshot: "off", trace: "off" });
const url = "http://snapshot-head-source.test/";
const ordinary = `<!doctype html><meta charset="utf-8"><style>body{margin:0;color:black;background:white;font:20px Arial}</style><script id="source" type="application/json">{}</script><body><button>First</button><button>Second</button>`;

async function attach(panel: Page) {
  const origin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!origin) throw new Error("Snapshot regression requires the development extension server");
  await panel.waitForLoadState("networkidle");
  await panel.evaluate(async ({ origin, url }) => {
    const { AutomationRuntime } = await import(`${origin}/src/chrome/automation.ts`);
    const { SNAPSHOT_COMPUTED_STYLES } = await import(`${origin}/src/chrome/snapshot-visibility.ts`);
    const { sameDOMSnapshot, hasUnrenderedHeadSourceChange } = await import(`${origin}/src/chrome/snapshot-consistency.ts`);
    const tabId = (await chrome.tabs.query({ url }))[0]?.id;
    if (tabId === undefined) throw new Error("Target tab is missing");
    await chrome.debugger.attach({ tabId }, "1.3");
    const state: any = { tabId, churn: false, turn: 0, profiles: [], catalogReads: 0, compact: SNAPSHOT_COMPUTED_STYLES,
      sameDOMSnapshot, hasUnrenderedHeadSourceChange };
    const api = { ...chrome, scripting: { ...chrome.scripting, executeScript: async (options: any) => {
      const result = await chrome.scripting.executeScript(options);
      if (Array.isArray(result[0]?.result)) state.catalogReads++;
      return result;
    } } };
    state.runtime = new AutomationRuntime({ chromeApi: api,
      command: async (source: chrome.debugger.Debuggee, method: string, params: any) => {
        const value = await chrome.debugger.sendCommand(source, method, params);
        if (method === "DOMSnapshot.captureSnapshot") {
          state.profiles.push(params.computedStyles);
          if (state.churn) await chrome.debugger.sendCommand(source, "Runtime.evaluate", { expression: `{
            const previous=document.querySelector('#source'), next=document.createElement('script');
            next.id='source';next.type='application/json';next.textContent=${JSON.stringify(String(++state.turn))};previous.replaceWith(next);
          }${state.afterCapture ?? ""}` });
        }
        return value;
      }, pressChord: async () => { throw new Error("Snapshot cannot send input"); },
      detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source),
    });
    state.event = (source: chrome.debugger.Debuggee, method: string, params: any) => state.runtime.handleEvent(source, method, params);
    chrome.debugger.onEvent.addListener(state.event);
    state.runtime.setContext({ signal: AbortSignal.timeout(45_000) });
    (globalThis as any).__headSource = state;
  }, { origin, url });
}
async function inspect(panel: Page, options: Record<string, unknown> = {}, region?: any): Promise<any> {
  return panel.evaluate(async ({ options, region }) => {
    const state = (globalThis as any).__headSource;
    return state.runtime.inspect(state.tabId, { budget: 100_000, ...options }, region);
  }, { options, region });
}
async function detach(panel: Page) {
  await panel.evaluate(async () => {
    const state = (globalThis as any).__headSource;
    if (!state) return;
    await state.runtime.abortSessions(); chrome.debugger.onEvent.removeListener(state.event);
    delete (globalThis as any).__headSource;
  });
}

test("HEAD source churn upgrades the capture once and preserves geometry profiles and document invalidation", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: ordinary }));
    const target = await opened.context.newPage(); await target.goto(url);
    await attach(opened.page);
    await opened.page.evaluate(() => { (globalThis as any).__headSource.churn = true; });
    const first = await inspect(opened.page);
    expect(first.partial).toBeUndefined();
    expect(inspectText(first.items)).toContain('"First"');
    const sizes = await opened.page.evaluate(() => {
      const state = (globalThis as any).__headSource; state.churn = false;
      return { compact: state.compact.length, lengths: state.profiles.map((profile: string[]) => profile.length), catalogReads: state.catalogReads };
    });
    expect(sizes.lengths[0]).toBe(sizes.compact);
    expect(sizes.lengths.some((length: number) => length > sizes.compact)).toBe(true);
    expect(sizes.catalogReads).toBe(1);

    const referencePage = await inspect(opened.page, { fields: ["text", "state"], limit: 1 });
    expect(referencePage.nextCursor).toEqual(expect.any(String));
    const next = await inspect(opened.page, { cursor: referencePage.nextCursor });
    expect(next.observationId).toBe(referencePage.observationId);
    expect(next.items.some((item: any) => item.id)).toBe(true);
    const latest = await opened.page.evaluate(() => (globalThis as any).__headSource.profiles.at(-1).length);
    expect(latest).toBeGreaterThan(sizes.compact);

    await target.reload();
    const beforeReload = await opened.page.evaluate(() => (globalThis as any).__headSource.profiles.length);
    const fresh = await inspect(opened.page);
    expect(fresh.documentId).toBeGreaterThan(first.documentId);
    const reloaded = await opened.page.evaluate((start) => (globalThis as any).__headSource.profiles.slice(start).map((profile: string[]) => profile.length), beforeReload);
    expect(reloaded.every((length: number) => length === sizes.compact)).toBe(true);
    await expect(inspect(opened.page, { cursor: referencePage.nextCursor })).rejects.toThrow("stale-observation");

    await opened.page.evaluate(() => { (globalThis as any).__headSource.churn = true; });
    expect((await inspect(opened.page)).partial).toBeUndefined();
    expect(await opened.page.evaluate(() => (globalThis as any).__headSource.catalogReads)).toBe(1);
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});

test("unchanged AX and compact styles cannot justify HEAD relaxation when unseen paint properties change", async () => {
  const opened = await openExtension();
  try {
    const markup = ordinary.replace("</style>", 'html:has(head script[src="/black.js"]) body{background-image:linear-gradient(black,black)}</style>');
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: markup }));
    const target = await opened.context.newPage(); await target.goto(url); await attach(opened.page);
    const result = await opened.page.evaluate(async () => {
      const state = (globalThis as any).__headSource, source = { tabId: state.tabId };
      const catalog = await state.runtime.snapshotCompleteStyleCatalog({ tabId: state.tabId });
      const read = async (styles: string[]) => chrome.debugger.sendCommand(source, "DOMSnapshot.captureSnapshot", { computedStyles: [...styles], includeDOMRects: true, includePaintOrder: true });
      const compactA = await read(state.compact), fullA = await read(catalog), axA = await chrome.debugger.sendCommand(source, "Accessibility.getFullAXTree");
      await chrome.debugger.sendCommand(source, "Runtime.evaluate", { expression: "document.querySelector('#source').setAttribute('src','/black.js')" });
      const compactB = await read(state.compact), fullB = await read(catalog), axB = await chrome.debugger.sendCommand(source, "Accessibility.getFullAXTree");
      const options = { ignoreUnrenderedText: true, completeStyleCatalog: catalog };
      return { axSame: JSON.stringify(axA) === JSON.stringify(axB), candidate: state.hasUnrenderedHeadSourceChange(compactA, compactB),
        compact: state.sameDOMSnapshot(compactA, compactB, undefined, { ignoreUnrenderedText: true }),
        complete: state.sameDOMSnapshot(fullA, fullB, undefined, options), stable: state.sameDOMSnapshot(fullA, fullA, undefined, options),
        catalogSize: catalog.length, compactSize: state.compact.length };
    });
    expect(result.axSame).toBe(true);
    expect(result.candidate).toBe(true);
    expect(result.compact).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.stable).toBe(true);
    expect(result.catalogSize).toBeGreaterThan(result.compactSize);
    expect(await target.evaluate(() => getComputedStyle(document.body).backgroundImage)).toContain("linear-gradient");
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});

for (const kind of ["selection", "svg-resource"] as const) test(`HEAD relaxation refuses stale ${kind} paint outside layout style rows`, async () => {
  const opened = await openExtension();
  try {
    const extra = kind === "selection"
      ? `<style>#secret{color:transparent}#secret::selection{color:black}html:has(head script[data-clear]) #secret::selection{color:transparent}</style><p id="secret">SECRET</p>`
      : `<style>html:has(head script[data-clear]) stop{stop-opacity:0}</style><svg width="240" height="60"><defs><linearGradient id="ink"><stop stop-color="black"/><stop offset="1" stop-color="black"/></linearGradient></defs><text y="30" fill="url(#ink)">GHOST</text></svg>`;
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: ordinary + extra }));
    const target = await opened.context.newPage(); await target.goto(url); await attach(opened.page);
    if (kind === "selection") await target.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector("#secret")!);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await opened.page.evaluate(() => {
      const state = (globalThis as any).__headSource; state.churn = true;
      state.afterCapture = "document.querySelector('#source').setAttribute('data-clear','');";
    });
    const result = await inspect(opened.page);
    expect(result.partial).toBe(true);
    const text = inspectText(result.items);
    expect(text).toContain("First");
    expect(text).not.toContain(kind === "selection" ? "SECRET" : "GHOST");
    if (kind === "selection") expect(await target.locator("#secret").evaluate((node) => getComputedStyle(node, "::selection").color)).toBe("rgba(0, 0, 0, 0)");
    else expect(await target.locator("stop").first().evaluate((node) => getComputedStyle(node).stopOpacity)).toBe("0");
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});

test("scoped HEAD proof preserves original frame edges after excluding a sibling document", async () => {
  const opened = await openExtension();
  try {
    const grand = `<button>Grandchild target</button>`;
    const child = `<button>Child target</button><iframe srcdoc="${grand.replaceAll('"', '&quot;')}"></iframe>`;
    const markup = ordinary + `<iframe srcdoc="<button>Unrelated sibling</button>"></iframe><section id="region"><iframe srcdoc="${child.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></section>`;
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: markup }));
    const target = await opened.context.newPage(); await target.goto(url); await attach(opened.page);
    await opened.page.evaluate(() => { (globalThis as any).__headSource.churn = true; });
    const result = await inspect(opened.page, {}, { queries: [{ kind: "css", value: "#region" }] });
    expect(result.partial).toBeUndefined();
    const text = inspectText(result.items);
    expect(text).toContain("Child target"); expect(text).toContain("Grandchild target");
    expect(text).not.toContain("Unrelated sibling");
    expect(await opened.page.evaluate(() => (globalThis as any).__headSource.profiles.some((row: string[]) => row.length > (globalThis as any).__headSource.compact.length))).toBe(true);
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});

test("equal captured colors retain unknown geometry without claiming invisible labels or deleting ambiguous paint", async () => {
  const opened = await openExtension();
  try {
    const markup = ordinary + `<p style="color:white">WHITE_ON_WHITE</p><button style="color:white;background:white">UNKNOWN_CONTROL</button>
      <p style="color:white;background-image:linear-gradient(black,black)">VISIBLE_ON_IMAGE</p>
      <div style="background:black"><p style="color:white">VISIBLE_ON_NEAR_BACKGROUND</p></div>
      <p style="color:color(display-p3 1 0 0);background:color(display-p3 1 0 0)">WIDE_GAMUT_SAME_COLOR</p>`;
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: markup }));
    const target = await opened.context.newPage(); await target.goto(url); await attach(opened.page);
    const result = await inspect(opened.page, { fields: ["text", "state"] });
    expect(result.partial).toBe(true); expect(result.limitations).toContain("composited visibility");
    const text = inspectText(result.items);
    for (const unconfirmed of ["WHITE_ON_WHITE", "UNKNOWN_CONTROL", "VISIBLE_ON_IMAGE", "WIDE_GAMUT_SAME_COLOR"]) expect(text).not.toContain(unconfirmed);
    expect(text).toContain("VISIBLE_ON_NEAR_BACKGROUND");
    expect(text).toContain("First");
    const unknown = result.items.filter((item: any) => itemLine(item).includes("[name=unknown]"));
    expect(unknown.length).toBeGreaterThanOrEqual(4);
    expect(unknown.every((item: any) => !item.actionable), JSON.stringify(unknown)).toBe(true);
    expect(unknown.filter((item: any) => /\[box=[\d., -]+\]/.test(itemLine(item))).length, JSON.stringify(unknown)).toBeGreaterThanOrEqual(4);
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});

test("full observations preserve labels through proven local mask and rounded inset clips", async () => {
  const opened = await openExtension();
  try {
    const markup = ordinary + `<style>
      #nav{display:flex;gap:20px;height:48px;align-items:center;mask-image:linear-gradient(to right,transparent 0px,transparent 0px,black 0px,black 100%,transparent 100%,transparent 100%)}
      #rounded{display:flex;gap:16px;padding:30px;clip-path:inset(0 round 24px);background:#eee}
      #uncertain{mask-image:linear-gradient(to right,rgba(0,0,0,.5),rgba(0,0,0,.5))}
    </style><nav id="nav"><a href="/politics" aria-current="page">政治分类</a><a href="/sports">体育分类</a></nav>
      <section id="rounded"><button aria-expanded="false">模型菜单</button><a href="/trends">AI趋势</a></section>
      <section id="uncertain"><button>UNCONFIRMED_MASK</button></section>`;
    await opened.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: markup }));
    const target = await opened.context.newPage(); await target.goto(url); await attach(opened.page);
    const result = await inspect(opened.page);
    const text = inspectText(result.items);
    for (const label of ["政治分类", "体育分类", "模型菜单", "AI趋势"]) expect(text).toContain(label);
    expect(text).toContain("expanded=false"); expect(text).toContain("current=page");
    expect(text).not.toContain("UNCONFIRMED_MASK");
    expect(text).toContain("[name=unknown]");
  } finally {
    await detach(opened.page).catch(() => undefined); await dispose(opened.context, opened.userDataDirectory);
  }
});
