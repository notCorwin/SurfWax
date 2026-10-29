import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, enableUserScripts, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("runs page-independent tools after closing the bound tab, including opening a restricted page", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), target.url());
    expect(tab.id).toEqual(expect.any(Number));
    responses.push(
      commandResponse("close_tab", { tabId: tab.id }, "close-bound"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("create_text_artifact", { filename: "report.txt", text: "retained without a page" }, "artifact"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { id: expect.any(Number), filename: "report.txt" } }); return commandResponse("list_scripts", {}, "scripts"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("click", { target: { by: "css", value: "button" } }, "page-required"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "no-bound-tab" } }); return commandResponse("open_tab", { url: "chrome://version" }, "open-restricted"); },
      (request) => {
        const output = lastTool(request); expect(output).toMatchObject({ ok: true, result: { tabId: expect.any(Number) } });
        return commandResponse("close_tab", { tabId: output.result.tabId }, "close-restricted");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("open_tab", { url: `${provider.origin}/automation` }, "open-web"); },
      (request) => {
        const output = lastTool(request); expect(output).toMatchObject({ ok: true, result: { tabId: expect.any(Number) } });
        return commandResponse("switch_tab", { tabId: output.result.tabId }, "switch-web");
      },
      (request) => { expect(lastTool(request)).toEqual(expect.arrayContaining([expect.objectContaining({ current: true })])); return commandResponse("click", { target: { by: "css", value: "button" } }, "click-new"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("PAGE_INDEPENDENT_TOOLS_OK"); },
      textResponse("Page-independent tools"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Close this tab and continue with independent tools");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PAGE_INDEPENDENT_TOOLS_OK", { timeout: 60000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
