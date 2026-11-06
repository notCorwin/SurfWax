import { expect } from "@playwright/test";
import { test, openExtension, dispose, startProvider } from "./fixtures";
import { readableSnapshot, sampleReadableSnapshot } from "../src/chrome/snapshot-readable";

test.use({ screenshot: "off", trace: "off" });

async function sampleInExtension(opened: Awaited<ReturnType<typeof openExtension>>, url: string) {
  await expect(opened.page.getByTestId("open-settings")).toBeVisible();
  const cdp = await opened.context.newCDPSession(opened.page);
  try {
    const response = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === ${JSON.stringify(url)});
        if (!tab) throw new Error("Target tab not found");
        const [sample] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: (${sampleReadableSnapshot.toString()}) });
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
      `<div style="position:relative;z-index:5">${label}</div><svg style="position:absolute;left:600px;top:0;overflow:visible" width="20" height="20"><rect x="-600" width="1000" height="100" fill="white"/></svg>`,
    ];
    for (const markup of cases) expect(await sample(markup), markup).not.toContain("VISIBLE_LABEL");

    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><dialog>Modal</dialog>`,
      () => document.querySelector("dialog")!.showModal())).not.toContain("VISIBLE_LABEL");
    expect(await sample(`<div style="position:relative;z-index:999">${label}</div><div popover>Popover</div>`,
      () => document.querySelector<HTMLElement>("[popover]")!.showPopover())).not.toContain("VISIBLE_LABEL");
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
    expect(values).toContain("LEFT");
    expect(values).toContain(" RIGHT");
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
      { visible: true, name: "HIDDEN_PSEUDO", body: '<p id="label">LABEL</p><style>#label::after{content:"";position:fixed;inset:0;background:white;opacity:0}</style>' },
      { visible: true, name: "DISTANT_SHADOW", body: '<p>LABEL</p><div style="position:absolute;top:600px;width:20px;height:20px;box-shadow:0 2px 6px black"></div>' },
      { visible: true, name: "MIXED_TEXT", body: '<p style="background:white">Prefix <span>LABEL</span> suffix</p>' },
      { visible: true, name: "SCALED_DOT", body: '<div style="position:relative;overflow:hidden;width:600px;height:400px"><p style="position:absolute;left:20px;top:100px">LABEL</p><div style="position:absolute;left:-200px;top:300px;width:10px;height:10px;border-radius:50%;background:red;transform:scale(1.8)"></div></div>' },
      { visible: false, name: "OWN_SHADOW", body: '<div style="position:relative;z-index:1;overflow:hidden;width:100px;height:60px;box-shadow:0 0 0 1000px white"></div><p style="position:absolute;top:0;left:200px">LABEL</p>' },
      { visible: true, name: "NESTED_CLIPS", body: '<p style="position:absolute;left:200px">LABEL</p><div style="position:relative;overflow:hidden;width:100px;height:60px"><div style="position:relative;overflow:hidden;left:200px;width:100px;height:60px"><div style="position:absolute;inset:0;background:white"></div></div></div>' },
      { visible: true, name: "SVG_OWN_CLIP", body: '<div style="position:relative;overflow:hidden;width:600px;height:300px"><p style="position:absolute;top:100px;left:20px">LABEL</p><svg width="18" height="18" style="position:absolute;left:500px;top:0;overflow:hidden;z-index:10"><rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/></svg></div>' },
      { visible: true, name: "SVG_ANCESTOR_CLIP", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><svg width="10" height="10" style="overflow:visible"><rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/></svg></div>' },
      { visible: false, name: "FIXED_PSEUDO_ESCAPE", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><div id="cover"></div></div><style>#cover::after{content:"";position:fixed;inset:0;background:white;pointer-events:none}</style>' },
      { visible: false, name: "SVG_FOREIGN_ESCAPE", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:100px"><svg width="10" height="10" style="overflow:visible"><foreignObject width="200" height="200"><div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;inset:0;background:white"></div></foreignObject></svg></div>' },
      { visible: false, name: "FILTER_AFTER_CLIP", body: '<p>LABEL</p><div style="position:relative;z-index:1;overflow:hidden;top:900px;width:100px;height:60px;filter:blur(100px)"><div style="width:100px;height:60px;background:white"></div></div>' },
      { visible: true, name: "CLIP_AFTER_FILTER", body: '<p>LABEL</p><div style="position:relative;overflow:hidden;top:900px;width:100px;height:60px"><div style="filter:blur(100px);width:100px;height:60px;background:white"></div></div>' },
    ];
    for (const { body, name, visible } of cases) {
      await target.setContent(`<!doctype html><style>html,body{margin:0;color:black;background:white;font:16px monospace}p{margin:0}</style>${body.replace("LABEL", name)}`);
      const sample = await sampleInExtension(opened, target.url());
      expect((sample as any).rows.some((row: any) => row.text === name), name).toBe(visible);
    }
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
