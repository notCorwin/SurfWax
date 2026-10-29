import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("reading element state does not scroll, but clicking an offscreen target does", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.style.height = "5000px";
      const input = document.createElement("input");
      input.type = "checkbox"; input.id = "offscreen-state";
      input.style.cssText = "position:absolute;top:3000px;left:40px;width:30px;height:30px";
      document.body.append(input);
      window.scrollTo(0, 0);
      (window as any).scrollEvents = 0;
      window.addEventListener("scroll", () => { (window as any).scrollEvents++; });
    });
    const locator = { by: "css", value: "#offscreen-state" };
    responses.push(
      commandResponse("read_checked", { target: locator }, "read-offscreen-state"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: false }); return commandResponse("verify_state", { target: locator, state: "unchecked" }, "verify-offscreen-state"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return commandResponse("execute_program", { code: `const el = page.locator('#offscreen-state'); const visible = await el.isVisible(); const enabled = await el.isEnabled(); return {visible, enabled, ...(await page.evaluate(() => ({scrollY, scrollEvents: window.scrollEvents})))};` }, "inspect-offscreen-position"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { visible: true, enabled: true, scrollY: 0, scrollEvents: 0 } }); return commandResponse("click", { target: locator }, "click-offscreen-state"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("READ_STATE_SCROLL_OK"); },
      textResponse("读取状态并点击"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("read the checkbox state, verify it and click it");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("READ_STATE_SCROLL_OK", { timeout: 45_000 });
    expect(await target.evaluate(() => scrollY)).toBeGreaterThan(1000);
    await expect(target.locator("#offscreen-state")).toBeChecked();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
