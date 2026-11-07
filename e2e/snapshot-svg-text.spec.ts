import { expect } from "@playwright/test";
import { test, openExtension, dispose, startProvider } from "./fixtures";
import { readableSnapshot, sampleReadableSnapshot } from "../src/chrome/snapshot-readable";
import { snapshotObservationPrimitives } from "../src/chrome/snapshot-observation-primitives.js";

test.use({ screenshot: "off", trace: "off" });

async function sample(opened: Awaited<ReturnType<typeof openExtension>>, url: string) {
  await expect(opened.page.getByTestId("open-settings")).toBeVisible();
  const cdp = await opened.context.newCDPSession(opened.page);
  try {
    const response = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const tab = (await chrome.tabs.query({})).find((item) => item.url === ${JSON.stringify(url)});
        if (!tab) throw new Error("Target tab not found");
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (${snapshotObservationPrimitives.toString()}), args: [true] });
        const zoom = await chrome.tabs.getZoom(tab.id);
        return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (${sampleReadableSnapshot.toString()}), args: [zoom] }))[0].result;
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    const raw = response.result.value;
    return { raw, text: readableSnapshot(raw).map(({ line }) => line).join("\n") };
  } finally { await cdp.detach(); }
}

const documentHtml = (content: string, css = "") => `<!doctype html><style>
  html,body{margin:0;background:white;color:black;font:16px Arial}
  svg{display:block;position:absolute;left:100px;top:100px;overflow:visible}${css}
  </style>${content}`;
const svgText = (label: string, attributes = "") => `<svg width="300" height="120"><text x="20" y="40" fill="black" ${attributes}>${label}</text></svg>`;

test("reads simple SVG leaves through shared contrast, clip and whitespace checks", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.setContent(documentHtml('<svg width="300" height="120"><g transform="translate(15 10)"><text x="20" y="40" fill="black"><tspan>LEAF_LABEL</tspan></text></g></svg>'));
    const leaf = await sample(opened, target.url());
    expect(leaf.text).toContain("LEAF_LABEL");
    expect(leaf.raw.rows.filter((row: any) => row.text === "LEAF_LABEL")).toHaveLength(1);
    expect(leaf.raw.gaps.some((gap: any) => gap.reason === "visual-content")).toBe(true);
    await target.setContent(documentHtml('<svg width="300" height="120"><rect width="300" height="120" fill="transparent"/><line x1="0" y1="20" x2="250" y2="20" stroke="gray" stroke-width="1"/><text x="20" y="35" style="font:12px Arial" fill="black">AXIS_LABEL</text></svg>'));
    expect((await sample(opened, target.url())).text).toContain("AXIS_LABEL");
    for (const attributes of ['style="fill:white"', 'style="fill:transparent"', 'fill-opacity="0"', 'fill-opacity="0.5"']) {
      await target.setContent(documentHtml(svgText("FILL_UNCONFIRMED", attributes)));
      expect((await sample(opened, target.url())).text, attributes).not.toContain("FILL_UNCONFIRMED");
    }
    await target.setContent(documentHtml(svgText("STROKE_ONLY", 'style="fill:transparent;stroke:black;stroke-width:1"')));
    const stroke = await sample(opened, target.url());
    expect(stroke.text).not.toContain("STROKE_ONLY");
    expect(stroke.raw.gaps.some((gap: any) => gap.reason === "text-paint")).toBe(true);
    await target.setContent(documentHtml(svgText("SVG_FILL_VISIBLE"), "body{color:transparent}"));
    expect((await sample(opened, target.url())).text).toContain("SVG_FILL_VISIBLE");
    await target.setContent(documentHtml(svgText("UNKNOWN_STROKE", 'style="fill:transparent;stroke:black"'), "body{color:transparent}"));
    const unknownStroke = await sample(opened, target.url());
    expect(unknownStroke.text).not.toContain("UNKNOWN_STROKE");
    expect(unknownStroke.raw.gaps.some((gap: any) => gap.reason === "text-paint")).toBe(true);
    await target.setContent(documentHtml(svgText("SELECTED_TRANSPARENT", 'style="fill:transparent"')));
    await target.evaluate(() => getSelection()!.selectAllChildren(document.querySelector("text")!));
    const selected = await sample(opened, target.url());
    expect(selected.text).not.toContain("SELECTED_TRANSPARENT");
    expect(selected.raw.gaps.some((gap: any) => gap.reason === "text-paint")).toBe(true);
    await target.setContent(documentHtml(svgText("PSEUDO_PAINT", 'id="pseudo"'), "#pseudo::first-line{fill:white}"));
    const firstLine = await sample(opened, target.url());
    expect(firstLine.text).not.toContain("PSEUDO_PAINT");
    expect(firstLine.raw.gaps.some((gap: any) => gap.reason === "text-paint")).toBe(true);
    await target.setContent(documentHtml(svgText("PSEUDO_RESTORED", 'id="pseudo" style="fill:transparent"'), "#pseudo::first-letter{fill:black}"));
    const firstLetter = await sample(opened, target.url());
    expect(firstLetter.text).not.toContain("PSEUDO_RESTORED");
    expect(firstLetter.raw.gaps.some((gap: any) => gap.reason === "text-paint")).toBe(true);
    await target.setContent(documentHtml(svgText("PSEUDO_SOURCE", 'id="pseudo"'),
      "#pseudo::first-line{fill:white}") + '<p style="position:absolute;left:120px;top:126px;font:4px Arial">PSEUDO_INK_UNPROVEN</p>');
    expect((await sample(opened, target.url())).text).not.toContain("PSEUDO_INK_UNPROVEN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("retains uncertainty for colliding SVG paint and mixed text without guessing draw order", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    const label = '<text x="20" y="40" fill="black">COLLISION_UNPROVEN</text>', path = '<path d="M10 10H290V60H10Z" fill="white"/>';
    for (const content of [label + path, path + label]) {
      await target.setContent(documentHtml(`<svg width="300" height="120">${content}</svg>`));
      expect((await sample(opened, target.url())).text).not.toContain("COLLISION_UNPROVEN");
    }
    await target.setContent(documentHtml('<svg width="300" height="120"><text x="20" y="40" fill="black">PREFIX<tspan>MIXED_LEAF</tspan></text></svg>'));
    expect((await sample(opened, target.url())).text).not.toMatch(/PREFIX|MIXED_LEAF/);
    await target.setContent(documentHtml(svgText("HTML_COVERED") + '<div style="position:absolute;left:100px;top:100px;width:300px;height:120px;background:white;z-index:5"></div>'));
    expect((await sample(opened, target.url())).text).not.toContain("HTML_COVERED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("uses native SVG ink bounds and rejects unsupported glyph or paint effects", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    const fixtures = [
      '<svg width="300" height="120"><text x="-100" y="40" fill="black" style="font:italic 40px serif">jjj_OVERHANG</text></svg>',
      svgText("ROTATED_TEXT", 'transform="rotate(10)"'),
      svgText("BIDI_TEXT", 'style="direction:rtl;unicode-bidi:bidi-override"'),
      '<svg width="300" height="120"><text x="140 20" y="40" fill="black">POSITIONED_TEXT</text></svg>',
      svgText("SPACED_TEXT", 'style="letter-spacing:-40px"'),
      '<svg width="30" height="50" style="overflow:hidden"><text x="20" y="40" fill="black">CLIPPED_TEXT</text></svg>',
      svgText("FILTER_TEXT", 'style="filter:blur(1px)"'),
      '<svg width="300" height="120"><defs><marker id="m" markerWidth="10" markerHeight="10"><rect width="10" height="10"/></marker></defs><line x1="200" x2="250" stroke="black" marker-end="url(#m)"/><text x="20" y="40" fill="black">MARKER_TEXT</text></svg>',
      '<svg width="300" height="120"><path id="curve" d="M0 50H250" fill="none"/><text fill="black"><textPath href="#curve">PATH_TEXT</textPath></text></svg>',
    ];
    for (const markup of fixtures) {
      await target.setContent(documentHtml(markup)); await target.evaluate(() => document.fonts.ready);
      expect((await sample(opened, target.url())).text, markup).not.toMatch(/jjj_OVERHANG|ROTATED_TEXT|BIDI_TEXT|POSITIONED_TEXT|SPACED_TEXT|CLIPPED_TEXT|FILTER_TEXT|MARKER_TEXT|PATH_TEXT/);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("clips inline and nested SVG viewports without discarding selection paint", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    for (const nested of [false, true]) for (const overflow of ["visible", "hidden"]) {
      const inner = `<svg width="200" height="20" style="display:inline;position:static;overflow:${overflow}"><text y="100" fill="black">VIEWPORT_LABEL</text></svg>`;
      await target.setContent(documentHtml(nested ? `<svg width="300" height="300">${inner}</svg>` : inner));
      expect((await sample(opened, target.url())).text.includes("VIEWPORT_LABEL"), `${nested};${overflow}`).toBe(overflow === "visible");
    }
    // A nested viewBox has a separate viewport transform. Keep it unknown
    // until that transform is proved, rather than using its ink client box.
    await target.setContent(documentHtml('<svg width="300" height="300"><svg width="200" height="20" viewBox="0 0 200 20" style="position:static;overflow:hidden"><text y="100" fill="black">NESTED_VIEWBOX_UNPROVEN</text></svg></svg>'));
    expect((await sample(opened, target.url())).text).not.toContain("NESTED_VIEWBOX_UNPROVEN");
    await target.setContent(documentHtml(`<p style="position:absolute;left:100px;top:100px;margin:0;z-index:0">SELECTION_COVERED</p>
      <svg width="300" height="40" style="z-index:1"><text id="selected" y="14" fill="transparent">WWWWWWWWWWWWWWWWWWWW</text></svg>`,
      "html,body{font:16px monospace}::selection{background:white;color:white;fill:white}"));
    expect((await sample(opened, target.url())).text).toContain("SELECTION_COVERED");
    await target.evaluate(() => getSelection()!.selectAllChildren(document.querySelector("#selected")!));
    expect((await sample(opened, target.url())).text).not.toContain("SELECTION_COVERED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
