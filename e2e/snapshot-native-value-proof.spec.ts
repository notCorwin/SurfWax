import { chromium, expect, test } from "@playwright/test";
import { SNAPSHOT_NATIVE_VALUE_SOURCE } from "../src/chrome/snapshot-native-value";

test("batches native input paint evidence and rejects clipping, scrolling and occlusion", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SURFWAX_CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<style>input,textarea {font:16px monospace; display:block; margin:8px; border-radius:0; resize:none;}</style>
      <input id="wide" value="VISIBLE_VALUE" style="width:300px">
      <input id="other" value="OTHER_VALUE" style="width:300px">
      <input id="zero" value="ZERO_HIDDEN_VALUE" style="font-size:0;width:300px;height:24px">
      <input id="narrow" value="ABCD_HIDDEN_SUFFIX" style="width:25px">
      <textarea id="multiline" style="width:300px;height:100px">FIRST\n\nSECOND</textarea>
      <textarea id="wrapped" style="width:70px;height:100px">FIRSTSECONDTHIRD</textarea>
      <textarea id="short" style="width:300px;height:30px">FIRST\nSECOND\nHIDDEN_ABC</textarea>`);
    const cdp = await page.context().newCDPSession(page); await cdp.send("DOM.enable");
    const prove = async (selectors: string[], flags = [true, true]) => {
      const tree = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const nodes: any[] = []; const walk = (node: any) => { nodes.push(node); for (const child of [...node.shadowRoots ?? [], ...node.children ?? []]) walk(child); }; walk(tree.root);
      const requests: Array<{ expected: string }> = [], textObjects: Array<{ objectId: string }> = [];
      for (const selector of selectors) {
        const host = nodes.find(n => ["INPUT", "TEXTAREA"].includes(n.nodeName) && n.attributes?.includes(selector.slice(1)));
        const root = host?.shadowRoots?.find((n: any) => n.shadowRootType === "user-agent");
        const text = root?.children?.flatMap((n: any) => n.children ?? []).find((n: any) => n.nodeType === 3);
        expect(text).toBeTruthy();
        const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: text.backendNodeId });
        textObjects.push({ objectId: resolved.object.objectId! });
        requests.push({ expected: await page.locator(selector).inputValue() });
      }
      const doc = await cdp.send("Runtime.evaluate", { expression: "document" });
      const response = await cdp.send("Runtime.callFunctionOn", { objectId: doc.result.objectId!, functionDeclaration: SNAPSHOT_NATIVE_VALUE_SOURCE,
        arguments: [{ value: requests }, ...flags.map(value => ({ value })), ...textObjects], returnByValue: true });
      expect(response.exceptionDetails).toBeUndefined(); return response.result.value;
    };
    const initial = await prove(["#wide", "#other", "#zero", "#narrow"]);
    expect(initial.values).toEqual([expect.objectContaining({ text: "VISIBLE_VALUE" }), expect.objectContaining({ text: "OTHER_VALUE" }), null, null]);
    expect(await prove(["#wide", "#other"])).toMatchObject({ scene: initial.scene });
    const multi = page.locator("#multiline"), originalMulti = await multi.screenshot();
    await multi.evaluate((host) => { (host as HTMLTextAreaElement).value = "FIRST\nSECOND"; });
    expect((await multi.screenshot()).equals(originalMulti)).toBe(false);
    await multi.evaluate((host) => { (host as HTMLTextAreaElement).value = "FIRST\n\nSECOND"; });
    expect((await prove(["#multiline", "#wrapped", "#short"])).values).toEqual([
      expect.objectContaining({ text: "FIRST\n\nSECOND" }), expect.objectContaining({ text: "FIRSTSECONDTHIRD" }), null,
    ]);
    await multi.evaluate((host) => { (host as HTMLTextAreaElement).value = "FIRST\n\nSECOND\n"; });
    // A trailing empty line need not paint any additional pixels.
    expect((await multi.screenshot()).equals(originalMulti)).toBe(true);
    expect((await prove(["#multiline"])).values).toEqual([null]);
    await multi.evaluate((host) => { (host as HTMLTextAreaElement).value = "FIRST\n\nSECOND"; });
    const short = page.locator("#short"), originalShort = await short.screenshot();
    await short.evaluate((host) => { (host as HTMLTextAreaElement).value = "FIRST\nSECOND\nHIDDEN_XYZ"; });
    expect((await short.screenshot()).equals(originalShort)).toBe(true);
    expect((await prove(["#short"])).values).toEqual([null]);
    await short.evaluate((host) => { (host as HTMLTextAreaElement).scrollTop = 100; });
    expect(await short.evaluate((host) => (host as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(0);
    expect((await prove(["#short"])).values).toEqual([null]);
    const input = page.locator("#wide"), withoutTrailingSpace = await input.screenshot();
    await input.evaluate((host) => { (host as HTMLInputElement).value = "VISIBLE_VALUE   "; });
    // The full Range has a positive width, but extra trailing spaces do not
    // change a single rendered pixel and therefore cannot be proven visible.
    expect((await input.screenshot()).equals(withoutTrailingSpace)).toBe(true);
    expect((await prove(["#wide"])).values).toEqual([null]);
    await input.evaluate((host) => { (host as HTMLInputElement).value = "   VISIBLE_VALUE"; });
    expect((await prove(["#wide"])).values).toEqual([null]);
    await input.evaluate((host) => { (host as HTMLInputElement).value = "VISIBLE_VALUE"; });
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.font = "16px Arial"; });
    expect((await prove(["#wide"])).values).toEqual([expect.objectContaining({ text: "VISIBLE_VALUE" })]);
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.font = ""; });
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.fontStyle = "italic"; });
    expect((await prove(["#wide"])).values).toEqual([null]);
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.fontStyle = ""; });
    expect((await prove(["#wide"], [false, true])).values).toEqual([null]);
    expect((await prove(["#wide"], [true, false])).values).toEqual([null]);
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.scale = "0.5"; });
    expect((await prove(["#wide"])).values).toEqual([null]);
    await page.locator("#wide").evaluate((host) => { (host as HTMLElement).style.scale = ""; });
    await page.locator("#wide").evaluate((host) => { (host as HTMLInputElement).value = "不可见的复杂文本"; });
    expect((await prove(["#wide"])).values).toEqual([null]);
    await page.locator("#wide").evaluate((host) => { (host as HTMLInputElement).value = "VISIBLE_VALUE"; });
    await page.evaluate(() => { document.fonts.add(new FontFace("TestFont", 'local("Arial")')); });
    expect((await prove(["#wide"])).values).toEqual([null]);
    await page.evaluate(() => { for (const face of document.fonts) document.fonts.delete(face); });
    await page.locator("#narrow").focus(); await page.locator("#narrow").press("End");
    expect((await prove(["#narrow"])).values).toEqual([null]);
    await page.locator("#narrow").blur();
    await page.locator("#wide").evaluate((host) => { const overlay=document.createElement("div"); const r=host.getBoundingClientRect(); Object.assign(overlay.style,{position:"fixed",left:`${r.x}px`,top:`${r.y}px`,width:`${r.width}px`,height:`${r.height}px`,background:"white",pointerEvents:"none"}); document.body.append(overlay); });
    expect((await prove(["#wide", "#other"])).values).toEqual([null, expect.objectContaining({ text: "OTHER_VALUE" })]);
  } finally { await browser.close(); }
});
