import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

test("restores the interaction blocker after a document rewrite during the same run", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const markup = '<!doctype html><script>window.userKeys=0;window.addEventListener("keydown",()=>window.userKeys++,true)</script><input id="user-input"><button id="user-target" style="position:fixed;left:30px;top:60px" onclick="window.userClicks=(window.userClicks||0)+1">Target</button>';
    responses.push(
      commandResponse("execute_program", { timeoutMs: 20000, code: `await page.evaluate((markup) => { document.open(); document.write(markup); document.close(); }, ${JSON.stringify(markup)}); await sleep(9000); return 'REWRITE_WAIT_DONE';` }, "rewrite-and-wait"),
      textResponse("REWRITE_WAIT_DONE"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("rewrite the document and wait");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("#user-target")).toBeVisible();
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(1);
    expect(provider.requests.filter((request) => Array.isArray(request.tools))).toHaveLength(1);
    await target.evaluate((markup) => { document.open(); document.write(markup); document.close(); }, markup);
    await expect(target.locator("#user-target")).toBeVisible();
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(1);
    await target.mouse.click(45, 70);
    expect(await target.evaluate(() => (window as any).userClicks ?? 0)).toBe(0);
    await target.evaluate(() => document.querySelector<HTMLInputElement>("#user-input")!.focus());
    await target.keyboard.press("a");
    await expect(target.locator("#user-input")).toHaveValue("");
    const earlierCaptureListenerCalls = await target.evaluate(() => (window as any).userKeys);
    console.log(`Earlier page capture listener observed ${earlierCaptureListenerCalls} trusted keydown event(s).`);
    await test.info().attach("keydown-listener-before-restored-guard", { body: JSON.stringify({ earlierCaptureListenerCalls }), contentType: "application/json" });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REWRITE_WAIT_DONE", { timeout: 20000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
