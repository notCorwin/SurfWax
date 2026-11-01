import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, configure, dispose, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("clicks an exposed portion of a target and refuses a completely covered target", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<button id="partial" style="position:fixed;left:100px;top:100px;width:200px;height:80px">Partial</button>
        <div id="partial-cover" style="position:fixed;left:175px;top:100px;width:125px;height:80px;z-index:1"></div>
        <button id="blocked" style="position:fixed;left:100px;top:220px;width:200px;height:80px">Blocked</button>
        <div id="full-cover" aria-label="Blocking overlay" style="position:fixed;left:100px;top:220px;width:200px;height:80px;z-index:1"></div>
        <button id="rotated" style="position:fixed;left:100px;top:340px;width:200px;height:80px;transform:rotate(12deg)">Rotated</button>
        <div id="rotated-cover" style="position:fixed;left:175px;top:315px;width:150px;height:130px;z-index:1"></div>
        <iframe id="test-frame" style="position:fixed;left:400px;top:100px;width:300px;height:200px;border:0" srcdoc="<button id='frame-button' style='position:fixed;left:30px;top:50px;width:200px;height:60px'>Frame button</button>"></iframe>
        <div id="frame-cover" style="position:fixed;left:505px;top:150px;width:125px;height:60px;z-index:1"></div>`;
      for (const id of ["partial", "blocked", "partial-cover", "full-cover", "rotated", "rotated-cover"]) {
        document.getElementById(id)!.addEventListener("click", () => { document.body.dataset[id.replaceAll("-", "")] = "clicked"; });
      }
    });
    await target.frameLocator("#test-frame").locator("#frame-button").evaluate((button) => {
      button.addEventListener("click", () => { button.ownerDocument.body.dataset.clicked = "yes"; });
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#partial" } }, "partial-click"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("click", { target: { by: "css", value: "#rotated" } }, "rotated-click"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("execute_program", { code: `await page.frameLocator('#test-frame').locator('#frame-button').click(); return 'clicked';` }, "frame-click"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return commandResponse("click", { target: { by: "css", value: "#blocked" } }, "blocked-click"); },
      (request) => { const output = lastTool(request); expect(output).toMatchObject({ ok: false, error: { code: "intercepted" } }); expect(JSON.stringify(output)).toContain("full-cover"); return textResponse("HIT_TEST_DONE"); },
      textResponse("点击命中测试"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click both targets");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HIT_TEST_DONE", { timeout: 30000 });
    await expect(target.locator("body")).toHaveAttribute("data-partial", "clicked");
    await expect(target.locator("body")).toHaveAttribute("data-rotated", "clicked");
    await expect(target.locator("body")).not.toHaveAttribute("data-partialcover");
    await expect(target.locator("body")).not.toHaveAttribute("data-rotatedcover");
    await expect(target.locator("body")).not.toHaveAttribute("data-blocked");
    await expect(target.locator("body")).not.toHaveAttribute("data-fullcover");
    await expect(target.frameLocator("#test-frame").locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
