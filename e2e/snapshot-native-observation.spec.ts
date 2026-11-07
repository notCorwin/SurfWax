import { expect, type Page } from "@playwright/test";
import { test, openExtension, dispose, startProvider } from "./fixtures";
import { readableSnapshot, sampleReadableSnapshot, type ReadableSnapshot } from "../src/chrome/snapshot-readable";
import { snapshotObservationPrimitives } from "../src/chrome/snapshot-observation-primitives.js";
import { PLACEHOLDER_EVIDENCE_SOURCE } from "../src/chrome/snapshot-placeholder";
import { SNAPSHOT_CONTROL_PAINT_SOURCE } from "../src/chrome/snapshot-control-paint";

test.use({ screenshot: "off", trace: "off" });

async function nativeSample(opened: Awaited<ReturnType<typeof openExtension>>, target: Page,
  options: { omitRoots?: boolean; afterDiscovery?: () => Promise<void> } = {}): Promise<ReadableSnapshot> {
  await expect(opened.page.getByTestId("open-settings")).toBeVisible();
  const inspector = await opened.context.newCDPSession(target), extension = await opened.context.newCDPSession(opened.page);
  const contexts: any[] = [];
  inspector.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  await inspector.send("Runtime.enable");
  const group = "snapshot-native-observation";
  try {
    const boot = await extension.send("Runtime.evaluate", { expression: `(async()=>{
      const tab=(await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(target.url())});
      if(!tab)throw Error('Target missing');
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:(${snapshotObservationPrimitives.toString()}),args:[true]});
      return{zoom:await chrome.tabs.getZoom(tab.id),origin:'chrome-extension://'+chrome.runtime.id};
    })()`, awaitPromise: true, returnByValue: true });
    expect(boot.exceptionDetails).toBeUndefined();
    const context = contexts.find(item => item.origin === boot.result.value.origin);
    expect(context).toBeTruthy();
    const root = await inspector.send("DOM.getDocument", { depth: -1, pierce: true });
    const roots: number[] = [], pending = [root.root];
    while (pending.length) {
      const node: any = pending.pop();
      if (/^(?:INPUT|TEXTAREA|SELECT)$/.test(node.nodeName))
        roots.push(...(node.shadowRoots ?? []).filter((item: any) => item.shadowRootType === "user-agent").map((item: any) => item.backendNodeId));
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    }
    const objects: Array<{ objectId: string }> = [];
    if (!options.omitRoots) for (const backendNodeId of roots) {
      const resolved = await inspector.send("DOM.resolveNode", { backendNodeId, executionContextId: context.id, objectGroup: group });
      expect(resolved.object.objectId).toBeTruthy(); objects.push({ objectId: resolved.object.objectId! });
    }
    await options.afterDiscovery?.();
    const response = await inspector.send("Runtime.callFunctionOn", { executionContextId: context.id,
      functionDeclaration: `function(zoom,...roots){return (${sampleReadableSnapshot.toString()})(zoom,roots,{placeholder:(${PLACEHOLDER_EVIDENCE_SOURCE}),controls:(${SNAPSHOT_CONTROL_PAINT_SOURCE})});}`,
      arguments: [{ value: boot.result.value.zoom }, ...objects], returnByValue: true });
    expect(response.exceptionDetails).toBeUndefined();
    expect(response.result.value).not.toBeNull();
    return response.result.value;
  } finally {
    await inspector.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    await inspector.detach(); await extension.detach();
  }
}

test("classifies live native text as field content without making it an author name", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>
      html,body{margin:0;color:black;background:white;font:16px monospace}
      input,textarea,select{display:block;width:340px;font:16px monospace;margin:8px;border-radius:0}
      label{display:block;width:360px;height:22px;overflow:hidden}
      #transparent::placeholder{opacity:0}
    </style>
      <input type="search" placeholder="VISIBLE_SEARCH_HINT">
      <label for="value">Author label</label><input id="value" value="VISIBLE_NATIVE_VALUE" placeholder="FILLED_HIDDEN_HINT">
      <textarea style="height:60px">FIRST_LINE\nSECOND_LINE</textarea>
      <input id="transparent" placeholder="TRANSPARENT_HINT_SECRET">
      <input type="password" value="PASSWORD_SECRET">
      <select><option value="INTERNAL_OPTION_SECRET" selected>PUBLIC_SELECTED_LABEL</option><option>NONSELECTED_SECRET</option></select>`);
    await target.evaluate(() => document.fonts.ready);
    const sample = await nativeSample(opened, target);
    const search = sample.rows.find(row => row.role === "searchbox");
    expect(search).toMatchObject({ placeholder: { status: "visible", text: "VISIBLE_SEARCH_HINT" } });
    expect(search?.text).toBeUndefined();
    const value = sample.rows.find(row => row.value === "VISIBLE_NATIVE_VALUE");
    expect(value).toMatchObject({ role: "textbox", text: "Author label" });
    expect(value?.valueUnknown).toBeUndefined();
    expect(sample.rows.find(row => row.value === "FIRST_LINE\nSECOND_LINE")).toMatchObject({ role: "textbox" });
    expect(sample.rows.find(row => row.selectedLabels?.[0] === "PUBLIC_SELECTED_LABEL")).toMatchObject({ role: "combobox" });
    expect(sample.rows.every(row => !row.text?.includes("VISIBLE_NATIVE_VALUE") && !row.text?.includes("FIRST_LINE"))).toBe(true);
    const delivered = readableSnapshot(sample).map(line => line.line).join("\n");
    expect(delivered).toContain('[placeholder="VISIBLE_SEARCH_HINT"]');
    expect(delivered).not.toMatch(/PASSWORD_SECRET|FILLED_HIDDEN_HINT|TRANSPARENT_HINT_SECRET|INTERNAL_OPTION_SECRET|NONSELECTED_SECRET/);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("keeps native role and explicit uncertainty when paint or root evidence is incomplete", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.setContent(`<!doctype html><style>html,body{margin:0;background:white;color:black}label{display:block;background:#ddd;padding:10px;width:320px}input{display:block;background:transparent;border:0;padding:0;width:300px;height:16px;font:20px monospace;outline:none}</style>
      <label><input placeholder="CLIPPED_PRIVATE_HINT"></label>`);
    await target.evaluate(() => document.fonts.ready);
    const clipped = await nativeSample(opened, target);
    expect(clipped.rows.find(row => row.role === "textbox")).toMatchObject({ placeholder: { status: "unknown" }, nameUnknown: true });
    expect(JSON.stringify(clipped)).not.toContain("CLIPPED_PRIVATE_HINT");
    expect(clipped.gaps.some(gap => gap.reason === "native-placeholder-unconfirmed")).toBe(true);

    await target.setContent('<style>input{display:block;width:300px;font:16px monospace}</style><input value="MISSING_ROOT_VALUE">');
    const missing = await nativeSample(opened, target, { omitRoots: true });
    expect(missing.gaps.some(gap => gap.reason === "native-root-missing" && gap.role === "textbox")).toBe(true);
    expect(missing.rows.find(row => row.role === "textbox")).toMatchObject({ valueUnknown: true });
    expect(JSON.stringify(missing)).not.toContain("MISSING_ROOT_VALUE");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("reads current root children and rejects detached discoveries", async () => {
  const provider = await startProvider([]), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.setContent('<style>html,body{margin:0;background:white}input{display:block;width:300px;font:16px monospace;border-radius:0}</style><input id="field" value="OLD_VALUE">');
    const changed = await nativeSample(opened, target, { afterDiscovery: async () => {
      await target.evaluate(() => { (document.querySelector("input") as HTMLInputElement).value = "CURRENT_VALUE"; });
    } });
    expect(changed.rows.find(row => row.role === "textbox")?.value).toBe("CURRENT_VALUE");
    expect(JSON.stringify(changed)).not.toContain("OLD_VALUE");
    const replaced = await nativeSample(opened, target, { afterDiscovery: async () => {
      await target.evaluate(() => { const old = document.querySelector("input")!; const replacement = old.cloneNode() as HTMLInputElement; replacement.value = "NEW_UNDISCOVERED_VALUE"; old.replaceWith(replacement); });
    } });
    expect(replaced.gaps.some(gap => gap.reason === "native-root-missing")).toBe(true);
    expect(replaced.rows.find(row => row.role === "textbox")?.valueUnknown).toBe(true);
    expect(JSON.stringify(replaced)).not.toMatch(/OLD_VALUE|CURRENT_VALUE|NEW_UNDISCOVERED_VALUE/);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
