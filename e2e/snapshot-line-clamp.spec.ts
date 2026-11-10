import { expect } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";
import { inspectText } from "./snapshot-format";

test.use({ screenshot: "off", trace: "off" });
const origin = "http://snapshot-line-clamp.test";
const fullText = "ABCDEFGHIJKLMNOPQRST";
const fixtures: Array<{ id: string; html: string; css?: string; outer?: string; sheet?: string; flow: boolean; readable?: boolean }> = [
  { id: "two-lines", html: fullText, flow: true, readable: true },
  // An absent source whitespace box remains an independent mapping risk.
  { id: "two-lines-spaces", html: "AAAAAAAAAA BBBBBBBBBB", flow: true },
  { id: "true-three-lines", html: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", flow: false },
  { id: "three-lines-large-height", html: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", css: "height:120px", flow: false },
  { id: "last-line-ellipsis", html: "ABCDEFGHIJKLMNOPQRSTUVWXY", flow: false },
  { id: "three-text-nodes", html: "<span>ABCDEFGHIJ</span><span>KLMNOPQRST</span><span>UVWXYZ1234</span>", flow: false },
  { id: "three-text-nodes-large-height", html: "<span>ABCDEFGHIJ</span><span>KLMNOPQRST</span><span>UVWXYZ1234</span>", css: "height:120px", flow: false },
  { id: "empty-third-block", html: `<p>${fullText}</p><div style="height:24px"></div>`, flow: false },
  { id: "empty-third-block-large-height", html: `<p>${fullText}</p><div style="height:24px"></div>`, css: "height:120px", flow: false },
  { id: "two-lines-pre-wrap", html: `<p style="white-space:pre-wrap">${fullText}</p>`, flow: true, readable: true },
  { id: "pre-wrap-blank-line", html: "<p style=\"white-space:pre-wrap\">ABCDEFGHIJ\n\nKLMNOPQRST</p>", css: "height:120px", flow: false },
  { id: "generated-third-line", html: `<p>${fullText}</p>`, sheet: "#fixture::after{display:block;content:'THIRDLINE'}", flow: false },
  { id: "zero-line-height", html: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", css: "line-height:0;height:120px", flow: false },
  { id: "tiny-line-height", html: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", css: "line-height:1px;height:120px", flow: false },
  { id: "positioned-child", html: `<span>${fullText}</span><span style="position:absolute;top:0">EXTRA</span>`, flow: false },
  { id: "negative-margin", html: "<p>ABCDEFGHIJ</p><p style=\"margin-top:-24px\">KLMNOPQRST</p><p>UVWXYZ1234</p>", css: "height:120px", flow: false },
  { id: "br-third-line", html: "ABCDEFGHIJ<br>KLMNOPQRST<br>UVWXYZ1234", flow: false },
  { id: "vertical-writing", html: fullText, css: "writing-mode:vertical-rl;height:120px", flow: false },
  { id: "rtl", html: fullText, css: "direction:rtl", flow: false },
  { id: "bidi", html: "ABC אבג DEF אבג GHI אבג", flow: false },
  { id: "nested-clamp", html: `<p style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden">${fullText}</p>`, flow: false },
  { id: "smaller-outer-overflow", html: fullText, outer: "height:24px;overflow:hidden", flow: true },
  { id: "rounded-overflow", html: fullText, css: "border-bottom-right-radius:100% 100%", flow: true },
  { id: "rounded-overflow-without-clamp", html: fullText, css: "-webkit-line-clamp:none;border-bottom-right-radius:100% 100%", flow: true },
  { id: "rounded-safe-interior", html: fullText, outer: "padding:24px;overflow:hidden;border-radius:8px", flow: true, readable: true },
  { id: "scaled-rounded-flow", html: fullText, outer: "padding:24px;overflow:hidden;border-radius:8px;transform:scale(1.5);transform-origin:top left", flow: false },
];
const markup = (item: typeof fixtures[number]) => `<!doctype html><meta charset="utf-8"><title>Clamp proof</title><style>
  body{margin:20px;color:black;background:white}p{margin:0}
  #outer{width:10.1ch;font:20px/24px monospace;${item.outer || ""}}
  #fixture{position:relative;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:10.1ch;font:20px/24px monospace;overflow-wrap:anywhere;${item.css || ""}}
  ${item.sheet || ""}</style><div id="outer"><div id="fixture">${item.html}</div></div>`;

test("shares a bounded no-truncation proof while rejecting hidden and ambiguous clamp content", async () => {
  test.setTimeout(120_000);
  const opened = await openExtension();
  const developmentOrigin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!developmentOrigin) throw new Error("Line-clamp regression requires the development extension");
  const byId = new Map(fixtures.map((item) => [item.id, item]));
  try {
    await opened.context.route(`${origin}/**`, (route) => {
      const item = byId.get(new URL(route.request().url()).searchParams.get("case") || "");
      if (!item) throw new Error("Missing clamp fixture");
      return route.fulfill({ contentType: "text/html", body: markup(item) });
    });
    const target = await opened.context.newPage();
    await target.goto(`${origin}/?case=two-lines`);
    await opened.page.waitForLoadState("networkidle");
    await opened.page.evaluate(async ({ origin, developmentOrigin }) => {
      const { AutomationRuntime } = await import(`${developmentOrigin}/src/chrome/automation.ts`);
      const { sampleReadableSnapshot } = await import(`${developmentOrigin}/src/chrome/snapshot-readable-source.js`);
      const { snapshotObservationPrimitives } = await import(`${developmentOrigin}/src/chrome/snapshot-observation-primitives.js`);
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(origin));
      if (tab?.id === undefined) throw new Error("Clamp tab missing");
      const tabId = tab.id; await chrome.debugger.attach({ tabId }, "1.3");
      const runtime = new AutomationRuntime({ chromeApi: chrome,
        command: (source: chrome.debugger.Debuggee, method: string, params: any) => chrome.debugger.sendCommand(source, method, params),
        pressChord: async () => { throw new Error("Observation must not send input"); }, detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source) });
      const event = (source: chrome.debugger.Debuggee, method: string, params?: object) => runtime.handleEvent(source, method, params);
      chrome.debugger.onEvent.addListener(event); runtime.setContext({ signal: AbortSignal.timeout(110_000) });
      (globalThis as any).__clamp = { tabId, runtime, event, sampleReadableSnapshot, snapshotObservationPrimitives };
    }, { origin, developmentOrigin });
    for (const item of fixtures) {
      await target.goto(`${origin}/?case=${item.id}`);
      await target.evaluate(() => document.fonts.ready);
      const value = await opened.page.evaluate(async () => {
        const state = (globalThis as any).__clamp;
        const full = await state.runtime.inspect(state.tabId, { full: true, budget: 100_000 });
        await chrome.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "ISOLATED", func: state.snapshotObservationPrimitives, args: [true] });
        const semantic = await chrome.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "ISOLATED", func: state.sampleReadableSnapshot, args: [1] });
        const flow = await chrome.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "ISOLATED", func: () => {
          const api = (globalThis as any)[Symbol.for("surf-wax.snapshot-observation-primitives.v2")];
          const walker = document.createTreeWalker(document.querySelector("#fixture")!, NodeFilter.SHOW_TEXT), values = [];
          while (walker.nextNode()) values.push(api.textFlowCoverage(walker.currentNode));
          return values;
        } });
        return { full, semantic: semantic[0].result as any, flow: flow[0].result as any[] };
      });
      expect(value.flow.length, item.id).toBeGreaterThan(0);
      expect(value.flow.every((proof) => proof.coverage === "complete"), item.id).toBe(item.flow);
      const fullLines = inspectText((value.full as any).items);
      const semanticText = value.semantic.rows.flatMap((row: any) => [row.text || "", ...(row.textFragments || []).map((part: any) => part.text)]).join("\n");
      if (item.readable) {
        expect(fullLines, item.id).toContain(fullText);
        expect(semanticText, item.id).toContain(fullText);
        expect(value.semantic.gaps, item.id).toEqual([]);
      } else {
        // The local flow proof cannot override source mapping or outer clips.
        const forbidden = item.id === "two-lines-spaces" ? "AAAAAAAAAA BBBBBBBBBB" : item.id === "bidi" ? "ABC אבג" : "KLMNOPQRST";
        expect(fullLines, item.id).not.toContain(forbidden);
        expect(semanticText, item.id).not.toContain(forbidden);
        expect(value.semantic.gaps.length, item.id).toBeGreaterThan(0);
      }
    }
  } finally {
    await opened.page.evaluate(async () => { const state = (globalThis as any).__clamp; if (!state) return;
      await state.runtime.abortSessions(); chrome.debugger.onEvent.removeListener(state.event); delete (globalThis as any).__clamp;
    }).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("leaves unclamped author composition readable while withholding ambiguous composed clamp scopes", async () => {
  const opened = await openExtension(), developmentOrigin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!developmentOrigin) throw new Error("Line-clamp regression requires the development extension");
  try {
    await opened.context.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>
      body{margin:20px;color:black;background:white;font:20px/24px monospace}section{display:block;margin:8px}</style>
      <section id="open-clean"></section><section id="closed-clamped"></section>
      <section id="slot-clean"><span slot="label">SLOTTED_READABLE</span></section>
      <section id="slot-clamped"><span slot="label">SLOTTED_UNCONFIRMED</span></section>` }));
    const target = await opened.context.newPage(); await target.goto(`${origin}/?case=composed`);
    await target.evaluate(() => {
      const clamp = 'style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;line-height:24px;width:10.1ch;height:120px;overflow-wrap:anywhere"';
      document.querySelector("#open-clean")!.attachShadow({ mode: "open" }).innerHTML = "<span>SHADOW_READABLE</span>";
      document.querySelector("#closed-clamped")!.attachShadow({ mode: "closed" }).innerHTML = `<div ${clamp}>SHADOW_UNCONFIRMED_HIDDEN_TAIL</div>`;
      document.querySelector("#slot-clean")!.attachShadow({ mode: "closed" }).innerHTML = '<slot name="label"></slot>';
      document.querySelector("#slot-clamped")!.attachShadow({ mode: "closed" }).innerHTML = `<div ${clamp}><slot name="label"></slot></div>`;
      document.querySelector("#slot-clamped span")!.textContent = "SLOTTED_UNCONFIRMED_HIDDEN_TAIL";
    });
    await opened.page.waitForLoadState("networkidle");
    const sample: any = await opened.page.evaluate(async ({ origin, developmentOrigin }) => {
      const { snapshotObservationPrimitives } = await import(`${developmentOrigin}/src/chrome/snapshot-observation-primitives.js`);
      const { sampleReadableSnapshot } = await import(`${developmentOrigin}/src/chrome/snapshot-readable-source.js`);
      const { AutomationRuntime } = await import(`${developmentOrigin}/src/chrome/automation.ts`);
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(origin));
      if (tab?.id === undefined) throw new Error("Clamp tab missing");
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func: snapshotObservationPrimitives, args: [true] });
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func: sampleReadableSnapshot, args: [1] });
      const tabId = tab.id, branches: Array<{ readOnly: boolean; partial: boolean }> = [];
      await chrome.debugger.attach({ tabId }, "1.3");
      const runtime: any = new AutomationRuntime({ chromeApi: chrome,
        command: (source: chrome.debugger.Debuggee, method: string, params: any) => chrome.debugger.sendCommand(source, method, params),
        pressChord: async () => { throw new Error("Observation must not send input"); }, detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source) });
      const event = (source: chrome.debugger.Debuggee, method: string, params?: object) => runtime.handleEvent(source, method, params);
      const capture = runtime.captureReadableSnapshot.bind(runtime);
      runtime.captureReadableSnapshot = async (...args: any[]) => { const captured = await capture(...args);
        branches.push({ readOnly: captured.readOnly === true, partial: captured.partial === true }); return captured; };
      chrome.debugger.onEvent.addListener(event); runtime.setContext({ signal: AbortSignal.timeout(30_000) });
      try { const full = await runtime.inspect(tabId, { full: true, budget: 100_000 }); return { ...(result[0].result as Record<string, unknown>), full, branches }; }
      finally { await runtime.abortSessions(); chrome.debugger.onEvent.removeListener(event); }
    }, { origin, developmentOrigin });
    const content = sample.rows.flatMap((row: any) => [row.text || "", ...(row.textFragments || []).map((part: any) => part.text)]).join("\n");
    expect(content).toContain("SHADOW_READABLE"); expect(content).toContain("SLOTTED_READABLE");
    expect(content).not.toContain("SHADOW_UNCONFIRMED"); expect(content).not.toContain("SLOTTED_UNCONFIRMED");
    expect(sample.gaps.some((gap: any) => gap.reason === "effect-coverage")).toBe(true);
    await test.info().attach("composed-clamp-production-path", { body: JSON.stringify({ branches: sample.branches, full: sample.full }), contentType: "application/json" });
    expect(inspectText(sample.full.items)).not.toContain("HIDDEN_TAIL");
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});

test("keeps a clamped market heading with an inkless stretched-link pseudo and rejects changed paint or flow", async () => {
  test.setTimeout(90_000);
  const opened = await openExtension(), developmentOrigin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!developmentOrigin) throw new Error("Line-clamp regression requires the development extension");
  const title = "谁将在2027年之前离开特朗普政府？";
  const variants = [
    { id: "absolute-empty", pseudo: "position:absolute;inset:0", readable: true },
    { id: "fixed-empty", pseudo: "position:fixed;inset:0", readable: true },
    { id: "painted-background", pseudo: "position:absolute;inset:0;background:white", readable: false },
    { id: "painted-shadow", pseudo: "position:absolute;inset:0;box-shadow:inset 0 0 0 100px white", readable: false },
    { id: "in-flow-empty", pseudo: "position:static;display:block;height:32px", readable: false },
  ];
  try {
    await opened.context.route(`${origin}/**`, (route) => {
      const variant = variants.find((value) => value.id === new URL(route.request().url()).searchParams.get("case"));
      if (!variant) throw new Error("Missing stretched-link fixture");
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>
        body{margin:20px;color:black;background:white}h3{position:relative;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;margin:0;width:632px;font:600 24px/32px Arial}
        a{color:inherit;text-decoration:none}a::after{content:"";${variant.pseudo}}</style><h3><a href="/market">${title}</a></h3>` });
    });
    const target = await opened.context.newPage(); await opened.page.waitForLoadState("networkidle");
    for (const variant of variants) {
      await target.goto(`${origin}/?case=${variant.id}`); await target.evaluate(() => document.fonts.ready);
      const observed: any = await opened.page.evaluate(async ({ origin, developmentOrigin }) => {
        const { snapshotObservationPrimitives } = await import(`${developmentOrigin}/src/chrome/snapshot-observation-primitives.js`);
        const { sampleReadableSnapshot } = await import(`${developmentOrigin}/src/chrome/snapshot-readable-source.js`);
        const { AutomationRuntime } = await import(`${developmentOrigin}/src/chrome/automation.ts`);
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(origin));
        if (tab?.id === undefined) throw new Error("Market-heading tab missing");
        const tabId = tab.id;
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: snapshotObservationPrimitives, args: [true] });
        const semantic = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: sampleReadableSnapshot, args: [1] });
        const flow = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: () => {
          const api = (globalThis as any)[Symbol.for("surf-wax.snapshot-observation-primitives.v2")];
          return api.textFlowCoverage(document.querySelector("a")!.firstChild);
        } });
        await chrome.debugger.attach({ tabId }, "1.3");
        const runtime = new AutomationRuntime({ chromeApi: chrome,
          command: (source: chrome.debugger.Debuggee, method: string, params: any) => chrome.debugger.sendCommand(source, method, params),
          pressChord: async () => { throw new Error("Observation must not send input"); }, detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source) });
        const event = (source: chrome.debugger.Debuggee, method: string, params?: object) => runtime.handleEvent(source, method, params);
        chrome.debugger.onEvent.addListener(event); runtime.setContext({ signal: AbortSignal.timeout(25_000) });
        try { return { full: await runtime.inspect(tabId, { full: true, budget: 100_000 }), semantic: semantic[0].result, flow: flow[0].result }; }
        finally { await runtime.abortSessions(); chrome.debugger.onEvent.removeListener(event); }
      }, { origin, developmentOrigin });
      const textOf = (row: any) => row.text || row.textFragments?.map((part: any) => part.text).join("") || "";
      await test.info().attach(`market-heading-${variant.id}`, { body: JSON.stringify(observed), contentType: "application/json" });
      expect(observed.flow.coverage === "complete", variant.id).toBe(variant.readable);
      const fullLines = inspectText(observed.full.items);
      if (variant.readable) {
        expect(fullLines, variant.id).toContain(title);
        const heading = observed.semantic.rows.find((row: any) => row.role === "heading" && row.state?.level === 3);
        const link = observed.semantic.rows.find((row: any) => row.role === "link" && textOf(row) === title);
        expect(heading, variant.id).toBeDefined(); expect(link, variant.id).toBeDefined();
        expect(link.parentKey, variant.id).toBe(heading.key);
        expect(observed.semantic.gaps, variant.id).toEqual([]);
      } else {
        expect(fullLines, variant.id).not.toContain(title);
        expect(observed.semantic.rows.map(textOf).join("\n"), variant.id).not.toContain(title);
        expect(observed.semantic.gaps.length, variant.id).toBeGreaterThan(0);
      }
    }
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});
