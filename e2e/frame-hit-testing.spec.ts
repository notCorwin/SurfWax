import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, configure, dispose, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

for (const nestedOrigin of ["cross-process", "same-process"] as const) test(`rejects blocked clicks through each embedding frame with a ${nestedOrigin} nested frame`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const outer = target.frameLocator('iframe[src*=localhost]');
    await outer.getByRole("button", { name: "Frame action" }).waitFor();
    await outer.locator("body").evaluate((body, url) => {
      const frame = document.createElement("iframe");
      frame.id = "nested";
      frame.src = url;
      body.append(frame);
      const cover = document.createElement("div");
      cover.id = "inner-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { body.dataset.coverClicked = "yes"; };
      body.append(cover);
    }, `${nestedOrigin === "same-process" ? provider.origin.replace("127.0.0.1", "localhost") : provider.origin}/frame`);
    const inner = outer.frameLocator("#nested");
    await inner.getByRole("button", { name: "Frame action" }).waitFor();
    await inner.getByRole("button", { name: "Frame action" }).evaluate((button) => {
      button.addEventListener("click", () => { document.body.dataset.clickCount = String(Number(document.body.dataset.clickCount ?? 0) + 1); });
    });
    await target.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "parent-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { document.body.dataset.coverClicked = "yes"; };
      document.body.append(cover);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const click = `await page.frameLocator('iframe[src*=localhost]').frameLocator('#nested').getByRole('button', { name: 'Frame action' }).click(); return 'clicked';`;
    let started = 0;
    responses.push(
      () => { started = Date.now(); return commandResponse("execute_program", { timeoutMs: 20000, code: click }, "blocked-parent"); },
      (request) => {
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "intercepted" } });
        return commandResponse("execute_program", { code: `await page.evaluate(() => document.querySelector('#parent-cover').remove());` }, "remove-parent");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); started = Date.now(); return commandResponse("execute_program", { timeoutMs: 20000, code: click }, "blocked-inner"); },
      (request) => {
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "intercepted" } });
        return commandResponse("execute_program", { code: `await page.frameLocator('iframe[src*=localhost]').locator('#inner-cover').evaluate(element => element.remove());` }, "remove-inner");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("execute_program", { timeoutMs: 20000, code: click }, "frame-click"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return textResponse("FRAME_CLICK_DONE"); },
      textResponse("嵌套框架点击"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click Frame action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CLICK_DONE", { timeout: 30000 });
    await expect(target.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await expect(outer.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await expect(inner.locator("body")).toHaveAttribute("data-clicked", "yes");
    await expect(inner.locator("body")).toHaveAttribute("data-click-count", "1");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("rejects a click blocked by a parent overlay above a same-process frame", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const frame = target.frameLocator('iframe[src="/same-frame"]');
    await frame.locator("body").evaluate((body) => {
      const button = document.createElement("button");
      button.textContent = "Frame action";
      button.onclick = () => { body.dataset.clicked = "yes"; body.dataset.clickCount = String(Number(body.dataset.clickCount ?? 0) + 1); };
      body.append(button);
    });
    await target.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "parent-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { document.body.dataset.coverClicked = "yes"; };
      document.body.append(cover);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const click = `await page.frameLocator('iframe[src="/same-frame"]').getByRole('button', { name: 'Frame action' }).click(); return 'clicked';`;
    let started = 0;
    responses.push(
      () => { started = Date.now(); return commandResponse("execute_program", { timeoutMs: 20000, code: click }, "blocked-same"); },
      (request) => {
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "intercepted" } });
        return commandResponse("execute_program", { code: `await page.evaluate(() => document.querySelector('#parent-cover').remove());` }, "remove-cover");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("execute_program", { timeoutMs: 20000, code: click }, "same-click"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return textResponse("FRAME_CLICK_DONE"); },
      textResponse("同源框架点击"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click Frame action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CLICK_DONE", { timeout: 30000 });
    await expect(target.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
    await expect(frame.locator("body")).toHaveAttribute("data-click-count", "1");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
