import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure } from "./fixtures";

test("rejects unsafe composed refs and cross-tab locators while ordinary filters still work", async () => {
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 20000, code: `
const snapshot = await page.inspect();
const ref = snapshot.items.find(item => item.line.includes('button "Safe target"')).ref;
const regularCount = await page.locator('article').filter({ has: page.locator('.needle') }).count();
const other = await browser.tabs.open('about:blank');
async function rejected(action, expected) {
  try { await action(); return false; } catch (error) { return String(error.message).includes(expected); }
}
const nestedRejected = await rejected(() => page.locator('article').filter({ has: page.ref(ref) }).click(), 'reference-composition-unavailable');
const chainRejected = await rejected(() => page.ref(ref).locator('button').click(), 'reference-composition-unavailable');
const dragRejected = await rejected(() => page.locator('article').first().dragTo(page.locator('article').filter({ has: page.ref(ref) })), 'reference-composition-unavailable');
const crossTabRejected = await rejected(() => page.locator('article').filter({ has: other.locator('body') }).count(), 'cross-tab-filter');
const crossTabDragRejected = await rejected(() => page.locator('article').first().dragTo(other.locator('body')), 'cross-tab-drag-target');
const crossFrameRejected = await rejected(() => page.frameLocator('iframe').locator('article').filter({ has: page.ref(ref) }).click(), 'reference-composition-unavailable');
await browser.tabs.close(other.tabId);
return { regularCount, nestedRejected, chainRejected, dragRejected, crossTabRejected, crossTabDragRejected, crossFrameRejected, clicks: await page.evaluate(() => Number(document.body.dataset.clicks || 0)) };` }, "composed-refs"),
    (request) => {
      const raw = request.messages.findLast((message: any) => message.role === "tool").content;
      const result = JSON.parse(Array.isArray(raw) ? raw.find((part: any) => part.type === "text").text : raw);
      expect(result).toMatchObject({ ok: true, result: { regularCount: 1, nestedRejected: true, chainRejected: true, dragRejected: true,
        crossTabRejected: true, crossTabDragRejected: true, crossFrameRejected: true, clicks: 0 } });
      return textResponse("COMPOSED_REF_REJECTION_OK");
    },
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const section = document.createElement("section");
      section.innerHTML = '<article><span class="needle">match</span><button>Safe target</button></article><article><span>other</span><button>Other target</button></article>';
      section.addEventListener("click", () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1); });
      document.body.append(section);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check composite locator safety");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPOSED_REF_REJECTION_OK", { timeout: 45000 });
    await expect(target.locator("body")).not.toHaveAttribute("data-clicks");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
