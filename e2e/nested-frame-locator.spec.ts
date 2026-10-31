import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

for (const crossAgain of [false, true]) test(`resolves a same-process frame inside an OOPIF${crossAgain ? " before another OOPIF" : ""}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const crossOrigin = provider.origin.replace("127.0.0.1", "localhost");
    await target.evaluate((url) => {
      const outer = document.createElement("iframe"); outer.id = "outer"; outer.style.cssText = "width:900px;height:500px"; outer.src = url;
      document.body.append(outer);
    }, `${crossOrigin}/same-frame`);
    const outer = target.frameLocator("#outer");
    await outer.locator("body").evaluate((body, url) => {
      const frame = document.createElement("iframe"); frame.id = "same"; frame.style.cssText = "width:700px;height:350px"; frame.src = url; body.append(frame);
    }, `${crossOrigin}/same-frame`);
    const same = outer.frameLocator("#same");
    if (crossAgain) {
      await same.locator("body").evaluate((body, url) => {
        const frame = document.createElement("iframe"); frame.id = "nested"; frame.style.cssText = "width:500px;height:180px"; frame.src = url; body.append(frame);
      }, `${provider.origin}/frame`);
    } else {
      await same.locator("body").evaluate((body) => {
        const button = document.createElement("button"); button.id = "action"; button.textContent = "Target action";
        button.onclick = () => { body.dataset.clicked = "yes"; }; body.append(button);
      });
    }
    const inner = crossAgain ? same.frameLocator("#nested") : same;
    const selector = crossAgain ? "button" : "#action";
    await expect(inner.locator(selector)).toBeVisible();
    const path = crossAgain ? "page.frameLocator('#outer').frameLocator('#same').frameLocator('#nested').locator('button')"
      : "page.frameLocator('#outer').frameLocator('#same').locator('#action')";
    responses.push(commandResponse("execute_program", { code: `await ${path}.click(); return 'clicked';`, timeoutMs: 15000 }, "nested-click"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return textResponse("NESTED_FRAME_OK"); },
      textResponse("嵌套框架"));
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click the nested action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NESTED_FRAME_OK", { timeout: 30000 });
    await expect(inner.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
