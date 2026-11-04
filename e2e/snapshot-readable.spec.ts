import { expect } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";
import { READABLE_SNAPSHOT_SOURCE, readableSnapshot } from "../src/chrome/snapshot-readable";

test("read-only text uses Chrome paint evidence and omits unverified content", async () => {
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
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
    const cdp = await opened.context.newCDPSession(target);
    try {
      const sample = await cdp.send("Runtime.evaluate", { expression: `(${READABLE_SNAPSHOT_SOURCE})()`, returnByValue: true });
      const lines = readableSnapshot(sample.result.value);
      const text = lines.map(({ line }) => line).join("\n");
      expect(text).toContain("KNOWN_VISIBLE");
      expect(text).not.toContain("transformed_visible");
      expect(sample.result.value.viewport).toMatchObject({ x: 0, y: 0, width: 1000, height: 700 });
      expect(text).not.toMatch(/HIDDEN_SECRET|OFFSCREEN_SECRET|CLIPPED_SECRET|TRANSPARENT_SECRET|COVERED_SECRET|PASSWORD_SECRET|FRAME_SECRET/);
      expect(lines.every((line) => !line.ref)).toBe(true);
    } finally { await cdp.detach(); }
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});

test("read-only sampling withholds pseudo paint, SVG text and gradient-covered text", async () => {
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    await target.setContent(`<!doctype html><style>
      body{margin:0;font:16px monospace}p{margin:0;height:30px}
      #transparent::first-line{color:transparent}
      #uppercase::first-line{text-transform:uppercase}
    </style><p>INDEPENDENT_VISIBLE</p>
    <p id="transparent">FIRST_LINE_SECRET</p><p id="uppercase">first_line_lowercase</p>
    <svg width="200" height="40"><text x="0" y="20" fill="none">SVG_SECRET</text></svg>
    <p style="position:absolute;top:300px">GRADIENT_SECRET</p>
    <div style="position:fixed;left:0;top:300px;width:400px;height:40px;background:linear-gradient(white,white);pointer-events:none"></div>`);
    const sample = await target.evaluate(`(${READABLE_SNAPSHOT_SOURCE})()`);
    const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
    expect(text).toContain("INDEPENDENT_VISIBLE");
    expect(text).not.toMatch(/FIRST_LINE_SECRET|first_line_lowercase|SVG_SECRET|GRADIENT_SECRET/);
    await target.evaluate(() => scrollTo(0, 100));
    // A frozen sample retains the viewport from its own synchronous read.
    expect((sample as any).viewport.y).toBe(0);
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});

test("read-only sampling excludes border, outline, backdrop and unsafe foreground covers", async () => {
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1000, height: 700 });
    const covers = [
      '<div style="position:absolute;left:0;top:0;width:200px;height:100px;border:100px solid white;box-sizing:border-box"></div>',
      '<div style="position:absolute;left:100px;top:100px;width:1px;height:1px;outline:150px solid white"></div>',
      '<style>#cover::first-line{color:white;text-transform:uppercase}</style><p id="cover" style="position:absolute;top:20px;left:20px">COVERED_SECRET</p>',
      '<style>dialog::backdrop{background:white}</style><dialog>Modal text</dialog>',
    ];
    for (const cover of covers) {
      await target.setContent(`<!doctype html><style>body{margin:0;background:white;font:16px monospace}p{margin:0}</style><p style="position:absolute;top:20px;left:20px">COVERED_SECRET</p>${cover}`);
      await target.evaluate(() => document.querySelector('dialog')?.showModal());
      const sample = await target.evaluate(`(${READABLE_SNAPSHOT_SOURCE})()`);
      const text = readableSnapshot(sample as any).map(({ line }) => line).join("\n");
      expect(text, cover).not.toContain("COVERED_SECRET");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});
