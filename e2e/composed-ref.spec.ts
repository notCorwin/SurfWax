import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure } from "./fixtures";

test("composes refs within a document and rejects cross-tab locators", async () => {
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 20000, code: `
const snapshot = await page.inspect();
const ref = snapshot.items.find(item => item.line.includes('button "Safe target"')).ref;
const rowRef = snapshot.items.find(item => item.line.includes('article "First row"')).ref;
const shadowRef = snapshot.items.find(item => item.line.includes('button "Shadow target"')).ref;
const shadowRowRef = snapshot.items.find(item => item.line.includes('article "Shadow row"')).ref;
const regularCount = await page.locator('article').filter({ has: page.locator('.needle') }).count();
const chainedCount = await page.ref(rowRef).getByRole('button', {name: 'Safe target'}).count();
const filteredCount = await page.ref(rowRef).filter({has: page.locator('.needle')}).count();
const indexedCount = await page.ref(rowRef).nth(0).count();
const nestedCount = await page.locator('article').filter({ has: page.ref(ref) }).count();
const deepCount = await page.locator('article').filter({ has: page.locator('.inner').filter({ has: page.ref(ref) }) }).count();
const combinedCount = await page.ref(rowRef).filter({ has: page.ref(ref) }).count();
const shadowCount = await page.locator('article').filter({ has: page.ref(shadowRef) }).count();
const shadowChainCount = await page.ref(shadowRowRef).getByRole('button', {name: 'Shadow target'}).count();
const filteredChild = await page.locator('article').filter({hasText:'match'}).getByRole('button', {name:'Safe target'}).count();
const secondRowChild = await page.locator('article').nth(1).locator('button').innerText();
const repeatedIndexChild = await page.locator('article').nth(1).first().locator('button').innerText();
const repeatedFilterChildren = await page.locator('article').filter({hasText:'match'}).filter({hasText:'Safe target'}).locator('button').count();
const nestedRefChildren = await page.locator('article').filter({has:page.ref(ref)}).locator('button').count();
const shadowRefChildren = await page.locator('article').filter({has:page.ref(shadowRef)}).locator('button').count();
await page.ref(rowRef).getByRole('button', {name: 'Safe target'}).click();
const other = await browser.tabs.open('about:blank');
async function rejected(action, expected) {
  try { await action(); return false; } catch (error) { return String(error.message).includes(expected); }
}
const crossTabRejected = await rejected(() => page.locator('article').filter({ has: other.locator('body') }).count(), 'cross-tab-filter');
const crossTabDragRejected = await rejected(() => page.locator('article').first().dragTo(other.locator('body')), 'cross-tab-drag-target');
await page.evaluate(() => document.querySelector('article').setAttribute('aria-label', 'Changed row'));
const staleRejected = await rejected(() => page.ref(rowRef).locator('button').count(), 'visible-identity-changed');
await browser.tabs.close(other.tabId);
return { regularCount, chainedCount, filteredCount, indexedCount, nestedCount, deepCount, combinedCount, shadowCount, shadowChainCount, filteredChild, secondRowChild, repeatedIndexChild, repeatedFilterChildren, nestedRefChildren, shadowRefChildren, staleRejected, crossTabRejected, crossTabDragRejected, clicks: await page.evaluate(() => Number(document.body.dataset.clicks || 0)) };` }, "composed-refs"),
    (request) => {
      const raw = request.messages.findLast((message: any) => message.role === "tool").content;
      const result = JSON.parse(Array.isArray(raw) ? raw.find((part: any) => part.type === "text").text : raw);
      expect(result).toMatchObject({ ok: true, result: { regularCount: 1, chainedCount: 1, filteredCount: 1, indexedCount: 1, nestedCount: 1, deepCount: 1, combinedCount: 1, shadowCount: 1, shadowChainCount: 1,
        filteredChild: 1, secondRowChild: "Other target", repeatedIndexChild: "Other target", repeatedFilterChildren: 2, nestedRefChildren: 2, shadowRefChildren: 1, staleRejected: true,
        crossTabRejected: true, crossTabDragRejected: true, clicks: 1 } });
      return textResponse("COMPOSED_REF_OK");
    },
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const section = document.createElement("section");
      section.innerHTML = '<article tabindex="0" aria-label="First row"><div class="inner"><span class="needle">match</span><button>Safe target</button><button>Extra target</button></div></article><article tabindex="0" aria-label="Second row"><span>Safe target note</span><button>Other target</button></article>';
      const shadowRow = document.createElement("article");
      shadowRow.setAttribute("tabindex", "0"); shadowRow.setAttribute("aria-label", "Shadow row");
      const host = document.createElement("div");
      host.attachShadow({ mode: "open" }).innerHTML = '<button>Shadow target</button>';
      shadowRow.append(host); section.append(shadowRow);
      section.addEventListener("click", () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1); });
      document.body.append(section);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check composite locator safety");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPOSED_REF_OK", { timeout: 45000 });
    await expect(target.locator("body")).toHaveAttribute("data-clicks", "1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("composes a referenced node in an out-of-process frame and rejects another frame's reference", async () => {
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 20000, code: `
const snapshot = await page.inspect();
const outerRef = snapshot.items.find(item => item.line.includes('button "Outer target"')).ref;
const frameRef = snapshot.items.find(item => item.line.includes('button "Frame target"')).ref;
const frameRowRef = snapshot.items.find(item => item.line.includes('article "Frame row"')).ref;
const scope = page.frameLocator('iframe[src*="localhost"]');
const nestedCount = await scope.locator('article').filter({has: page.ref(frameRef)}).count();
const rootCount = await page.ref(frameRowRef).getByRole('button',{name:'Frame target'}).count();
const filteredFrameCount = await page.locator('body').filter({hasText:'Outer target'}).frameLocator('iframe[src*="localhost"]').locator('article').count();
const referenceFrameCount = await page.locator('body').filter({has:page.ref(outerRef)}).frameLocator('iframe[src*="localhost"]').locator('article').count();
const sameFrameCount = await page.locator('body').filter({hasText:'Outer target'}).frameLocator('iframe[src="/same-frame"]').locator('article').count();
let crossFrameRejected = false;
try { await scope.locator('article').filter({has: page.ref(outerRef)}).count(); }
catch (error) { crossFrameRejected = String(error.message).includes('cross-frame-reference-context'); }
return {nestedCount, rootCount, filteredFrameCount, referenceFrameCount, sameFrameCount, crossFrameRejected};` }, "frame-refs"),
    (request) => {
      const raw = request.messages.findLast((message: any) => message.role === "tool").content;
      const result = JSON.parse(Array.isArray(raw) ? raw.find((part: any) => part.type === "text").text : raw);
      expect(result).toMatchObject({ ok: true, result: { nestedCount: 1, rootCount: 1, filteredFrameCount: 1, referenceFrameCount: 1, sameFrameCount: 1, crossFrameRejected: true } });
      return textResponse("COMPOSED_FRAME_REF_OK");
    },
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    await target.evaluate(() => { const button = document.createElement("button"); button.textContent = "Outer target"; document.body.append(button); });
    const frame = target.frames().find((value) => value.url().includes("localhost"))!;
    await frame.evaluate(() => { document.body.innerHTML = '<article tabindex="0" aria-label="Frame row"><button>Frame target</button></article>'; });
    const sameFrame = target.frames().find((value) => value.url().includes("same-frame"))!;
    await sameFrame.evaluate(() => { document.body.innerHTML = '<article><button>Same frame target</button></article>'; });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check composite locators in frames");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPOSED_FRAME_REF_OK", { timeout: 45000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
