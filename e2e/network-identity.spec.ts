import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("does not read a new navigation's response with an old request reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    let oldRef = "", newRef = "";
    const fetch = (url: string) => `return await net.fetch({context:'page',url:${JSON.stringify(url)}});`;
    responses.push(
      commandResponse("execute_program", { code: fetch(`${provider.origin}/target`) }, "fetch-before-navigation"),
      commandResponse("list_requests", {}, "requests-before-navigation"),
      (request) => {
        const entry = lastTool(request).result.requests.find((item: any) => item.url === `${provider.origin}/target`);
        expect(entry?.requestRef).toEqual(expect.any(String)); oldRef = entry.requestRef;
        return commandResponse("read_response", { requestRef: oldRef }, "response-before-navigation");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: expect.stringContaining("Side Agent Target") }); return commandResponse("navigate", { url: `${provider.origin}/complex-next` }, "navigate-diagnostic"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("execute_program", { code: fetch(`${provider.origin}/automation`) }, "fetch-after-navigation"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("list_requests", {}, "requests-after-navigation"); },
      (request) => {
        const entry = lastTool(request).result.requests.find((item: any) => item.url === `${provider.origin}/automation`);
        expect(entry?.requestRef).toEqual(expect.any(String)); newRef = entry.requestRef;
        expect(newRef).not.toBe(oldRef);
        return commandResponse("read_response", { requestRef: oldRef }, "stale-response");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return commandResponse("read_response", { requestRef: newRef }, "current-response"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: expect.stringContaining("Automation Target") }); return textResponse("REQUEST_IDENTITY_OK"); },
      textResponse("检查网络响应"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("read captured responses across navigation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REQUEST_IDENTITY_OK", { timeout: 45_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
