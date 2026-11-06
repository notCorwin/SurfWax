import { expect, type Page } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";

type Snapshot = { observationId: string; mode: string; nextCursor?: string; items: Array<{ id: string; line: string; ref?: string; change?: string }> };
const fixtureUrl = "http://snapshot-presentation.test/";
const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23555555'/%3E%3C/svg%3E";

test.use({ screenshot: "off", trace: "off" });

async function attach(panel: Page): Promise<void> {
  const origin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!origin) throw new Error("Snapshot regression requires the development extension server");
  await panel.waitForLoadState("networkidle");
  await panel.evaluate(async ({ url, origin }) => {
    const moduleUrl = `${origin}/src/chrome/automation.ts`;
    const { AutomationRuntime } = await import(moduleUrl);
    const tabId = (await chrome.tabs.query({ url }))[0]?.id;
    if (tabId === undefined) throw new Error("Snapshot fixture tab is missing");
    await chrome.debugger.attach({ tabId }, "1.3");
    const state: any = { tabId, screenshots: 0 };
    const runtime = new AutomationRuntime({
      chromeApi: chrome,
      command: (source: chrome.debugger.Debuggee, method: string, params: any) => {
        if (method === "Page.captureScreenshot") state.screenshots += 1;
        return chrome.debugger.sendCommand(source, method, params);
      },
      pressChord: async () => { throw new Error("Snapshot inspection cannot send input"); },
      detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source),
    });
    state.runtime = runtime;
    state.onEvent = (source: chrome.debugger.Debuggee, method: string, params: any) => runtime.handleEvent(source, method, params);
    chrome.debugger.onEvent.addListener(state.onEvent);
    runtime.setContext({ signal: AbortSignal.timeout(45_000) });
    (globalThis as any).__presentationStudy = state;
  }, { url: fixtureUrl, origin });
}

async function inspect(panel: Page, options: Record<string, unknown> = {}): Promise<Snapshot> {
  return panel.evaluate(async (options) => {
    const state = (globalThis as any).__presentationStudy;
    return state.runtime.inspect(state.tabId, { budget: 100_000, ...options });
  }, options);
}

async function detach(panel: Page): Promise<void> {
  await panel.evaluate(async () => {
    const state = (globalThis as any).__presentationStudy;
    if (!state) return;
    await state.runtime.abortSessions();
    chrome.debugger.onEvent.removeListener(state.onEvent);
    delete (globalThis as any).__presentationStudy;
  });
}

function box(line: string): number[] {
  const match = /\[box=([^\]]+)\]/.exec(line);
  if (!match) throw new Error(`Snapshot row has no measured box: ${line}`);
  return match[1]!.split(",").map(Number);
}

test("compact observations distinguish same-name targets by measured layout and update on visual reordering", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{margin:0;font:16px sans-serif}main{padding:20px}.badges{display:flex;gap:20px}.badges a{display:flex;align-items:center;flex-direction:column;width:60px}.badges a:first-child{order:2}.badges a:nth-child(2){order:1}.badges.swapped a:first-child{order:1}.badges.swapped a:nth-child(2){order:2}</style>
      <body onclick="void 0"><main><h1>Workspace</h1><h2>Pinned</h2><ul>
        <li><a href="/repo/SurfWax"><span>SurfWax</span></a></li>
        <li><a href="/repo/Codex-Credit-Bar">Codex-Credit-Bar</a><p>Swift <a href="/repo/Codex-Credit-Bar/stargazers">1</a></p></li>
      </ul><h2>Achievements</h2><div class="badges" id="badges">
        <a href="/right"><img width="40" height="40" alt="PRIVATE_ALT_RIGHT" src="${image}"><span>x2</span></a>
        <a href="/left"><img width="40" height="40" alt="PRIVATE_ALT_LEFT" src="${image}"><span>x2</span></a>
        <a href="/hidden" style="display:none">x2</a>
      </div><img width="24" height="24" alt="PRIVATE_ALT_STANDALONE" src="${image}">
      <div onclick="void 0">Open details <button>Dismiss</button></div></main>` }));
    const target = await opened.context.newPage();
    await target.goto(fixtureUrl);
    await target.evaluate(() => document.fonts.ready);
    await attach(opened.page);
    const first = await inspect(opened.page);
    const lines = first.items.map((item) => item.line);
    const text = lines.join("\n");
    expect(first.items.every((item) => item.ref === undefined)).toBe(true);
    expect(text).not.toContain("[ref=");
    expect(text).not.toContain("PRIVATE_ALT_");
    expect(text.match(/SurfWax/g)).toHaveLength(1);
    expect(text.match(/Codex-Credit-Bar/g)).toHaveLength(1);
    expect(lines.filter((line) => /- link "x2"/.test(line))).toHaveLength(2);
    expect(lines.filter((line) => /- StaticText "x2"/.test(line))).toHaveLength(0);
    expect(lines.filter((line) => /- image/.test(line))).toHaveLength(3);
    expect(text).toContain("Open details");
    expect(lines.filter((line) => /- button "Dismiss"/.test(line))).toHaveLength(1);

    const expected = await target.locator(".badges a").evaluateAll((anchors) => anchors.filter((anchor) => {
      const r = anchor.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).map((anchor) => { const r = anchor.getBoundingClientRect(); return { x: r.x, width: r.width }; }));
    expect(expected[0]!.x).toBeGreaterThan(expected[1]!.x);
    const pair = first.items.filter((item) => /- link "x2"/.test(item.line));
    const left = Math.min(...expected.map((item) => item.x));
    expect(text).not.toContain("[position=");
    for (const item of pair) {
      expect(expected.some((actual) => Math.abs(actual.x - box(item.line)[0]!) < 0.2)).toBe(true);
    }
    expect(pair.filter((item) => box(item.line)[0] === left)).toHaveLength(1);
    const rawSnapshot = await opened.page.evaluate(async () => {
      const state = (globalThis as any).__presentationStudy;
      return state.runtime.snapshot(state.tabId);
    });
    expect(rawSnapshot.snapshot).not.toContain("[ref=");

    const sliced = await inspect(opened.page, { limit: 1 });
    const actionable = await inspect(opened.page, { fields: ["text", "state", "ref"], limit: 1 });
    expect(sliced.nextCursor).toEqual(expect.any(String));
    await target.locator("#badges").evaluate((element) => element.classList.add("swapped"));
    const continued = await inspect(opened.page, { cursor: sliced.nextCursor });
    expect(continued.items.filter((item) => /- link "x2"/.test(item.line))).toEqual(pair);
    await expect(inspect(opened.page, { cursor: actionable.nextCursor })).rejects.toThrow("stale-observation");
    const delta = await inspect(opened.page, { since: first.observationId });
    expect(delta.mode).toBe("delta");
    for (const before of pair) {
      const after = delta.items.find((item) => item.id === before.id);
      expect(after?.change).toBe("updated");
      const other = pair.find((item) => item.id !== before.id)!;
      expect(box(after!.line)[0]).toBe(box(other.line)[0]);
    }
    expect(await opened.page.evaluate(() => (globalThis as any).__presentationStudy.screenshots)).toBe(0);
  } finally {
    await detach(opened.page).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("geometry stays in the owning frame viewport after root scrolling", async () => {
  const opened = await openExtension();
  try {
    const child = `<style>body{margin:0;height:1200px}a{position:absolute;left:180px;top:80px}img{position:absolute;left:180px;top:120px}</style><a href='/child'>Repeat</a><img width='23' height='23' alt='PRIVATE_CHILD_ALT' src="${image}">`;
    await opened.context.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{margin:0;height:1800px}#root-link{position:absolute;left:20px;top:150px}#root-image{position:absolute;left:20px;top:190px}iframe{position:absolute;left:200px;top:300px;width:400px;height:250px;border:0}</style>
      <a id="root-link" href="/root">Repeat</a><img id="root-image" width="19" height="19" alt="PRIVATE_ROOT_ALT" src="${image}"><iframe title="Embedded" srcdoc="${child.replaceAll('"', '&quot;')}"></iframe>` }));
    const target = await opened.context.newPage();
    await target.goto(fixtureUrl);
    await target.evaluate(() => scrollTo(0, 100));
    await expect(target.frameLocator("iframe").locator("img")).toBeVisible();
    await attach(opened.page);
    const observation = await inspect(opened.page);
    const repeats = observation.items.filter((item) => /- link "Repeat"/.test(item.line));
    expect(repeats).toHaveLength(2);
    const images = observation.items.filter((item) => /- image/.test(item.line)).map((item) => box(item.line));
    const root = images.find((rect) => rect[2] === 19);
    const embedded = images.find((rect) => rect[2] === 23);
    expect(root).toEqual([20, 90, 19, 19]);
    expect(embedded).toEqual([180, 120, 23, 23]);
    expect(JSON.stringify(observation)).not.toContain("PRIVATE_");
    expect(await opened.page.evaluate(() => (globalThis as any).__presentationStudy.screenshots)).toBe(0);
  } finally {
    await detach(opened.page).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("text-fragment reordering and actionable painted overflow survive presentation", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{margin:0}button{position:absolute;left:20px;top:20px;display:flex;gap:30px;width:300px;padding:8px}button.reordered span:first-child{order:2}button.reordered span:last-child{order:1}#with-image{top:100px}#with-image.shifted span,#dom-only.shifted span{transform:translateX(80px)}#dom-only{top:400px}#boundary{top:500px;display:block;text-align:left}#pseudo{position:absolute;left:20px;top:300px}#pseudo::before{content:'Generated';display:inline-block}#pseudo.shifted::before{transform:translateX(70px)}#overflow{position:absolute;left:400px;top:200px;width:0;height:0;overflow:visible}img{display:block}</style>
      <button id="label"><span>One</span><span>Two</span></button>
      <button id="with-image"><img width="40" height="40" alt="PRIVATE_INLINE_ALT" src="${image}"><span>Move</span></button>
      <div id="pseudo"></div>
      <div aria-hidden="true"><button id="dom-only"><img width="40" height="40" alt="PRIVATE_DOM_ALT" src="${image}"><span>DOMMove</span></button></div>
      <button id="boundary"><span>Save </span><span>changes</span></button>
      <div id="overflow" onclick="void 0"><img width="40" height="40" alt="PRIVATE_OVERFLOW_ALT" src="${image}"></div>` }));
    const target = await opened.context.newPage();
    await target.goto(fixtureUrl);
    await attach(opened.page);
    const initial = await inspect(opened.page);
    const label = initial.items.find((item) => item.line.includes('[text-parts=') && item.line.includes('"One"') && item.line.includes('"Two"'))!;
    const part = (line: string, text: string) => {
      const match = new RegExp(`"${text}" @\\(([^)]+)\\)`).exec(line);
      if (!match) throw new Error(`Missing ${text} fragment geometry: ${line}`);
      return match[1]!.split(",").map(Number);
    };
    const textBox = (line: string) => /\[text-box=([^\]]+)\]/.exec(line)![1]!.split(",").map(Number);
    expect(part(label.line, "One")[0]).toBeLessThan(part(label.line, "Two")[0]!);
    const shallow = await inspect(opened.page, { depth: 1 });
    expect(shallow.items.some((item) => item.line.includes('"One"') && item.line.includes('"Two"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('button "OneTwo"') || item.line.includes('button "One Two"'))).toBe(false);

    await target.locator("#label").evaluate((element) => element.classList.add("reordered"));
    const delta = await inspect(opened.page, { since: initial.observationId });
    const changed = delta.items.find((item) => item.id === label.id)!;
    expect(changed?.change).toBe("updated");
    expect(part(changed.line, "One")[0]).toBeGreaterThan(part(changed.line, "Two")[0]!);

    const move = initial.items.find((item) => /- button "Move"/.test(item.line))!;
    const domMove = initial.items.find((item) => /- button "DOMMove"/.test(item.line))!;
    const generated = initial.items.find((item) => /- StaticText "Generated"/.test(item.line))!;
    expect(box(generated.line)).toEqual(expect.arrayContaining([20, 300]));
    const imageX = await target.locator("#with-image img").evaluate((element) => element.getBoundingClientRect().x);
    await target.locator("#with-image").evaluate((element) => element.classList.add("shifted"));
    await target.locator("#dom-only").evaluate((element) => element.classList.add("shifted"));
    await target.locator("#pseudo").evaluate((element) => element.classList.add("shifted"));
    const motion = await inspect(opened.page, { since: initial.observationId });
    const moved = motion.items.find((item) => item.id === move.id)!;
    const movedGenerated = motion.items.find((item) => item.id === generated.id)!;
    expect(moved?.change).toBe("updated");
    expect(textBox(moved.line)[0]).toBeGreaterThan(textBox(move.line)[0]!);
    const movedDOM = motion.items.find((item) => item.id === domMove.id)!;
    expect(movedDOM?.change).toBe("updated");
    expect(textBox(movedDOM.line)[0]).toBeGreaterThan(textBox(domMove.line)[0]!);
    expect(await target.locator("#with-image img").evaluate((element) => element.getBoundingClientRect().x)).toBe(imageX);
    expect(movedGenerated?.change).toBe("updated");
    expect(box(movedGenerated.line)[0]).toBeGreaterThan(box(generated.line)[0]!);

    const boundary = initial.items.find((item) => item.line.includes("Save") && item.line.includes("changes"))!;
    const rects = await target.locator("#boundary span").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
    }));
    await target.locator("#boundary span").first().evaluate((element) => {
      const before = element.getBoundingClientRect().width;
      (element.firstChild as Text).data = "Save";
      const after = element.getBoundingClientRect().width;
      (element as HTMLElement).style.letterSpacing = `${(before - after) / 4}px`;
    });
    const afterRects = await target.locator("#boundary span").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
    }));
    for (let index = 0; index < rects.length; index += 1) {
      rects[index]!.forEach((value, coordinate) => expect(afterRects[index]![coordinate]).toBeCloseTo(value, 1));
    }
    const spacing = await inspect(opened.page, { since: initial.observationId });
    const changedBoundary = spacing.items.find((item) => item.id === boundary.id)!;
    expect(changedBoundary?.change).toBe("updated");
    expect(changedBoundary.line).not.toBe(boundary.line);
    expect(boundary.line).toContain('"Save "');
    expect(changedBoundary.line).not.toContain('"Save "');

    await target.locator("button, #pseudo").evaluateAll((elements) => elements.forEach((element) => element.remove()));
    const explicit = await inspect(opened.page, { fields: ["text", "state", "ref"] });
    const overflow = explicit.items.find((item) => item.line.includes("[box=400,200,0,0]"));
    expect(overflow?.line).toContain("- generic");
    expect(overflow?.ref).toEqual(expect.any(String));
    expect(explicit.items.some((item) => /- image/.test(item.line))).toBe(true);
    const observed = await opened.page.evaluate(async () => {
      const state = (globalThis as any).__presentationStudy;
      return state.runtime.observe(state.tabId, "auto");
    });
    expect(observed.snapshot).toContain("[box=400,200,0,0]");
    expect(observed).not.toHaveProperty("screenshot");
    expect(await opened.page.evaluate(() => (globalThis as any).__presentationStudy.screenshots)).toBe(0);
  } finally {
    await detach(opened.page).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("repeated grid cells retain every position, state change and explicit action target", async () => {
  const opened = await openExtension();
  try {
    const cells = Array.from({ length: 12 }, (_, index) => `<td role="gridcell" aria-label="PRIVATE_${index}" aria-readonly="false"></td>`).join("");
    await opened.context.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{margin:0}table{border-spacing:4px}td{width:12px;height:12px;padding:0;background:green}</style>
      <table role="grid"><tbody><tr>${cells}</tr></tbody></table>` }));
    const target = await opened.context.newPage();
    await target.goto(fixtureUrl);
    await attach(opened.page);
    const initial = await inspect(opened.page);
    const group = initial.items.find((item) => /- gridcell .*\[count=12\]/.test(item.line))!;
    expect(group).toBeDefined();
    expect(group.line).toContain("step=(16,0,0,0) count=12");
    expect(group.line).toContain("[name=unknown]");
    expect(group.line).not.toContain("PRIVATE_");
    const explicit = await inspect(opened.page, { fields: ["text", "state", "ref"] });
    const individual = explicit.items.filter((item) => /- gridcell/.test(item.line));
    expect(individual).toHaveLength(12);
    expect(new Set(individual.map((item) => item.ref)).size).toBe(12);
    expect(individual.every((item) => item.ref && /\[box=/.test(item.line))).toBe(true);
    await target.locator("td").nth(5).evaluate((element) => element.setAttribute("aria-readonly", "true"));
    const changed = await inspect(opened.page, { since: initial.observationId });
    expect(changed.items.some((item) => /gridcell/.test(item.line) && /readonly=true/.test(item.line))).toBe(true);
    const full = await inspect(opened.page, { full: true });
    const counts = full.items.filter((item) => /- gridcell/.test(item.line)).reduce((total, item) => total + Number(/\[count=(\d+)\]/.exec(item.line)?.[1] ?? 1), 0);
    expect(counts).toBe(12);
    expect(await opened.page.evaluate(() => (globalThis as any).__presentationStudy.screenshots)).toBe(0);
  } finally {
    await detach(opened.page).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("transformed preserved spaces remain visible in deltas and source paragraphs stay separate", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <meta charset="utf-8"><style>body{margin:0;font:16px monospace}#normal,#pre,#unicode,#line,#letter,#turkish{text-transform:uppercase}#pre,#letter{white-space:pre}#pre span{display:inline-block}#line,#turkish,#capital{white-space:pre-line}#capital{text-transform:capitalize}#letter::first-letter{color:red}#generated::before{content:'   before  words';white-space:pre;text-transform:uppercase}</style>
      <main><div id="normal"><span>one </span><span>two</span></div><div id="pre"><span>a  b</span><span> end</span></div><p>PARAONE</p><p>PARATWO</p><div id="unicode"><span>a ß </span><span>two</span></div><div id="line">aa ß\nbb</div><div id="turkish" lang="tr">ii i\nbb</div><div id="capital">aa b\ncc</div><div id="letter">   echo  foxtrot</div><div id="generated"></div></main>` }));
    const target = await opened.context.newPage();
    await target.goto(fixtureUrl);
    await attach(opened.page);
    const initial = await inspect(opened.page);
    expect(initial.items.some((item) => item.line.includes('"ONE "'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"A  B"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"A SS "')), initial.items.map((item) => item.line).join("\n")).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"AA SS\\nBB"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"İİ İ\\nBB"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"Aa B\\nCc"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"   E"'))).toBe(true);
    expect(initial.items.some((item) => item.line.includes('"   BEFORE  WORDS"'))).toBe(true);
    const paragraphs = initial.items.filter((item) => /PARAONE|PARATWO/.test(item.line));
    expect(paragraphs).toHaveLength(2);
    const before = await target.locator("#pre span").first().evaluate((element) => {
      const rect = element.getBoundingClientRect(), range = document.createRange();
      range.setStart(element.firstChild!, 3); range.setEnd(element.firstChild!, 4);
      return { width: rect.width, b: range.getBoundingClientRect().x };
    });
    await target.locator("#pre span").first().evaluate((element) => { element.textContent = "a b "; });
    const after = await target.locator("#pre span").first().evaluate((element) => {
      const rect = element.getBoundingClientRect(), range = document.createRange();
      range.setStart(element.firstChild!, 2); range.setEnd(element.firstChild!, 3);
      return { width: rect.width, b: range.getBoundingClientRect().x };
    });
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.b).toBeLessThan(before.b);
    const delta = await inspect(opened.page, { since: initial.observationId });
    expect(delta.items.some((item) => item.change === "updated" && item.line.includes('"A B "'))).toBe(true);
    const lineRect = await target.locator("#line").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
      return [rect.width, rect.height];
    });
    await target.locator("#line").evaluate((element) => { element.textContent = "aa\nß bb"; });
    const movedLineRect = await target.locator("#line").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
      return [rect.width, rect.height];
    });
    expect(movedLineRect).toEqual(lineRect);
    const lineDelta = await inspect(opened.page, { since: initial.observationId });
    expect(lineDelta.items.some((item) => item.change === "updated" && item.line.includes('"AA\\nSS BB"'))).toBe(true);
    for (const [id, text, rendered] of [["turkish", "ii\ni bb", '"İİ\\nİ BB"'], ["capital", "aa\nb cc", '"Aa\\nB Cc"']] as const) {
      const before = await target.locator(`#${id}`).evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
        return [rect.width, rect.height];
      });
      const after = await target.locator(`#${id}`).evaluate((element, text) => {
        element.textContent = text;
        const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
        return [rect.width, rect.height];
      }, text);
      expect(after).toEqual(before);
      const changed = await inspect(opened.page, { since: initial.observationId });
      expect(changed.items.some((item) => item.change === "updated" && item.line.includes(rendered))).toBe(true);
    }
  } finally {
    await detach(opened.page).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});
