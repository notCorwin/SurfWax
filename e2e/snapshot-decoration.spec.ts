import { expect } from "@playwright/test";
import { test, openExtension, dispose, startProvider } from "./fixtures";
import { readableSnapshot, sampleReadableSnapshot } from "../src/chrome/snapshot-readable";
import { snapshotObservationPrimitives } from "../src/chrome/snapshot-observation-primitives.js";

test.use({ screenshot: "off", trace: "off" });

// Generated test fonts: one rectangular A and a space, 1000 units/em.
// Both contain an alphabetic BASE coordinate of -30000. The second has
// negative hhea/OS2 ascent (-200) and positive total height (1000).
const baseFont = "AAEAAAALAIAAAwAwQkFTRSZHthQAAAMAAAAAME9TLzJFAUT1AAABOAAAAGBjbWFwAHQAXAAAAaAAAAA8Z2x5ZjhdOFsAAAHkAAAANGhlYWQvlOgyAAAAvAAAADZoaGVhBRYB9gAAAPQAAAAkaG10eAJYAAAAAAGYAAAACGxvY2EADQAnAAAB3AAAAAhtYXhwAAUABgAAARgAAAAgbmFtZSI7lRYAAAIYAAAAvXBvc3QACAAkAAAC2AAAACgAAQAAAAEAAGhw3eFfDzz1AAED6AAAAADnFFJLAAAAAOcUUksAMgAAAiYCvAAAAAMAAgAAAAAAAAABAAADIP84AAACWAAAAGQB9AABAAAAAAAAAAAAAAAAAAAAAQABAAAAAwAEAAEAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAQCWAGQAAUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAD8/Pz8AwAAgAEEDIP84AAADIADIAAAAAAAAAAAAAAAAAAAAIAAAAlgAAAAAAAAAAAACAAAAAwAAABQAAwABAAAAFAAEACgAAAAGAAQAAQACACAAQf//AAAAIABB////4f/BAAEAAAAAAAAAAAANAA0AGgABADIAAAImArwAAwAAMyERITIB9P4MArwAAAEAMgAAAiYCvAADAAAzIREhMgH0/gwCvAAAAAAKAH4AAQAAAAAAAQAOAAAAAQAAAAAAAgAHAA4AAQAAAAAAAwAOAAAAAQAAAAAABAAOAAAAAQAAAAAABgAOAAAAAwABBAkAAQAcABUAAwABBAkAAgAOADEAAwABBAkAAwAcABUAAwABBAkABAAcABUAAwABBAkABgAcABVEZWNvcmF0aW9uQmFzZVJlZ3VsYXIARABlAGMAbwByAGEAdABpAG8AbgBCAGEAcwBlAFIAZQBnAHUAbABhAHIAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAwAkAAEAAAAIAAAABAAKAAFyb21uAAJERkxUAA5sYXRuAA4ABgAAAAAAAAABAAYAAYrQ";
const negativeFont = "AAEAAAALAIAAAwAwQkFTRSZHthQAAAMMAAAAME9TLzJFAT3tAAABOAAAAGBjbWFwAHQAXAAAAaAAAAA8Z2x5ZjhdOFsAAAHkAAAANGhlYWQvlOgyAAAAvAAAADZoaGVhAS3+DgAAAPQAAAAkaG10eAJYAAAAAAGYAAAACGxvY2EADQAnAAAB3AAAAAhtYXhwAAUABgAAARgAAAAgbmFtZYzJzacAAAIYAAAAyXBvc3QACAAkAAAC5AAAACgAAQAAAAEAAJskgntfDzz1AAED6AAAAADnFFJLAAAAAOcUUksAMgAAAiYCvAAAAAMAAgAAAAAAAAABAAD/OPtQAAACWAAAAGQB9AABAAAAAAAAAAAAAAAAAAAAAQABAAAAAwAEAAEAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAQCWAGQAAUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAD8/Pz8AwAAgAEH/OPtQAAAAAASwAAAAAAAAAAAAAAAAAAAAIAAAAlgAAAAAAAAAAAACAAAAAwAAABQAAwABAAAAFAAEACgAAAAGAAQAAQACACAAQf//AAAAIABB////4f/BAAEAAAAAAAAAAAANAA0AGgABADIAAAImArwAAwAAMyERITIB9P4MArwAAAEAMgAAAiYCvAADAAAzIREhMgH0/gwCvAAAAAAKAH4AAQAAAAAAAQASAAAAAQAAAAAAAgAHABIAAQAAAAAAAwASAAAAAQAAAAAABAASAAAAAQAAAAAABgASAAAAAwABBAkAAQAkABkAAwABBAkAAgAOAD0AAwABBAkAAwAkABkAAwABBAkABAAkABkAAwABBAkABgAkABlEZWNvcmF0aW9uTmVnYXRpdmVSZWd1bGFyAEQAZQBjAG8AcgBhAHQAaQBvAG4ATgBlAGcAYQB0AGkAdgBlAFIAZQBnAHUAbABhAHIAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAwAkAAEAAAAIAAAABAAKAAFyb21uAAJERkxUAA5sYXRuAA4ABgAAAAAAAAABAAYAAYrQ";

// GSUB calt/rlig/tnum change real glyph advances. The variable font has a
// real gvar wght-axis delta that raises the A outline by 1200 units.
const shapingFont = "AAEAAAALAIAAAwAwR1NVQg4m+poAAAPMAAAAnk9TLzJFAUWbAAABOAAAAGBjbWFwAIkA2AAAAbgAAABIZ2x5ZnkbjxAAAAIUAAAAqGhlYWQxJxg4AAAAvAAAADZoaGVhBwoEVQAAAPQAAAAkaG10eBfUAAAAAAGYAAAAIGxvY2EAwACcAAACAAAAABJtYXhwAAoABgAAARgAAAAgbmFtZWHAfkkAAAK8AAAAxnBvc3TaBesHAAADhAAAAEcAAQAAAAEAAKt/kYpfDzz1AAMD6AAAAADnFGpOAAAAAOcUak4AAAAAA+gCvAAAAAMAAgAAAAAAAAABAAADIP84AAAEsAAAAGQD6AABAAAAAAAAAAAAAAAAAAAACAABAAAACAAEAAEAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAQC+wGQAAUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAD8/Pz8AwAAgAEIDIP84AAADIADIAAAAAAAAAAAAAAAAAAAAIAACAfQAAAH0AAAB9AAABLAAAAH0AAAEsAAAAfQAAASwAAAAAAACAAAAAwAAABQAAwABAAAAFAAEADQAAAAIAAgAAgAAACAAMQBC//8AAAAgADEAQf///+H/0wAAAAEAAAAAAAQAAAACAAYAAAAMAAwAGAAkADAAPABIAFQAAAABAAAAAAGQArwAAwAAMSERIQGQ/nACvAABAAAAAAGQArwAAwAAMSERIQGQ/nACvAABAAAAAAPoArwAAwAAMSERIQPo/BgCvAABAAAAAAGQArwAAwAAMSERIQGQ/nACvAABAAAAAAPoArwAAwAAMSERIQPo/BgCvAABAAAAAAGQArwAAwAAMSERIQGQ/nACvAABAAAAAAPoArwAAwAAMSERIQPo/BgCvAAAAAoAfgABAAAAAAABABEAAAABAAAAAAACAAcAEQABAAAAAAADABEAAAABAAAAAAAEABEAAAABAAAAAAAGABEAAAADAAEECQABACIAGAADAAEECQACAA4AOgADAAEECQADACIAGAADAAEECQAEACIAGAADAAEECQAGACIAGERlY29yYXRpb25TaGFwaW5nUmVndWxhcgBEAGUAYwBvAHIAYQB0AGkAbwBuAFMAaABhAHAAaQBuAGcAUgBlAGcAdQBsAGEAcgAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAMAJAECABQBAwAlAQQFQS5hbHQHb25lLnRhYgZBQi5saWcAAAEAAAAKACgATgACREZMVAAObGF0bgAOAAQAAAAA//8AAwAAAAEAAgADY2FsdAAUcmxpZwAadG51bQAgAAAAAQAAAAAAAQABAAAAAQACAAMACAAcADwAAQAAAAEACAABAAYAAQABAAEAAgAEAAAAAQAIAAEAEgABAAgAAQAEAAcAAgAGAAEAAQADAAEAAAABAAgAAQAGAAEAAQABAAQAAA==";
const variableFont = "AAEAAAAMAIAAAwBAT1MvMke9R40AAAFIAAAAYGNtYXAAiQDYAAAByAAAAEhmdmFyfh1pkgAABAgAAAAkZ2x5ZnkbjxAAAAIkAAAAqGd2YXIIakZkAAAELAAAADpoZWFkMScaXgAAAMwAAAA2aGhlYQcKBFUAAAEEAAAAJGhtdHgX1AAAAAABqAAAACBsb2NhAMAAnAAAAhAAAAASbWF4cAAKAAYAAAEoAAAAIG5hbWUrysePAAACzAAAAPNwb3N02gXrBwAAA8AAAABHAAEAAAABAACalxlDXw889QADA+gAAAAA5xRrYQAAAADnFGthAAAAAAPoArwAAAADAAIAAAAAAAAAAQAAAyD/OAAABLAAAABkA+gAAQAAAAAAAAAAAAAAAAAAAAgAAQAAAAgABAABAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAEAvsBkAAFAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAA/Pz8/AMAAIABCAyD/OAAAAyAAyAAAAAAAAAAAAfQCvAAAACAAAAH0AAAB9AAAAfQAAASwAAAB9AAABLAAAAH0AAAEsAAAAAAAAgAAAAMAAAAUAAMAAQAAABQABAA0AAAACAAIAAIAAAAgADEAQv//AAAAIAAxAEH////h/9MAAAABAAAAAAAEAAAAAgAGAAAADAAMABgAJAAwADwASABUAAAAAQAAAAABkAK8AAMAADEhESEBkP5wArwAAQAAAAABkAK8AAMAADEhESEBkP5wArwAAQAAAAAD6AK8AAMAADEhESED6PwYArwAAQAAAAABkAK8AAMAADEhESEBkP5wArwAAQAAAAAD6AK8AAMAADEhESED6PwYArwAAQAAAAABkAK8AAMAADEhESEBkP5wArwAAQAAAAAD6AK8AAMAADEhESED6PwYArwAAAAMAJYAAQAAAAAAAQASAAAAAQAAAAAAAgAHABIAAQAAAAAAAwASAAAAAQAAAAAABAASAAAAAQAAAAAABgASAAAAAQAAAAABAAAGABkAAwABBAkAAQAkAB8AAwABBAkAAgAOAEMAAwABBAkAAwAkAB8AAwABBAkABAAkAB8AAwABBAkABgAkAB8AAwABBAkBAAAMAFFEZWNvcmF0aW9uVmFyaWFibGVSZWd1bGFyV2VpZ2h0AEQAZQBjAG8AcgBhAHQAaQBvAG4AVgBhAHIAaQBhAGIAbABlAFIAZQBnAHUAbABhAHIAVwBlAGkAZwBoAHQAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAMAJAECABQBAwAlAQQFQS5hbHQHb25lLnRhYgZBQi5saWcAAAEAAAAQAAIAAQAUAAAACHdnaHQBkAAAAZAAAAOEAAAAAAEAAAEAAAABAAAAAAAmAAgAAAAAACYAAAAAAAAACgAKAAoACgAKAAqAAQAKAAiAAEAAAIeBQQSwBLCDAAAA";

async function sampleInExtension(opened: Awaited<ReturnType<typeof openExtension>>, url: string, zoomProof = true, registerFontUrl?: string) {
  await expect(opened.page.getByTestId("open-settings")).toBeVisible();
  const cdp = await opened.context.newCDPSession(opened.page);
  try {
    const response = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === ${JSON.stringify(url)});
        if (!tab?.id) throw new Error("Target tab not found");
        const zoom = await chrome.tabs.getZoom(tab.id);
        if (zoom !== 1) throw new Error("Fixture requires default page zoom");
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: (${snapshotObservationPrimitives.toString()}), args: [true] });
        const [sample] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: function(pageZoom, registerFontUrl) {
          let face;
          if (registerFontUrl) { face = new FontFace('ColdPrimary', 'url(' + JSON.stringify(registerFontUrl) + ')'); document.fonts.add(face); }
          const before = document.fonts.status;
          const sample = (${sampleReadableSnapshot.toString()})(pageZoom);
          return { sample, fontState: { before, after: document.fonts.status, face: face?.status } };
        }, args: [${zoomProof ? "zoom" : "null"}, ${JSON.stringify(registerFontUrl ?? null)}] });
        return sample.result;
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    const { sample, fontState } = response.result.value;
    return { sample, fontState, text: sample ? readableSnapshot(sample).map(({ line }) => line).join("\n") : "" };
  } finally { await cdp.detach(); }
}

const baseStyle = "html,body{margin:0;color:black;background:white;font:16px/20px Arial}p{margin:0}";
const target = '<p style="position:absolute;left:20px;top:100px">REMOTE_UNDERLINE_TARGET</p>';
const remote = '<a href="#" style="position:absolute;left:20px;top:119135px;text-decoration:underline;text-underline-offset:2px">AAAAAAAAAAAAAAAAAAAA</a>';

test("remote solid underline has finite paint while a huge negative offset still occludes", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}</style>${target}${remote}`);
    const normal = await sampleInExtension(opened, page.url());
    expect(normal.text).toContain("REMOTE_UNDERLINE_TARGET");
    expect(normal.sample.gaps).toEqual([]);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}</style>${target}
      <p style="position:absolute;left:20px;top:119135px;width:180px">
        <a href="#" style="text-decoration:underline;text-underline-offset:auto;font-size:16.123456789px">Alpha Beta Gamma Delta Epsilon Zeta Eta Theta</a></p>`);
    expect(await page.locator("a").evaluate((node) => node.getClientRects().length)).toBeGreaterThan(1);
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    // Without a browser zoom certificate, the same column remains unknown.
    expect((await sampleInExtension(opened, page.url(), false)).text).not.toContain("REMOTE_UNDERLINE_TARGET");
    await page.locator("a").evaluate((node) => {
      node.style.textUnderlineOffset = "-119060px";
      node.style.textDecorationThickness = "100px";
      node.style.textDecorationColor = "white";
    });
    const covering = await sampleInExtension(opened, page.url());
    expect(covering.text).not.toContain("REMOTE_UNDERLINE_TARGET");
    expect(covering.sample.gaps.some((gap: { reason: string }) => gap.reason === "paint-occlusion")).toBe(true);
    if (await page.evaluate(() => CSS.supports("text-decoration-inset", "-10000px"))) {
      await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}</style>${target}${remote}`);
      await page.locator("a").evaluate((node) => { node.style.setProperty("text-decoration-inset", "-10000px"); });
      expect((await sampleInExtension(opened, page.url())).text).not.toContain("REMOTE_UNDERLINE_TARGET");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("primary-font bounds cancel BASE shifts and reject unnormalizable negative metrics", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}
      @font-face{font-family:DecorationBase;src:url(data:font/ttf;base64,${baseFont})}
      @font-face{font-family:DecorationNegative;src:url(data:font/ttf;base64,${negativeFont})}
      </style>${target}${remote}`);
    await page.evaluate(async () => {
      await Promise.all([document.fonts.load("16px DecorationBase", "A"), document.fonts.load("16px DecorationNegative", "A")]);
      await document.fonts.ready;
    });
    const metrics = await page.evaluate(() => ["DecorationBase", "DecorationNegative"].map((family) => {
      const context = document.createElement("canvas").getContext("2d")!;
      (context as CanvasRenderingContext2D & { lang: string }).lang = "en"; context.font = `16px ${family}`;
      const values = ["alphabetic", "top", "bottom"].map((baseline) => {
        context.textBaseline = baseline as CanvasTextBaseline;
        const empty = context.measureText(""), glyph = context.measureText("A");
        return { baseline, ascent: empty.fontBoundingBoxAscent, glyphAscent: glyph.fontBoundingBoxAscent, width: glyph.width, inkAscent: glyph.actualBoundingBoxAscent };
      });
      return { family, values };
    }));
    expect(metrics[0]!.values[0]!.ascent).toBeGreaterThan(400);
    expect(metrics[0]!.values[1]!.ascent).toBeLessThan(13);
    expect(metrics[0]!.values[2]!.ascent).toBeGreaterThan(13);
    for (const font of metrics) for (const value of font.values) {
      expect(value.glyphAscent).toBe(value.ascent);
      expect(value.width).toBeGreaterThan(0);
      expect(Number.isFinite(value.inkAscent)).toBe(true);
    }
    await page.locator("a").evaluate((node) => { node.style.fontFamily = "DecorationBase, Arial"; node.textContent = "AAAA"; });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    // Fallback glyphs do not change the decorating primary font.
    await page.locator("a").evaluate((node) => { node.textContent = "AAAA漢字"; });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    await page.locator("a").evaluate((node) => { node.style.fontFamily = "DecorationNegative, Arial"; });
    expect((await sampleInExtension(opened, page.url())).text).not.toContain("REMOTE_UNDERLINE_TARGET");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});


test("glyph-only shaping settings preserve metric bounds and explicit pseudo fonts do not", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}
      @font-face{font-family:DecorationShaping;src:url(data:font/ttf;base64,${shapingFont})}
      </style><style id="pseudo"></style>${target}${remote}`);
    await page.evaluate(async () => { await document.fonts.load("16px DecorationShaping", "AB1"); await document.fonts.ready; });
    const plain = await page.locator("a").evaluate((node) => {
      node.id = "remote"; node.textContent = "AB1111"; node.style.fontFamily = "DecorationShaping";
      node.style.fontFeatureSettings = '"calt" 0, "rlig" 0';
      const range = document.createRange(); range.selectNodeContents(node);
      return { width: range.getBoundingClientRect().width, height: range.getBoundingClientRect().height };
    });
    const shaped = await page.locator("a").evaluate((node) => {
      node.style.fontFeatureSettings = '"calt", "rlig"'; node.style.fontVariantNumeric = "tabular-nums";
      const range = document.createRange(); range.selectNodeContents(node);
      return { font: getComputedStyle(node).font, width: range.getBoundingClientRect().width, height: range.getBoundingClientRect().height };
    });
    expect(shaped.font).toBe("");
    expect(shaped.width).toBeGreaterThan(plain.width * 1.5);
    expect(shaped.height).toBe(plain.height);
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    // Shaping overrides are harmless to the metric description; their native
    // fragment geometry must still come from Chrome after shaping.
    await page.locator("#pseudo").evaluate((node) => { node.textContent = '#remote::first-line{font-variant-numeric:normal;font-feature-settings:"calt" 0,"rlig" 0}'; });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    for (const declaration of ["font-size:48px", "font-family:serif"]) {
      await page.locator("#pseudo").evaluate((node, declaration) => { node.textContent = `#remote::first-line{${declaration}}`; }, declaration);
      const fonts = await page.locator("a").evaluate((node) => ({ normal: getComputedStyle(node).font, pseudo: getComputedStyle(node, "::first-line").font }));
      expect(fonts).toEqual({ normal: "", pseudo: "" });
      expect((await sampleInExtension(opened, page.url())).text).not.toContain("REMOTE_UNDERLINE_TARGET");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("explicit variations retain horizontal bounds when the metric proof is unknown", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}
      @font-face{font-family:DecorationVariable;src:url(data:font/ttf;base64,${variableFont});font-weight:400 900}
      </style>${target}${remote}`);
    await page.evaluate(async () => { await Promise.all([document.fonts.load("400 16px DecorationVariable", "A"), document.fonts.load("900 16px DecorationVariable", "A")]); await document.fonts.ready; });
    const metrics = await page.evaluate(() => [400, 900].map((weight) => {
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${weight} 16px DecorationVariable`;
      const metrics = context.measureText("A");
      return { ascent: metrics.fontBoundingBoxAscent, width: metrics.width, ink: metrics.actualBoundingBoxAscent };
    }));
    expect(metrics[1]!.ink).toBeGreaterThan(metrics[0]!.ink + 10);
    expect(metrics.every(({ width, ink }) => width > 0 && Number.isFinite(ink))).toBe(true);
    await page.locator("a").evaluate((node) => { node.style.fontFamily = "DecorationVariable"; node.style.fontFeatureSettings = '"calt", "rlig"'; node.style.fontVariantNumeric = "tabular-nums"; });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    await page.locator("a").evaluate((node) => { node.style.fontVariationSettings = '"wght" 900'; });
    expect((await sampleInExtension(opened, page.url())).text).not.toContain("REMOTE_UNDERLINE_TARGET");
    // Missing a vertical font certificate must not create ink in other columns.
    await page.locator("a").evaluate((node) => { node.style.left = "800px"; });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});


test("an unused unloaded fallback does not invalidate the selected primary font", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  let unusedRequests = 0;
  try {
    await opened.context.route(`${provider.origin}/unused-font.ttf`, async (route) => { unusedRequests++; await route.abort(); });
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}
      @font-face{font-family:ReadyPrimary;src:url(data:font/ttf;base64,${baseFont})}
      @font-face{font-family:UnusedLater;src:url(${provider.origin}/unused-font.ttf)}
      </style>${target}${remote}`);
    await page.evaluate(async () => { await document.fonts.load("16px ReadyPrimary", "A"); await document.fonts.ready; });
    const evidence = await page.locator("a").evaluate((node) => {
      node.style.fontFamily = "ReadyPrimary,UnusedLater"; node.textContent = "AAAA";
      const range = document.createRange(); range.selectNodeContents(node); const text = range.getBoundingClientRect();
      const visible = document.querySelector("p")!.getBoundingClientRect();
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = "16px ReadyPrimary,UnusedLater";
      const before = document.fonts.status, check = document.fonts.check(context.font);
      context.textBaseline = "alphabetic"; const alphabetic = context.measureText("");
      context.textBaseline = "top"; const top = context.measureText("");
      context.textBaseline = "bottom"; const bottom = context.measureText("");
      return { before, after: document.fonts.status, check, ascent: alphabetic.fontBoundingBoxAscent,
        top: top.fontBoundingBoxAscent, bottom: bottom.fontBoundingBoxAscent, textHeight: text.height,
        horizontalOverlap: text.left < visible.right && visible.left < text.right,
        verticalOverlap: text.top < visible.bottom && visible.top < text.bottom,
        faces: [...document.fonts].map((face) => ({ family: face.family, status: face.status })) };
    });
    expect(evidence.check).toBe(false);
    expect(evidence.before).toBe("loaded"); expect(evidence.after).toBe("loaded");
    expect(evidence.ascent).toBeGreaterThan(400); // The same abnormal-BASE primary was selected.
    expect(evidence.top).toBeLessThan(13); expect(evidence.bottom).toBeGreaterThan(13);
    expect(evidence.textHeight).toBe(16); // DOM uses that primary's integer ascent/descent, not Arial's 17px.
    expect(evidence.horizontalOverlap).toBe(true); expect(evidence.verticalOverlap).toBe(false);
    expect(evidence.faces).toContainEqual({ family: "UnusedLater", status: "unloaded" });
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
    expect((await sampleInExtension(opened, page.url(), false)).text).not.toContain("REMOTE_UNDERLINE_TARGET");
    expect(unusedRequests).toBe(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("font activation during the synchronous sample discards earlier layout", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const fontUrl = `${provider.origin}/cold-font.ttf`;
    await opened.context.route(fontUrl, async (route) => { await gate; await route.fulfill({ contentType: "font/ttf", body: Buffer.from(baseFont, "base64") }); });
    const page = await opened.context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${provider.origin}/target`);
    await page.setContent(`<!doctype html><html lang="en"><style>${baseStyle}</style>${target}${remote}`);
    const oldHeight = await page.locator("a").evaluate((node) => {
      node.style.fontFamily = "ColdPrimary,Arial";
      const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().height;
    });
    // Register an actual unloaded face immediately before sampling, without
    // yielding to rendering. The sampler's layout/metric read activates it.
    const changing = await sampleInExtension(opened, page.url(), true, fontUrl);
    expect(changing.fontState).toEqual({ before: "loaded", after: "loading", face: "loading" });
    expect(changing.sample).toBeNull();
    release(); await page.evaluate(() => document.fonts.ready);
    const newHeight = await page.locator("a").evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().height; });
    expect(newHeight).not.toBe(oldHeight);
    expect((await sampleInExtension(opened, page.url())).text).toContain("REMOTE_UNDERLINE_TARGET");
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
