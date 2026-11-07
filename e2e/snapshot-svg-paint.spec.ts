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
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === ${JSON.stringify(url)});
        if (!tab) throw new Error("Target tab not found");
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (${snapshotObservationPrimitives.toString()}), args: [true] });
        const zoom = await chrome.tabs.getZoom(tab.id);
        const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (${sampleReadableSnapshot.toString()}), args: [zoom] });
        return result.result;
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return readableSnapshot(response.result.value).map(({ line }) => line).join("\n");
  } finally { await cdp.detach(); }
}

const documentHtml = (content: string, css = "") => `<!doctype html><style>
  html,body{margin:0;background:white;color:black;font:16px Arial}p{margin:0}
  .target{position:absolute;left:10px;top:10px;z-index:0}
  svg{position:absolute;left:200px;top:200px;overflow:visible;z-index:1}
  ${css}</style>${content}`;

test("finite SVG ink restores nearby HTML without depending on DOM paint order", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const chart = `<svg width="200" height="100"><g transform="translate(20 10) rotate(15) scale(1.5 2)">
      <path d="M0 10L50 20L90 0" fill="none" stroke="black" stroke-width="2"/>
      <text x="0" y="40" style="font:italic 20px serif">jfj CHART</text>
    </g></svg>`;
    for (const content of [`<p class="target">LEGEND_VISIBLE</p>${chart}`, `${chart}<p class="target">LEGEND_VISIBLE</p>`]) {
      await target.setContent(documentHtml(content));
      await target.evaluate(() => document.fonts.ready);
      expect(await sample(opened, target.url())).toContain("LEGEND_VISIBLE");
    }
    const sparse = '<svg width="400" height="400" style="left:0;top:0"><rect x="200" y="200" width="40" height="40"/></svg>';
    await target.setContent(documentHtml(`<p class="target">INSIDE_VIEWPORT_OUTSIDE_INK</p>${sparse}`));
    expect(await sample(opened, target.url())).toContain("INSIDE_VIEWPORT_OUTSIDE_INK");
    await target.setContent(documentHtml(`<p class="target">ROOT_BACKGROUND_COVERED</p>${sparse}`, "svg{background:white}"));
    expect(await sample(opened, target.url())).not.toContain("ROOT_BACKGROUND_COVERED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("SVG strokes, miter joins, text overhang and transformed overflow retain their paint bounds", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const fixtures = [
      {
        name: "stroke outside a zero-height fill box",
        html: '<svg width="1" height="1"><line id="shape" x1="0" y1="30" x2="100" y2="30" fill="none" stroke="white" stroke-width="20"/></svg>',
        css: ".target{left:240px;top:235px;font:4px/4px Arial}",
      },
      {
        name: "acute miter outside half stroke width",
        html: '<svg width="1" height="1"><path id="shape" d="M20 100L50 0L80 100" fill="none" stroke="white" stroke-width="10" stroke-linejoin="miter" stroke-miterlimit="10"/></svg>',
        css: ".target{left:248px;top:184px;font:4px/4px Arial}",
      },
      {
        name: "negative y overflow",
        html: '<svg width="1" height="1"><rect x="0" y="-80" width="100" height="40" fill="white"/></svg>',
        css: ".target{left:210px;top:130px}",
      },
      {
        name: "transformed negative y overflow",
        html: '<svg width="1" height="1"><g transform="translate(0 -80) scale(2)"><rect width="100" height="40" fill="white"/></g></svg>',
        css: ".target{left:210px;top:130px}",
      },
      {
        name: "italic SVG text overflow",
        html: '<svg width="10" height="10"><text x="-100" y="-40" style="font:italic 40px serif" fill="white">jfj OVERFLOW</text></svg>',
        css: ".target{left:100px;top:130px}",
      },
    ];
    for (const fixture of fixtures) {
      await target.setContent(documentHtml(`${fixture.html}<p class="target">COVER_UNPROVEN</p>`, fixture.css));
      await target.evaluate(() => document.fonts.ready);
      expect(await sample(opened, target.url()), fixture.name).not.toContain("COVER_UNPROVEN");
      if (fixture.name.startsWith("acute"))
        expect(await target.evaluate(() => (document.querySelector("#shape") as SVGGeometryElement).isPointInStroke(new DOMPoint(50, -15)))).toBe(true);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("unsupported SVG resources and effects cannot shrink a potential occluder to its fill box", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const unsupported = [
      '<svg width="1" height="1"><defs><marker id="m" markerWidth="10" markerHeight="10"><rect width="10" height="10"/></marker></defs><line x2="100" stroke="white" marker-end="url(#m)"/></svg>',
      '<svg width="1" height="1"><rect width="10" height="10" style="filter:blur(100px)"/></svg>',
      '<svg width="1" height="1"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;inset:0;background:white">Foreign</div></foreignObject></svg>',
      '<svg width="1" height="1"><defs><rect id="r" width="10" height="10"/></defs><use href="#r"/></svg>',
      '<svg width="1" height="1"><line x2="100" stroke="white" stroke-width="10" vector-effect="non-scaling-stroke"/></svg>',
      '<svg width="1" height="1" style="transform:perspective(100px) rotateY(30deg)"><rect width="10" height="10"/></svg>',
      '<svg width="1" height="1" style="box-shadow:0 0 100px white"><rect width="10" height="10"/></svg>',
    ];
    for (const markup of unsupported) {
      await target.setContent(documentHtml(`${markup}<p class="target">UNKNOWN_PAINT</p>`));
      expect(await sample(opened, target.url()), markup).not.toContain("UNKNOWN_PAINT");
    }
    // A separate viewport-clip proof remains valid for unsupported marker ink.
    await target.setContent(documentHtml(`${unsupported[0]}<p class="target">CLIP_PROVEN</p>`, "svg{overflow:hidden}"));
    expect(await sample(opened, target.url())).toContain("CLIP_PROVEN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
