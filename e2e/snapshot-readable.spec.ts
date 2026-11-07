import { expect } from "@playwright/test";
import { test, openExtension, dispose, startProvider } from "./fixtures";
import { readableSnapshot, sampleReadableSnapshot } from "../src/chrome/snapshot-readable";
import { snapshotObservationPrimitives } from "../src/chrome/snapshot-observation-primitives.js";

test.use({ screenshot: "off", trace: "off" });

async function sampleInExtension(opened: Awaited<ReturnType<typeof openExtension>>, url: string) {
  await expect(opened.page.getByTestId("open-settings")).toBeVisible();
  const cdp = await opened.context.newCDPSession(opened.page);
  try {
    const response = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === ${JSON.stringify(url)});
        if (!tab) throw new Error("Target tab not found");
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: (${snapshotObservationPrimitives.toString()}), args: [true] });
        const pageZoom = await chrome.tabs.getZoom(tab.id);
        const [sample] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: (${sampleReadableSnapshot.toString()}), args: [pageZoom] });
        return sample.result; })()`, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  } finally { await cdp.detach(); }
}

test("read-only text uses Chrome paint evidence and omits unverified content", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;font:16px monospace}p{margin:0;height:30px}</style>
      <p>KNOWN_VISIBLE</p>
      <p style="display:none">HIDDEN_SECRET</p>
      <p style="position:absolute;top:2000px">OFFSCREEN_SECRET</p>
      <div style="width:4px;overflow:hidden;white-space:nowrap">CLIPPED_SECRET</div>
      <p style="color:transparent">TRANSPARENT_SECRET</p>
      <p style="text-transform:uppercase">transformed_visible</p>
      <p style="position:absolute;left:0;top:250px">COVERED_SECRET</p>
      <div style="position:absolute;left:0;top:250px;width:400px;height:30px;background:black;z-index:10"></div>
      <input type="password" value="PASSWORD_SECRET">
      <iframe srcdoc="<p>FRAME_SECRET</p>"></iframe>`);
    {
      const sample = await sampleInExtension(opened, target.url());
      const lines = readableSnapshot(sample as any);
      const text = lines.map(({ line }) => line).join("\n");
      expect(text).toContain("KNOWN_VISIBLE");
      expect(text).not.toContain("transformed_visible");
      expect((sample as any).viewport).toMatchObject({ x: 0, y: 0, width: 1000, height: 700 });
      expect(text).not.toMatch(/HIDDEN_SECRET|OFFSCREEN_SECRET|CLIPPED_SECRET|TRANSPARENT_SECRET|COVERED_SECRET|PASSWORD_SECRET|FRAME_SECRET/);
      expect(lines.every((line) => !line.ref)).toBe(true);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("read-only sampling withholds pseudo paint, SVG text and gradient-covered text", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>
      body{margin:0;font:16px monospace}p{margin:0;height:30px}
      #transparent::first-line{color:transparent}
      #uppercase::first-line{text-transform:uppercase}
    </style><p>INDEPENDENT_VISIBLE</p>
    <p id="transparent">FIRST_LINE_SECRET</p><p id="uppercase">first_line_lowercase</p>
    <svg width="200" height="40"><text x="0" y="20" fill="none">SVG_SECRET</text></svg>
    <p style="position:absolute;top:300px">GRADIENT_SECRET</p>
    <div style="position:fixed;left:0;top:300px;width:400px;height:40px;background:linear-gradient(white,white);pointer-events:none"></div>`);
    const sample = await sampleInExtension(opened, target.url());
    const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
    expect(text).toContain("INDEPENDENT_VISIBLE");
    expect(text).not.toMatch(/FIRST_LINE_SECRET|first_line_lowercase|SVG_SECRET|GRADIENT_SECRET/);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("read-only sampling excludes border, outline, backdrop and unsafe foreground covers", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    const covers = [
      '<div style="position:absolute;left:0;top:0;width:200px;height:100px;border:100px solid white;box-sizing:border-box"></div>',
      '<div style="position:absolute;left:100px;top:100px;width:1px;height:1px;outline:150px solid white"></div>',
      '<style>#cover::first-line{color:white;text-transform:uppercase}</style><p id="cover" style="position:absolute;top:20px;left:20px">COVERED_SECRET</p>',
      '<style>dialog::backdrop{background:white}</style><dialog>Modal text</dialog>',
    ];
    for (const cover of covers) {
      await target.setContent(`<!doctype html><style>body{margin:0;background:white;font:16px monospace}p{margin:0}</style><p style="position:absolute;top:20px;left:20px">COVERED_SECRET</p>${cover}`);
      await target.evaluate(() => document.querySelector('dialog')?.showModal());
      const sample = await sampleInExtension(opened, target.url());
      const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
      expect(text, cover).not.toContain("COVERED_SECRET");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("read-only text requires visible contrast and an unobscured live document", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;background:white;color:black;font:16px monospace}p{margin:0;height:40px}</style>
      <p>CONTRAST_VISIBLE</p><p style="color:white">INVISIBLE_SAME_COLOR</p>
      <section style="background:black"><p style="color:black">INVISIBLE_ANCESTOR_COLOR</p><p style="color:white">DARK_VISIBLE</p></section>
      <p style="background:lab(100% 0 0);color:oklab(0 0 0)">COLOR4_VISIBLE</p>
      <p style="background:rgb(255,255,255);color:oklab(1 0 0)">INVISIBLE_COLOR4_SAME</p>
      <p style="color:oklab(0 0 0 / .999)">ALPHA_VISIBLE</p>
      <p style="background:rgba(0,0,0,.5);color:rgb(127,127,127)">INVISIBLE_COMPOSITE</p>
      <p style="background:oklab(.6 .1 0 / .2);color:black">COMPOSITE_VISIBLE</p>
      <div style="position:relative;border:20px solid white;background:black;height:40px;color:white"><span style="position:absolute;left:-20px;top:-20px">INVISIBLE_BORDER</span></div>`);
    const sample = await sampleInExtension(opened, target.url());
    const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
    expect(text).toContain("CONTRAST_VISIBLE");
    expect(text).toContain("DARK_VISIBLE");
    expect(text).toContain("COLOR4_VISIBLE");
    expect(text).toContain("ALPHA_VISIBLE");
    expect(text).toContain("COMPOSITE_VISIBLE");
    expect(text).not.toContain("INVISIBLE_");

    await target.setContent('<p style="background:white;color:black;box-shadow:inset 0 0 0 100px black">INVISIBLE_INSET_SHADOW</p>');
    const inset = await sampleInExtension(opened, target.url());
    expect(readableSnapshot(inset as any).map(({ line }) => line).join("\n")).not.toContain("INVISIBLE_INSET_SHADOW");

    await target.setContent('<p style="color:black;background:white;text-decoration:line-through white;text-decoration-thickness:100px">DECORATION_COVERED</p>');
    const decorated = await sampleInExtension(opened, target.url());
    expect(readableSnapshot(decorated as any).map(({ line }) => line).join("\n")).not.toContain("DECORATION_COVERED");

    await target.setContent(`<!doctype html><style>
      ::view-transition-old(root){animation:hold 60s;opacity:1}
      ::view-transition-new(root){animation:hold 60s;opacity:0}
      @keyframes hold{from{}to{}}
    </style><p>OLD_VISIBLE</p>`);
    await target.evaluate(async () => {
      const transition = document.startViewTransition(() => { document.querySelector("p")!.textContent = "NEW_HIDDEN"; });
      (globalThis as any).__snapshotTransition = transition;
      await transition.ready;
    });
    expect(await target.evaluate(() => getComputedStyle(document.documentElement, "::view-transition-new(root)").opacity)).toBe("0");
    const during = await sampleInExtension(opened, target.url());
    expect(readableSnapshot(during as any).map(({ line }) => line).join("\n")).not.toContain("NEW_HIDDEN");
    await target.evaluate(async () => {
      const transition = (globalThis as any).__snapshotTransition;
      transition.skipTransition(); await transition.finished;
    });
    const after = await sampleInExtension(opened, target.url());
    expect(readableSnapshot(after as any).map(({ line }) => line).join("\n")).toContain("NEW_HIDDEN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("does not certify a solid background or control surface through a border image", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    const image = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3" fill="${color}"/></svg>`)}`;
    const cases = [
      { css: "", button: false, visible: true },
      { css: `border:10px solid transparent;border-image:url("${image("black")}") 1 fill / 10px`, button: false, visible: false },
      { css: `border:0 solid transparent;border-image:url("${image("black")}") 1 / 100px`, button: false, visible: false },
      { css: "background:black", button: true, visible: true },
      { css: "background:black;box-shadow:inset 0 0 0 100px white", button: true, visible: false },
      { css: `background:black;border:10px solid transparent;border-image:url("${image("white")}") 1 fill / 10px`, button: true, visible: false },
    ];
    for (const item of cases) {
      await target.setContent(`<!doctype html><style>
        html,body{margin:0;min-height:700px;background:white;color:black;font:24px/32px Arial}
        #matte{position:relative;box-sizing:border-box;left:20px;top:20px;width:400px;height:150px;padding:30px;border:0;background:white;appearance:none;${item.css}}
        #independent{position:absolute;top:400px;left:20px}
        </style>${item.button ? '<button id="matte"></button>' : '<div id="matte"><span>BORDER_IMAGE_TEXT</span></div>'}
        <p id="independent">INDEPENDENT_VISIBLE</p>`);
      await target.evaluate(async () => {
        const source = getComputedStyle(document.querySelector("#matte")!).borderImageSource;
        const url = /^url\("(.*)"\)$/.exec(source)?.[1];
        if (url) { const image = new Image(); image.src = url; await image.decode(); }
        await document.fonts.ready;
      });
      const sample = await sampleInExtension(opened, target.url());
      const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
      expect(text, item.css).toContain("INDEPENDENT_VISIBLE");
      if (item.button) expect((sample as any).rows.some((row: any) => row.role === "button"), item.css).toBe(item.visible);
      else if (item.visible) expect(text).toContain("BORDER_IMAGE_TEXT");
      else expect(text).not.toContain("BORDER_IMAGE_TEXT");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("composites only backgrounds that survive their own clips and group opacity", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const cases = [
      // The absolute label escapes #clip; its static background does not.
      { clip: "0px", background: "white", source: "black", visible: false },
      { clip: "0px", background: "white", source: "black", mattePosition: "absolute", visible: true },
      { clip: "400px", background: "white", source: "black", visible: true },
      { clip: "400px", background: "black", source: "white", visible: false },
      { clip: "60px", background: "white", source: "black", visible: false },
      // An opaque inner fill does not cancel the outer group's opacity.
      { clip: "400px", background: "white", source: "black", opacity: ".5", visible: false },
      { clip: "400px", background: "white", source: "black", opacity: "1", visible: true },
    ];
    for (const item of cases) {
      await target.setContent(`<!doctype html><style>
        html,body{margin:0;min-height:700px;background:white;color:black;font:24px/32px Arial}
        #scope{position:relative;isolation:isolate;left:20px;top:20px;width:400px;height:150px}
        #source{position:relative;width:400px;height:150px;background:${item.source}}
        #group{position:relative;width:400px;height:150px;margin-top:-150px;opacity:${item.opacity ?? "1"}}
        #clip{overflow:hidden;width:${item.clip};height:${item.clip}}
        #matte{width:400px;height:150px;background:${item.background};position:${item.mattePosition ?? "static"}}
        #label{position:absolute;left:20px;top:20px;z-index:10;color:black}
        #independent{position:absolute;left:20px;top:400px}
        ${item.opacity ? "#source{visibility:hidden}#group::first-line,#group::first-letter{opacity:inherit}" : ""}
      </style><div id="scope"><div id="source"></div><div id="group"><div id="clip"><div id="matte"><span id="label">ESCAPED_LABEL</span></div></div></div></div><p id="independent">INDEPENDENT_VISIBLE</p>`);
      await target.evaluate(() => document.fonts.ready);
      const sample = await sampleInExtension(opened, target.url());
      const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
      expect(text, JSON.stringify(item)).toContain("INDEPENDENT_VISIBLE");
      expect.soft(text.includes("ESCAPED_LABEL"), JSON.stringify(item)).toBe(item.visible);
      if (item.opacity === ".5" || item.clip === "60px")
        expect((sample as any).gaps.some((gap: any) => gap.reason === "text-background"), JSON.stringify({ item, gaps: (sample as any).gaps })).toBe(true);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("proves higher stacking contexts without trusting DOM order or hit testing", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    const sample = async (markup: string, script?: () => void) => {
      await target.setContent(`<!doctype html><style>body{margin:0;font:16px monospace}p{margin:0}</style>${markup}`);
      if (script) await target.evaluate(script);
      const result = await sampleInExtension(opened, target.url());
      return readableSnapshot(result as any).map(({ line }) => line).join("\n");
    };
    const label = '<p style="position:absolute;left:20px;top:20px">VISIBLE_LABEL</p>';
    const positive = `<div style="display:flex"><nav style="z-index:31;width:400px;height:60px">${label}</nav></div>
      <main style="position:relative;z-index:1;height:250px;transform:translateX(0)">Main text<div style="box-shadow:0 0 100px black"></div></main>
      <style>main::before{content:'';position:fixed;inset:0;z-index:999;background:white}</style>
      <svg style="position:absolute;left:600px;top:0" width="20" height="20"><g transform="translate(-500 0)"><rect width="1000" height="1000"/></g></svg>`;
    expect(await sample(positive)).toContain("VISIBLE_LABEL");

    const cases = [
      // The overlay intercepts no pointer events, but still paints over text.
      `<div style="position:relative;z-index:5">${label}</div><div style="position:fixed;inset:0;z-index:6;background:white;pointer-events:none"></div>`,
      `<div style="position:relative;z-index:5">${label}</div><div style="position:fixed;inset:0;z-index:5;background:white"></div>`,
      // A child's high z-index cannot escape its lower parent context.
      `<div style="position:relative;z-index:1"><div style="position:relative;z-index:999">${label}</div></div><div style="position:fixed;inset:0;z-index:2;background:white"></div>`,
      // Outlines have unspecified paint order in the shared context.
      `<div style="position:relative;z-index:5">${label}</div><div style="position:absolute;left:100px;top:100px;width:1px;height:1px;outline:150px solid white"></div>`,
      // An ancestor's foreground outline can cover its own descendant text.
      `<div style="outline:100px solid white;outline-offset:-100px;width:200px;height:100px">${label}</div>`,
      // Pseudo paint may escape a non-context ancestor.
      `<div style="position:relative;z-index:5">${label}</div><div id="cover"></div><style>#cover::after{content:'';position:fixed;inset:0;z-index:99;background:white;pointer-events:none}</style>`,
      // A static z-index is effective on a grid item and cannot be dismissed.
      `<div style="position:relative;z-index:5">${label}</div><div style="display:grid"><div style="z-index:10;position:static"><div style="position:fixed;inset:0;background:white"></div></div></div>`,
      // A static z-index on an ordinary block does not elevate the label.
      `<div style="z-index:100">${label}</div><div style="position:fixed;inset:0;z-index:1;background:white"></div>`,
      ...['will-change:transform', 'container-type:inline-size', 'perspective:500px', 'transform-style:preserve-3d'].map(effect =>
        `<div style="position:relative;z-index:5">${label}</div><div style="position:absolute;left:0;top:0;width:1000px;height:700px;${effect}"><div style="position:fixed;inset:0;z-index:99;background:white"></div></div>`),
      `<div style="position:relative;z-index:5">${label}</div><svg style="position:absolute;left:600px;top:0;overflow:visible;z-index:6" width="20" height="20"><rect x="-600" width="1000" height="100" fill="white"/></svg>`,
    ];
    for (const markup of cases) expect(await sample(markup), markup).not.toContain("VISIBLE_LABEL");

    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><dialog>Modal</dialog>`,
      () => document.querySelector("dialog")!.showModal())).not.toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><div popover>Popover</div>`,
      () => document.querySelector<HTMLElement>("[popover]")!.showPopover())).toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><div popover style="position:fixed;inset:0;margin:0;width:1000px;height:700px;background:white">Popover</div>`,
      () => document.querySelector<HTMLElement>("[popover]")!.showPopover())).not.toContain("VISIBLE_LABEL");
    for (const ancestor of ["clip-path:inset(100%)", "mask-image:linear-gradient(transparent,transparent)", "position:relative;overflow:hidden", "opacity:0", "filter:opacity(0)"]) {
      expect(await sample(`${label}<div style="${ancestor};width:20px;height:20px"><div popover style="position:absolute;inset:0;margin:0;border:0;width:1000px;height:700px;background:white">Top layer</div></div>`,
        () => document.querySelector<HTMLElement>("[popover]")!.showPopover()), ancestor).not.toContain("VISIBLE_LABEL");
    }
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><unknown-widget></unknown-widget>`, () => {
      document.querySelector("unknown-widget")!.attachShadow({ mode: "closed" }).innerHTML = '<div style="position:fixed;inset:0;z-index:1000;background:white;pointer-events:none"></div>';
    })).not.toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><div id="closed-host"></div>`, () => {
      const root = document.querySelector("#closed-host")!.attachShadow({ mode: "closed" });
      root.innerHTML = '<div popover style="position:fixed;inset:0;margin:0;max-width:none;max-height:none;width:100vw;height:100vh;background:white;pointer-events:none"></div>';
      root.querySelector<HTMLElement>("[popover]")!.showPopover();
    })).not.toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><shadow-widget></shadow-widget>`, () => {
      const root = document.querySelector("shadow-widget")!.attachShadow({ mode: "open" });
      root.innerHTML = '<dialog>Modal</dialog>'; root.querySelector("dialog")!.showModal();
    })).not.toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><div id="fullscreen" style="background:white"></div>`,
      () => document.querySelector<HTMLElement>("#fullscreen")!.requestFullscreen())).not.toContain("VISIBLE_LABEL");
    await target.evaluate(() => document.exitFullscreen());
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("read-only text preserves painted whitespace without publishing source indentation", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;font:16px monospace}p,pre{margin:0;height:35px}pre{height:60px}</style>
      <p><span>\n    ALPHA   BETA    \n</span></p>
      <p><span>LEFT</span><span>  RIGHT</span></p>
      <p>NBSP&nbsp;VALUE</p>
      <pre>  PRE\n   VALUE</pre><p>REPEATED</p><p>REPEATED</p>`);
    const sample = await sampleInExtension(opened, target.url());
    const values = (sample as any).rows.map((row: any) => row.text);
    expect(values).toContain("ALPHA BETA");
    const fragments = (sample as any).rows.flatMap((row: any) => row.textFragments || []).map((part: any) => part.text);
    expect(fragments).toContain("LEFT");
    expect(fragments).toContain(" RIGHT");
    expect(values).toContain("NBSP\u00a0VALUE");
    expect(values).toContain("  PRE\n   VALUE");
    const repeated = (sample as any).rows.filter((row: any) => row.text === "REPEATED");
    expect(repeated).toHaveLength(2);
    expect(repeated[0].bounds[1]).toBeLessThan(repeated[1].bounds[1]);
    const lines = readableSnapshot(sample as any).filter(({ line }) => line.includes("REPEATED"));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.line).toContain("[box=");
    expect(lines[0]!.line).not.toBe(lines[1]!.line);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("read-only sampling handles deep DOM and shadow chains without recursive traversal", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = "";
      let parent: Element = document.body;
      for (let i = 0; i < 1200; i++) { const child = document.createElement("div"); parent.append(child); parent = child; }
      parent.textContent = "DEEP_VISIBLE";
    });
    let sample = await sampleInExtension(opened, target.url());
    expect((sample as any).rows.some((row: any) => row.text === "DEEP_VISIBLE")).toBe(true);
    await target.evaluate(() => {
      document.body.innerHTML = '<div style="position:relative;z-index:5">DEEP_COVERED</div>';
      let root: ParentNode = document.body;
      for (let i = 0; i < 350; i++) { const host = document.createElement("div"); root.append(host); root = host.attachShadow({ mode: "closed" }); }
      const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:10;background:white;pointer-events:none"; root.append(cover);
    });
    sample = await sampleInExtension(opened, target.url());
    expect((sample as any).rows.some((row: any) => row.text === "DEEP_COVERED")).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("bounds masked foreign paint only when the group clip is proven", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    const set = async (extra: string, child: string) => {
      await target.setContent(`<!doctype html><style>body{margin:0;font:16px monospace}p{margin:0;position:absolute;left:20px} #inside{top:20px} #outside{top:300px}</style>
        <p id="inside">INSIDE_MASK</p><p id="outside">OUTSIDE_MASK</p>
        <div id="mask" style="position:absolute;left:0;top:0;width:200px;height:100px;mask-image:linear-gradient(black,black);${extra}">${child}</div>`);
    };
    const overlay = '<div style="position:fixed;inset:0;z-index:999;background:white;pointer-events:none"></div>';
    await set("mask-clip:border-box", overlay);
    let sample = await sampleInExtension(opened, target.url());
    let values = (sample as any).rows.map((row: any) => row.text);
    expect(values).toContain("OUTSIDE_MASK");
    expect(values).not.toContain("INSIDE_MASK");

    await set("mask-clip:border-box", '<div id="host"></div>');
    await target.evaluate(() => {
      const root = document.querySelector("#host")!.attachShadow({ mode: "closed" });
      root.innerHTML = '<style>:host::before{content:"";position:fixed;inset:0;z-index:999;background:white;pointer-events:none}</style>';
    });
    sample = await sampleInExtension(opened, target.url());
    values = (sample as any).rows.map((row: any) => row.text);
    expect(values).toContain("OUTSIDE_MASK");
    expect(values).not.toContain("INSIDE_MASK");

    await set("mask-clip:no-clip;mask-size:100vw 100vh", overlay);
    sample = await sampleInExtension(opened, target.url());
    values = (sample as any).rows.map((row: any) => row.text);
    expect(values).not.toContain("OUTSIDE_MASK");

    // Overflow alone does not clip fixed descendants whose containing block
    // lies outside the overflow box.
    await target.setContent(`<!doctype html><style>body{margin:0}p{position:absolute;top:300px}</style>
      <p>FIXED_ESCAPE</p><div style="overflow:hidden;width:200px;height:100px">${overlay}</div>`);
    sample = await sampleInExtension(opened, target.url());
    expect((sample as any).rows.map((row: any) => row.text)).not.toContain("FIXED_ESCAPE");

    // A filter outside the mask can expand the composited result again.
    await target.setContent(`<!doctype html><style>body{margin:0}p{position:absolute;top:200px}</style>
      <p>FILTER_UNKNOWN</p><div style="filter:blur(100px)"><div style="width:200px;height:100px;mask-image:linear-gradient(black,black)">${overlay}</div></div>`);
    sample = await sampleInExtension(opened, target.url());
    expect((sample as any).rows.map((row: any) => row.text)).not.toContain("FILTER_UNKNOWN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("only accepts text wholly inside proven rounded overflow clips", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;font:16px monospace}.box{position:absolute;overflow:hidden;width:240px;height:100px;border:2px solid black;border-radius:30px}.text{position:absolute;white-space:nowrap}</style>
      <div class="box" style="left:10px;top:10px"><span class="text" style="left:60px;top:40px">SAFE_CENTER</span></div>
      <div class="box" style="left:10px;top:150px"><span class="text" style="left:0;top:0">CLIPPED_CORNER</span></div>
      <div class="box" style="left:10px;top:300px;border-radius:30%"><span class="text" style="left:60px;top:40px">PERCENT_VISIBLE</span></div>
      <div class="box" style="left:10px;top:450px;width:180px;height:36px;border-radius:9999px;background:oklab(.6 .1 0 / .2)"><span class="text" style="left:30px;top:7px">PILL_VISIBLE</span></div>
      <span id="fractional" style="position:absolute;left:10px;top:530px;display:inline-block;overflow:hidden;white-space:nowrap;font-size:13px">FRACTIONAL_FIT</span>`);
    const measured = await target.locator("#fractional").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      for (const size of [13, 13.1, 13.2, 13.3, 13.4]) {
        (element as HTMLElement).style.fontSize = `${size}px`;
        const width = range.getBoundingClientRect().width;
        (element as HTMLElement).style.width = `${width}px`;
        if (width > element.clientWidth) return { width, client: element.clientWidth };
      }
      throw new Error("The fixture must exercise clientWidth rounding down");
    });
    expect(measured.width).toBeGreaterThan(measured.client);
    const sample = await sampleInExtension(opened, target.url());
    const values = (sample as any).rows.map((row: any) => row.text);
    expect(values).toContain("SAFE_CENTER");
    expect(values).not.toContain("CLIPPED_CORNER");
    expect(values).toContain("PERCENT_VISIBLE");
    expect(values).toContain("PILL_VISIBLE");
    expect(values).toContain("FRACTIONAL_FIT");
    await target.locator("#fractional").evaluate((element) => {
      (element as HTMLElement).style.width = `${element.getBoundingClientRect().width - 1}px`;
    });
    const clipped = await sampleInExtension(opened, target.url());
    expect((clipped as any).rows.some((row: any) => row.text === "FRACTIONAL_FIT")).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("bounds foreign paint without cropping shadows or escaping descendants", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    const cases = [
      { visible: true, name: "NEUTRAL_GEOMETRY", body: '<div style="transform:matrix(1,0,0,1,0,0);scale:1">LABEL</div><div style="position:absolute;top:900px;translate:-50% -50%">Foreign text</div>' },
      { visible: true, name: "EMPTY_HIT_AREA", body: '<p id="label">LABEL</p><style>#label::after{content:"";position:absolute;inset:0}</style>' },
      { visible: true, name: "EMPTY_UNDERLINED_LINK", body: '<p>LABEL</p><a href="/" style="position:fixed;inset:0;text-decoration:underline"></a>' },
      { visible: true, name: "REPLACED_UNDERLINED_LINK", body: '<p>LABEL</p><a href="/" style="position:absolute;left:900px;top:600px;text-decoration:underline"><img width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a>' },
      { visible: true, name: "NO_MARKER_REMOTE_LIST", body: '<p>LABEL</p><ul style="position:absolute;top:1000px;list-style:none"><li>Footer item</li></ul>' },
      { visible: false, name: "FLOW_ROOT_MARKER", body: `<p style="position:absolute;left:50px;top:60px">LABEL</p><li style="position:absolute;left:400px;top:40px;width:100px;height:20px;display:flow-root list-item;list-style-position:outside;list-style-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22100%22%3E%3Crect width=%22400%22 height=%22100%22 fill=%22white%22/%3E%3C/svg%3E');color:white">X</li>` },
      { visible: true, name: "HIDDEN_PSEUDO", body: '<p id="label">LABEL</p><style>#label::after{content:"";position:fixed;inset:0;background:white;opacity:0}</style>' },
      { visible: true, name: "DISTANT_SHADOW", body: '<p>LABEL</p><div style="position:absolute;top:600px;width:20px;height:20px;box-shadow:0 2px 6px black"></div>' },
      { visible: true, name: "MIXED_TEXT", body: '<p style="background:white">Prefix <span>LABEL</span> suffix</p>' },
      { visible: true, name: "SCALED_DOT", body: '<div style="position:relative;overflow:hidden;width:600px;height:400px"><p style="position:absolute;left:20px;top:100px">LABEL</p><div style="position:absolute;left:-200px;top:300px;width:10px;height:10px;border-radius:50%;background:red;transform:scale(1.8)"></div></div>' },
      { visible: false, name: "OWN_SHADOW", body: '<div style="position:relative;z-index:1;overflow:hidden;width:100px;height:60px;box-shadow:0 0 0 1000px white"></div><p style="position:absolute;top:0;left:200px">LABEL</p>' },
      { visible: true, name: "NESTED_CLIPS", body: '<p style="position:absolute;left:200px">LABEL</p><div style="position:relative;overflow:hidden;width:100px;height:60px"><div style="position:relative;overflow:hidden;left:200px;width:100px;height:60px"><div style="position:absolute;inset:0;background:white"></div></div></div>' },
      { visible: true, name: "SVG_OWN_CLIP", body: '<div style="position:relative;overflow:hidden;width:600px;height:300px"><p style="position:absolute;top:100px;left:20px">LABEL</p><svg width="18" height="18" style="position:absolute;left:500px;top:0;overflow:hidden;z-index:10"><rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/></svg></div>' },
      { visible: true, name: "MIRRORED_SVG", body: '<p style="position:absolute;top:100px;left:20px">LABEL</p><svg width="16" height="16" style="position:absolute;left:219px;top:83px;overflow:hidden;scale:1 -1"><path d="M1 1h14v14H1z" fill="black"/></svg>' },
      { visible: true, name: "PROPAGATED_CANVAS", body: '<style>html{background:transparent}body{background:black}p{color:white}</style><p style="position:absolute;top:100px;left:20px">LABEL</p>' },
      { visible: true, name: "ROOT_CANVAS", body: '<style>html{background:black}body{background:white}p{color:white}</style><p style="position:absolute;top:100px;left:20px">LABEL</p>' },
      { visible: false, name: "SAME_CANVAS_COLOR", body: '<p style="position:absolute;top:100px;left:20px;color:white">LABEL</p>' },
      { visible: true, name: "ABOVE_SVG_ROOT", body: '<svg width="600" height="300" style="position:absolute;overflow:visible"><rect width="600" height="300" fill="white"/></svg><p style="position:relative;z-index:1">LABEL</p>' },
      { visible: false, name: "BELOW_SVG_ROOT", body: '<svg width="600" height="300" style="position:absolute;overflow:visible;z-index:2"><rect width="600" height="300" fill="white"/></svg><p style="position:relative;z-index:1">LABEL</p>' },
      { visible: true, name: "FOREIGN_CONTEXT_BOUNDARY", body: '<svg width="600" height="300" style="position:absolute;overflow:visible"><foreignObject width="600" height="300"><div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;inset:0;z-index:99999;background:white"></div></foreignObject></svg><p style="position:relative;z-index:1">LABEL</p>' },
      { visible: true, name: "SVG_ANCESTOR_CLIP", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><svg width="10" height="10" style="overflow:visible"><rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/></svg></div>' },
      { visible: false, name: "FIXED_PSEUDO_ESCAPE", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><div id="cover"></div></div><style>#cover::after{content:"";position:fixed;inset:0;background:white;pointer-events:none}</style>' },
      { visible: false, name: "SVG_FOREIGN_ESCAPE", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><svg width="10" height="10" style="overflow:visible"><foreignObject width="200" height="200"><div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;inset:0;background:white"></div></foreignObject></svg></div>' },
      { visible: false, name: "FILTER_AFTER_CLIP", body: '<p>LABEL</p><div style="position:relative;z-index:1;overflow:hidden;top:900px;width:100px;height:60px;filter:blur(100px)"><div style="width:100px;height:60px;background:white"></div></div>' },
      { visible: true, name: "CLIP_AFTER_FILTER", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:60px"><div style="filter:blur(100px);width:100px;height:60px;background:white"></div></div>' },
    ];
    for (const { body, name, visible } of cases) {
      await target.setContent(`<!doctype html><style>html,body{margin:0;color:black;background:white;font:16px monospace}p{margin:0}</style>${body.replace("LABEL", name)}`);
      const sample = await sampleInExtension(opened, target.url());
      expect((sample as any).rows.some((row: any) => row.text === name || row.textFragments?.some((fragment: any) => fragment.text === name)), name).toBe(visible);
    }
    await target.setContent(`<!doctype html><style>html,body{margin:0;color:black;background:white;font:16px Arial}p{margin:0}</style>
      <p style="position:absolute;top:40px;left:0">DECORATION_HIDDEN</p>
      <a id="decorator" style="position:absolute;left:0;top:1000px;color:white;text-decoration:underline solid white;text-underline-offset:-1000px;text-decoration-thickness:200px"></a>`);
    await target.evaluate(() => {
      // This is an HTMLUnknownElement, not an SVG replaced element.
      const element = document.createElement("svg"); element.textContent = "W".repeat(40);
      document.querySelector("#decorator")!.append(element);
    });
    const decorated: any = await sampleInExtension(opened, target.url());
    expect(readableSnapshot(decorated).map((row) => row.line).join("\n")).not.toContain("DECORATION_HIDDEN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("withholds read-only text until page fonts have finished loading", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await opened.context.route(`${provider.origin}/snapshot-pending.woff2`, async (route) => {
      await pending; await route.fulfill({ status: 404, body: "Missing test font" });
    });
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.setContent('<p style="color:black;background:white">FONT_WAIT_LABEL</p>');
    await target.evaluate((origin) => {
      const font = new FontFace("SnapshotPending", `url(${origin}/snapshot-pending.woff2)`, { display: "block" });
      document.fonts.add(font);
      document.querySelector<HTMLElement>("p")!.style.fontFamily = "SnapshotPending, sans-serif";
      void font.load().catch(() => undefined);
    }, provider.origin);
    await target.waitForFunction(() => document.fonts.status === "loading");
    expect(await target.evaluate(() => document.readyState)).toBe("complete");
    expect(await sampleInExtension(opened, target.url())).toBeNull();
    release();
    await target.evaluate(() => document.fonts.ready);
    const loaded = await sampleInExtension(opened, target.url());
    expect((loaded as any).rows.some((row: any) => row.text === "FONT_WAIT_LABEL")).toBe(true);
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("synchronous semantic sampling preserves controls, false states, local coverage and stable transport identity", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;background:white;color:black;font:16px Arial}p{margin:0}button{margin:6px}a{text-decoration:none}</style>
      <nav style="mask-image:linear-gradient(to right,transparent 0px,black 0px,black 100%,transparent 100%)">
        <a href="/hot" aria-current="page">热门</a> <a href="/politics">政治</a>
      </nav>
      <main><h1>Markets</h1><button id="predict" aria-expanded="false">Predict</button><button disabled>Unavailable</button>
      <button role="switch" aria-checked="true">Toggle</button>
      <label><input id="check" type="checkbox" checked>Enabled</label><button id="unknown" aria-label="HIDDEN_ACCESSIBLE_NAME" style="width:40px;height:30px"></button>
      <button id="invisible-empty" style="width:40px;height:30px;background:transparent;border:0" aria-label="INVISIBLE_EMPTY_BUTTON"></button>
      <button style="display:none">HIDDEN_BUTTON</button><button style="opacity:0">INVISIBLE_BUTTON</button>
      <input aria-label="HIDDEN_FIELD_NAME" value="UNPAINTED_VALUE"><p>Separate paragraph</p>
      <button id="partial">Known<span style="text-transform:uppercase"> unverified</span></button>
      <section id="host"></section><iframe srcdoc="<p>FRAME_TEXT</p>"></iframe>
      <canvas width="20" height="20"></canvas></main>`);
    await target.evaluate(() => {
      document.querySelector("#host")!.attachShadow({ mode: "closed" }).innerHTML = '<button>SHADOW_TEXT</button><slot></slot>';
    });
    const invisibleBox = await target.locator("#invisible-empty").evaluate((element) => {
      const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
    });
    const first: any = await sampleInExtension(opened, target.url());
    const text = readableSnapshot(first).map((row) => row.line).join("\n");
    expect(text).toContain('link "热门"'); expect(text).toContain('link "政治"');
    expect(text).toContain("current=page"); expect(text).toContain("level=1");
    expect(text).toContain('button "Predict"'); expect(text).toContain("expanded=false"); expect(text).toContain("disabled=true");
    expect(text).toContain("checkbox"); expect(text).toContain("checked=true");
    expect(text).toContain('switch "Toggle"');
    expect(first.rows.some((row: any) => row.role === "button" && row.bounds?.every((value: number, index: number) => Math.abs(value - invisibleBox[index]) < .01))).toBe(false);
    expect(text).toContain("button [name=unknown]"); expect(text).toContain("[value=unknown]");
    expect(text).not.toMatch(/HIDDEN_ACCESSIBLE_NAME|HIDDEN_FIELD_NAME|UNPAINTED_VALUE|HIDDEN_BUTTON|INVISIBLE_BUTTON|FRAME_TEXT/);
    expect(text).toContain('button "SHADOW_TEXT"');
    const partial = first.rows.find((row: any) => row.role === "button" && row.text === "Known");
    expect(partial?.nameUnknown).toBe(true);
    expect(first.gaps.map((gap: any) => gap.reason)).toEqual(expect.arrayContaining(["embedded-document", "visual-content", "text-paint"]));
    expect(first.gaps.some((gap: any) => gap.reason === "shadow-content" || gap.reason === "slotted-content")).toBe(false);
    const predict = first.rows.find((row: any) => row.role === "button" && row.text === "Predict");
    expect(predict?.key).toEqual(expect.any(Number));
    await target.evaluate(() => { const before = document.createElement("p"); before.textContent = "New preceding content"; document.body.prepend(before); });
    const second: any = await sampleInExtension(opened, target.url());
    expect(second.rows.find((row: any) => row.role === "button" && row.text === "Predict")?.key).toBe(predict.key);
    expect(second.rows.every((row: any) => !row.ref && !row.actions)).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("samples author shadow and assigned slots in composed order without duplicating hidden fallback", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;background:white;color:black;font:16px Arial}</style>
      <main><h1>Composed content</h1>
        <div id="closed" style="background:black;color:white"><span slot="second">SECOND</span><span slot="first">FIRST</span><span>UNASSIGNED_SECRET</span></div>
        <div id="assigned"><span slot="named">ASSIGNED_VISIBLE</span></div>
        <div id="manual"><span>RAW_FIRST</span><span>RAW_SECOND</span></div>
        <div id="direct" style="background:black;color:black">DIRECT_TEXT</div>
        <div id="nested-on"><span slot="inner">NESTED_ASSIGNED</span></div>
        <div id="nested-off"><span slot="outer">OUTER_ASSIGNED</span><span slot="inner">NESTED_NOT_RENDERED</span></div>
        <div id="hidden" style="display:none"></div><div id="empty"></div>
      </main>`);
    await target.evaluate(() => {
      document.querySelector("#closed")!.attachShadow({ mode: "closed" }).innerHTML = `<style>button{font:inherit;color:inherit;background:transparent;border:0;padding:0}</style>
        <div role="group"><button aria-expanded="false"><slot name="first"></slot><span> / </span><slot name="second"></slot></button><slot name="missing">FALLBACK_VISIBLE</slot></div>`;
      document.querySelector("#assigned")!.attachShadow({ mode: "open" }).innerHTML = '<slot name="named"><button>FALLBACK_NOT_RENDERED</button></slot>';
      document.querySelector("#hidden")!.attachShadow({ mode: "closed" }).innerHTML = '<button>HIDDEN_SHADOW</button>';
      document.querySelector("#empty")!.attachShadow({ mode: "closed" });
      document.querySelector("#direct")!.attachShadow({ mode: "closed" }).innerHTML = '<slot style="color:white"></slot>';
      for (const id of ["nested-on", "nested-off"]) document.getElementById(id)!.attachShadow({ mode: "closed" }).innerHTML = '<div role="group"><slot name="outer"><slot name="inner">NESTED_FALLBACK_NOT_RENDERED</slot></slot></div>';
      const host = document.querySelector("#manual")!, children = [...host.children];
      const root = host.attachShadow({ mode: "closed", slotAssignment: "manual" });
      root.innerHTML = '<div role="group"><slot></slot></div>';
      (root.querySelector("slot") as HTMLSlotElement).assign(children[1]!, children[0]!);
    });
    const sample: any = await sampleInExtension(opened, target.url());
    const text = readableSnapshot(sample).map((row) => row.line).join("\n");
    const button = sample.rows.find((row: any) => row.role === "button" && row.text === "FIRST / SECOND");
    expect(button).toBeDefined(); expect(button.state.expanded).toBe(false);
    expect(button.textFragments.map((fragment: any) => fragment.text)).toEqual(["FIRST", " / ", "SECOND"]);
    expect(text).toContain("ASSIGNED_VISIBLE"); expect(text).toContain("FALLBACK_VISIBLE");
    expect(text).toContain("DIRECT_TEXT"); expect(text).toContain("NESTED_ASSIGNED"); expect(text).toContain("OUTER_ASSIGNED");
    expect(text).not.toMatch(/UNASSIGNED_SECRET|FALLBACK_NOT_RENDERED|HIDDEN_SHADOW|NESTED_NOT_RENDERED/);
    expect(sample.rows.filter((row: any) => row.text === "ASSIGNED_VISIBLE")).toHaveLength(1);
    const first = sample.rows.findIndex((row: any) => row.text === "RAW_FIRST"), second = sample.rows.findIndex((row: any) => row.text === "RAW_SECOND");
    expect(second).toBeGreaterThanOrEqual(0); expect(first).toBeGreaterThan(second);
    expect(sample.gaps.some((gap: any) => gap.reason === "shadow-content" || gap.reason === "slotted-content")).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("retains unconfirmed text geometry while excluding proven-hidden text and original DOM labels", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;background:white;color:black;font:16px Arial}p{margin:0}</style>
      <main><p id="unknown-paragraph" style="text-transform:uppercase">paragraph_dom_unverified</p>
        <span id="unknown-main" style="text-transform:uppercase">main_dom_unverified</span>
        <button id="prefix">Known <span style="text-transform:uppercase">button_dom_unverified</span></button>
        <p id="empty-clip" style="clip-path:inset(100%)">clip_dom_hidden</p>
        <p id="same-color" style="color:white">color_dom_hidden</p>
        <p id="transparent" style="color:transparent;text-transform:uppercase">transparent_dom_hidden</p>
        <p style="opacity:0">opacity_dom_hidden</p><p style="display:none">display_dom_hidden</p>
      </main><nav><span id="unknown-nav" style="text-transform:uppercase">nav_dom_unverified</span></nav>`);
    const geometry = await target.evaluate(() => Object.fromEntries(["unknown-paragraph", "unknown-main", "unknown-nav", "empty-clip", "same-color", "transparent"].map((id) => {
      const node = document.getElementById(id)!.firstChild!, range = document.createRange(); range.selectNodeContents(node);
      const r = document.getElementById(id)!.localName === "p" ? document.getElementById(id)!.getBoundingClientRect() : range.getBoundingClientRect();
      return [id, [r.x, r.y, r.width, r.height]];
    })));
    const sample: any = await sampleInExtension(opened, target.url());
    const lines = readableSnapshot(sample).map((row) => row.line).join("\n"), raw = JSON.stringify(sample);
    expect(raw).not.toMatch(/(?:paragraph|main|button|nav)_dom_unverified|(?:clip|color|transparent|opacity|display)_dom_hidden/i);
    const near = (a: number[], b: number[]) => a?.every((value, index) => Math.abs(value - b[index]!) < .01);
    const unknown = (id: string) => sample.rows.find((row: any) => row.nameUnknown && near(row.bounds, geometry[id]!));
    expect(unknown("unknown-paragraph")?.role).toBe("paragraph");
    for (const id of ["unknown-main", "unknown-nav"]) expect(unknown(id)?.role).toBe("text");
    for (const id of ["empty-clip", "same-color", "transparent"]) expect(unknown(id)).toBeUndefined();
    const prefix = sample.rows.find((row: any) => row.role === "button" && row.text === "Known ");
    expect(prefix?.nameUnknown, JSON.stringify(sample.rows)).toBe(true); expect(prefix.textFragments).toHaveLength(1);
    expect(lines).toContain("[name=unknown]");
    expect(sample.rows.filter((row: any) => ["main", "navigation"].includes(row.role)).every((row: any) => !row.text && !row.nameUnknown)).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("retains native roles and checked state while detecting uncertain control compositing", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>html,body{margin:0;background:white;color:black}progress,meter{width:150px;height:24px}</style>
      <progress value=".7" max="1"></progress><meter value=".7" max="1"></meter>
      <input type="color" value="#ff0000"><input type="file"><input type="checkbox" role="switch" checked>
      <audio controls></audio><input id="blend" type="checkbox" checked style="mix-blend-mode:screen">
      <div id="blend-surface" role="button" style="width:80px;height:30px;background:black;mix-blend-mode:screen"></div>
      <div id="text-clipped-fill" role="button" style="width:80px;height:30px;background:black;background-clip:text"></div>
      <div id="image-covered-fill" role="button" style="width:80px;height:30px;background:black linear-gradient(white,white)"></div>
      <div role="BUTTON" aria-expanded="FALSE" aria-pressed="TRUE" style="width:200px;height:30px;background:black;color:white">Upper button</div>
      <div role="SwItCh" aria-checked="TRUE" style="width:200px;height:30px;background:black;color:white">Upper switch</div>`);
    const boxes = await target.evaluate(() => Object.fromEntries(["blend", "blend-surface", "text-clipped-fill", "image-covered-fill"].map((id) => {
      const r = document.getElementById(id)!.getBoundingClientRect(); return [id, [r.x, r.y, r.width, r.height]];
    })));
    const sample: any = await sampleInExtension(opened, target.url());
    for (const role of ["progressbar", "meter", "ColorWell"]) expect(sample.rows.some((row: any) => row.role === role)).toBe(true);
    expect(sample.rows.find((row: any) => row.role === "switch")?.state?.checked).toBe(true);
    expect(sample.rows.find((row: any) => row.role === "switch" && row.text === "Upper switch")?.state?.checked).toBe(true);
    expect(sample.rows.find((row: any) => row.role === "button" && row.text === "Upper button")?.state).toMatchObject({ expanded: false, pressed: true });
    expect(sample.rows.some((row: any) => row.role === "textbox")).toBe(false);
    expect(sample.gaps.some((gap: any) => gap.role === "Audio")).toBe(true);
    expect(sample.gaps.some((gap: any) => gap.reason === "control-presence" && gap.role === "button")).toBe(true);
    for (const box of Object.values(boxes)) expect(sample.rows.some((row: any) => row.bounds?.every((value: number, index: number) => Math.abs(value - box[index]!) < .01))).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("uses local clip exclusion before uncertain backgrounds without hiding escaping positioned text", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>body{margin:0;background:white;color:black;font:16px Arial}p{margin:0}</style>
      <button style="border-radius:999999999px;overflow:hidden">PILL_VISIBLE</button>
      <p style="box-shadow:inset 0 0 0 20px lab(0 0 0 / 0)">TRANSPARENT_SHADOW_VISIBLE</p>
      <div style="position:relative;overflow:hidden;width:100px;height:30px;background:linear-gradient(white,black)">
        <p style="position:absolute;top:60px">CLIPPED_SECRET</p>
      </div>
      <div style="overflow:hidden;width:100px;height:10px"><p style="position:fixed;top:150px;left:0">FIXED_ESCAPE_VISIBLE</p></div>
      <div style="position:relative"><div style="overflow:hidden;width:100px;height:10px"><p style="position:absolute;top:200px;left:0">ABSOLUTE_ESCAPE_VISIBLE</p></div></div>
      <span style="display:contents;overflow:hidden"><span>CONTENTS_VISIBLE</span></span>
      <div style="overflow:hidden;width:10px;height:10px"><span style="display:contents;position:relative"><p style="position:absolute;top:350px;left:0">CONTENTS_CB_ESCAPE_VISIBLE</p></span></div>
      <div style="position:relative;overflow:hidden;width:100px;height:10px"><p style="position:absolute;top:250px">CONTAINED_SECRET</p></div>`);
    const sample: any = await sampleInExtension(opened, target.url());
    const text = readableSnapshot(sample).map((row) => row.line).join("\n");
    for (const name of ["PILL_VISIBLE", "TRANSPARENT_SHADOW_VISIBLE", "FIXED_ESCAPE_VISIBLE", "ABSOLUTE_ESCAPE_VISIBLE", "CONTENTS_VISIBLE", "CONTENTS_CB_ESCAPE_VISIBLE"]) expect(text, name).toContain(name);
    expect(JSON.stringify(sample)).not.toMatch(/CLIPPED_SECRET|CONTAINED_SECRET/);
    // The clipped paragraphs have no unknown text rows left behind.
    const hiddenBoxes = await target.locator("p").evaluateAll((elements) => elements.filter((element) => element.textContent?.includes("SECRET")).map((element) => {
      const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }));
    for (const box of hiddenBoxes) expect(sample.rows.some((row: any) => row.nameUnknown && row.bounds?.every((value: number, index: number) => Math.abs(value - box[index]!) < .01)), JSON.stringify({ box, rows: sample.rows, gaps: sample.gaps })).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("distinguishes positioning containing blocks from visually neutral effects and uncertain animation", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const styles = ["transform:translateX(0)", "translate:0px", "will-change:transform", "will-change:filter", "will-change:offset",
      "offset-position:0px 0px", "transform-style:preserve-3d", "animation:hold 100s infinite"];
    for (const position of ["absolute", "fixed"]) {
      for (const style of ["", "will-change:opacity", "container-type:inline-size", "position:relative", ...styles]) {
        await target.setContent(`<!doctype html><style>html,body{margin:0;background:white;color:black;font:16px Arial}p{margin:0}
          @keyframes hold{from{transform:none}to{transform:none}}</style>
          <div style="margin-left:200px;margin-top:100px"><div style="width:100px;height:20px;overflow:hidden;${style}">
          <p style="position:${position};left:0;top:100px">POSITIONED_LABEL</p></div></div>`);
        const sample: any = await sampleInExtension(opened, target.url());
        const visible = !styles.includes(style) && (style !== "position:relative" || position === "fixed");
        expect(readableSnapshot(sample).map((row) => row.line).join("\n").includes("POSITIONED_LABEL"), `${position};${style}`).toBe(visible);
        if (style.startsWith("animation:")) expect(sample.gaps.some((gap: any) => gap.reason === "clip-coverage")).toBe(true);
      }
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
