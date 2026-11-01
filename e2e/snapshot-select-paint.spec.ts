import { chromium, expect, test } from "@playwright/test";
import { SNAPSHOT_CONTROL_PAINT_SOURCE } from "../src/chrome/snapshot-control-paint";
import { SNAPSHOT_SELECT_PAINT_SOURCE } from "../src/chrome/snapshot-select-paint";

test("batch-proves only complete painted closed-select labels with their selected option", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SURFWAX_CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<style>select{display:block;margin:8px;font:16px monospace;border-radius:0}</style>
      <select id="visible" style="width:300px"><option selected value="ID_DIFFERENT" label="DISPLAY_LABEL">OTHER_TEXT</option><option value="other">OTHER</option></select>
      <select id="hidden-option" style="width:300px"><option selected style="display:none" value="id" label="HIDDEN_STYLE_LABEL">OTHER_TEXT</option></select>
      <select id="zero" style="width:300px;height:28px;font-size:0"><option selected label="ZERO_SECRET_ABC">OTHER</option></select>
      <select id="clipped" style="width:30px"><option selected label="ABCD_SECRET_ABC">OTHER</option></select>
      <select id="multiple" multiple size="2"><option selected>VISIBLE</option><option>OTHER</option></select>`);
    for (const id of ["visible", "hidden-option"]) {
      const select = page.locator(`#${id}`), option = select.locator("option").first();
      const original = await option.evaluate((element: HTMLOptionElement) => element.label);
      const before = await select.screenshot();
      await option.evaluate((element: HTMLOptionElement) => { element.label = "CHANGED_VISIBLE_LABEL"; });
      expect((await select.screenshot()).equals(before), `${id}: the displayed label must affect pixels`).toBe(false);
      await option.evaluate((element: HTMLOptionElement, value) => { element.label = value; }, original);
    }
    const cdp = await page.context().newCDPSession(page); await cdp.send("DOM.enable");
    const doc = await cdp.send("DOM.getDocument", { depth: 1, pierce: true });
    const documentObject = await cdp.send("Runtime.evaluate", { expression: "document" });
    const get = async (selector: string) => {
      const hostQuery = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      const host = (await cdp.send("DOM.describeNode", { nodeId: hostQuery.nodeId, depth: 0, pierce: true })).node;
      const roots = host.shadowRoots?.filter((root) => root.shadowRootType === "user-agent") ?? [];
      expect(roots).toHaveLength(1);
      const ua = (await cdp.send("DOM.describeNode", { backendNodeId: roots[0]!.backendNodeId, depth: 1, pierce: true })).node;
      const inner = ua.children?.find((node) => node.attributes?.includes("-internal-select-inner-element"));
      if (!inner) return null;
      const desc = (await cdp.send("DOM.describeNode", { backendNodeId: inner.backendNodeId, depth: 1, pierce: true })).node;
      const text = desc.children?.find((node) => node.nodeType === 3);
      if (!text) return null;
      const optionQuery = await cdp.send("DOM.querySelector", { nodeId: hostQuery.nodeId, selector: "option:checked" });
      const option = (await cdp.send("DOM.describeNode", { nodeId: optionQuery.nodeId, depth: 0 })).node;
      const textObject = await cdp.send("DOM.resolveNode", { backendNodeId: text.backendNodeId });
      const optionObject = await cdp.send("DOM.resolveNode", { backendNodeId: option.backendNodeId });
      return { hostId: host.backendNodeId, textId: text.backendNodeId, optionId: option.backendNodeId,
        expected: text.nodeValue, textObject: textObject.object.objectId!, optionObject: optionObject.object.objectId! };
    };
    const prove = async (entries: Array<NonNullable<Awaited<ReturnType<typeof get>>>>, frame = true, shadow = true) => {
      const response = await cdp.send("Runtime.callFunctionOn", { objectId: documentObject.result.objectId!, functionDeclaration: SNAPSHOT_SELECT_PAINT_SOURCE,
        arguments: [{ value: entries.map((entry) => ({ expected: entry.expected })) }, { value: frame }, { value: shadow },
          ...entries.flatMap((entry) => [{ objectId: entry.textObject }, { objectId: entry.optionObject }])], returnByValue: true });
      expect(response.exceptionDetails).toBeUndefined();
      return response.result.value as { scene: unknown; values: any[] };
    };
    const visible = (await get("#visible"))!, hiddenOption = (await get("#hidden-option"))!, zero = (await get("#zero"))!, clipped = (await get("#clipped"))!;
    expect(visible).toBeTruthy(); expect(hiddenOption).toBeTruthy(); expect(zero).toBeTruthy(); expect(clipped).toBeTruthy();
    const result = await prove([visible, hiddenOption, zero, clipped]);
    expect(result.values).toHaveLength(4);
    expect(result.values[0]).toMatchObject({ text: "DISPLAY_LABEL", optionValue: "ID_DIFFERENT", optionLabel: "DISPLAY_LABEL", optionIndex: 0 });
    expect(result.values[1]).toMatchObject({ text: "HIDDEN_STYLE_LABEL", optionValue: "id" });
    expect(result.values[2]).toBeNull(); expect(result.values[3]).toBeNull();
    expect((await prove([visible], false)).values).toEqual([null]);
    expect((await prove([visible], true, false)).values).toEqual([null]);
    const wrong = { ...visible, optionObject: hiddenOption.optionObject };
    expect((await prove([wrong])).values).toEqual([null]);
    for (const [id, replacement, original] of [["zero", "ZERO_SECRET_XYZ", "ZERO_SECRET_ABC"], ["clipped", "ABCD_SECRET_XYZ", "ABCD_SECRET_ABC"]] as const) {
      const input = page.locator(`#${id}`), before = await input.screenshot();
      await input.locator("option").evaluate((option: HTMLOptionElement, value) => { option.label = value; }, replacement);
      expect((await input.screenshot()).equals(before)).toBe(true);
      await input.locator("option").evaluate((option: HTMLOptionElement, value) => { option.label = value; }, original);
    }
    await page.locator("#visible").evaluate((host) => { const overlay=document.createElement("div"), r=host.getBoundingClientRect(); Object.assign(overlay.style,{position:"fixed",left:`${r.x}px`,top:`${r.y}px`,width:`${r.width}px`,height:`${r.height}px`,background:"white",pointerEvents:"none"});document.body.append(overlay); });
    expect((await prove([visible])).values).toEqual([null]);
  } finally { await browser.close(); }
});

test("mixed controls share one fresh scene per sampling pass", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SURFWAX_CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<style>input,select {font:16px monospace;display:block;margin:8px;border-radius:0;width:300px}</style>
      <input id="native" value="INPUT_VALUE">
      <select id="select"><option value="ID_DIFFERENT" label="DISPLAY_LABEL" selected>OTHER</option></select>`);
    await page.evaluate(() => {
      const original = Document.prototype.querySelectorAll;
      (window as any).__sceneScans = 0;
      Document.prototype.querySelectorAll = function (this: Document, ...args: Parameters<Document["querySelectorAll"]>) {
        if (args[0] === "*") (window as any).__sceneScans++;
        return original.apply(this, args);
      } as typeof Document.prototype.querySelectorAll;
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    const tree = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const nodes: any[] = [];
    const walk = (node: any) => { nodes.push(node); for (const child of [...node.shadowRoots ?? [], ...node.children ?? []]) walk(child); };
    walk(tree.root);
    const id = (node: any, value: string) => node.attributes?.some((attr: string, i: number, attrs: string[]) => attr === "id" && attrs[i + 1] === value);
    const native = nodes.find((node) => id(node, "native"));
    const select = nodes.find((node) => id(node, "select"));
    const uaText = (host: any) => {
      const shadow = host.shadowRoots.find((node: any) => node.shadowRootType === "user-agent");
      const descendants: any[] = [];
      const visit = (node: any) => { descendants.push(node); for (const child of node.children ?? []) visit(child); };
      visit(shadow);
      return descendants.find((node) => node.nodeType === 3);
    };
    const nativeText = uaText(native), selectText = uaText(select);
    const option = select.children.find((node: any) => node.localName === "option");
    const objects = await Promise.all([nativeText, selectText, option, select].map(async (node) =>
      (await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId })).object.objectId!));
    const documentObject = await cdp.send("Runtime.evaluate", { expression: "document" });
    const sample = async (frame = true) => {
      const response = await cdp.send("Runtime.callFunctionOn", {
        objectId: documentObject.result.objectId!, functionDeclaration: SNAPSHOT_CONTROL_PAINT_SOURCE,
        arguments: [{ value: { native: [{ expected: "INPUT_VALUE" }], selects: [{ expected: "DISPLAY_LABEL" }], selectHosts: [{}] } },
          { value: frame }, { value: true }, ...objects.map((objectId) => ({ objectId }))], returnByValue: true,
      });
      expect(response.exceptionDetails).toBeUndefined();
      return response.result.value as { scene: unknown; nativeValues: any[]; selectValues: any[]; selectStates: any[] };
    };
    const first = await sample(), second = await sample();
    expect(first.nativeValues[0]).toMatchObject({ text: "INPUT_VALUE" });
    expect(first.selectValues[0]).toMatchObject({ text: "DISPLAY_LABEL", optionValue: "ID_DIFFERENT" });
    expect(first.selectStates).toEqual([{ multiple: false, size: 0, open: false }]);
    expect(second).toEqual(first);
    expect(await page.evaluate(() => (window as any).__sceneScans)).toBe(2);
    await page.locator("#select option").evaluate((element: HTMLOptionElement) => { element.label = "CHANGED_LABEL"; });
    const changed = await sample();
    expect(changed.nativeValues[0]).toMatchObject({ text: "INPUT_VALUE" });
    expect(changed.selectValues).toEqual([null]);
    expect(await page.evaluate(() => (window as any).__sceneScans)).toBe(3);
    const unavailable = await sample(false);
    expect(unavailable.scene).toBeNull();
    expect(unavailable.selectStates).toEqual([{ multiple: false, size: 0, open: false }]);
    expect(await page.evaluate(() => (window as any).__sceneScans)).toBe(3);
    await page.locator("#select").evaluate((element: HTMLSelectElement) => { element.multiple = true; element.size = 3; });
    expect((await sample()).selectStates).toEqual([{ multiple: true, size: 3, open: false }]);
    await page.locator("#select").evaluate((element: HTMLSelectElement) => { element.multiple = false; element.size = 0; });
    await page.locator("#select").click();
    expect((await sample()).selectStates).toEqual([{ multiple: false, size: 0, open: true }]);
  } finally { await browser.close(); }
});
