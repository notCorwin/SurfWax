import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("retains unread subscribed events after their tab closes", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const other = await opened.context.newPage(); await other.goto(`${provider.origin}/target`);
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation`);
    expect(tab.id).toEqual(expect.any(Number));
    let subscriptionId = "", cursor = 0;
    responses.push(
      commandResponse("subscribe_event", { tabId: tab.id, kind: "console" }, "subscribe-before-close"),
      (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("execute_program", { code: "await page.evaluate(() => { console.warn('event-before-close-1'); console.warn('event-before-close-2'); });" }, "emit-before-close"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("wait_event", { subscriptionId, limit: 1, waitMs: 5000 }, "read-first-event"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ hasMore: true, events: [{ payload: { args: [expect.objectContaining({ value: "event-before-close-1" })] } }] }); cursor = result.nextCursor; return commandResponse("close_tab", { tabId: tab.id }, "close-event-tab"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("wait_event", { subscriptionId, after: cursor, limit: 1 }, "read-after-close"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ closed: expect.any(String), hasMore: false, events: [{ payload: { args: [expect.objectContaining({ value: "event-before-close-2" })] } }] }); cursor = result.nextCursor; return commandResponse("wait_event", { subscriptionId, after: cursor }, "read-closed-end"); },
      (request) => { expect(lastTool(request)).toMatchObject({ closed: expect.any(String), hasMore: false, events: [] }); return commandResponse("unsubscribe_event", { subscriptionId }, "release-closed-events"); },
      (request) => { expect(lastTool(request)).toMatchObject({ subscriptionId, closed: "unsubscribed" }); return textResponse("EVENT_CLOSE_RECOVERY_OK"); },
      textResponse("检查事件关闭"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("read subscribed console events after closing their tab");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EVENT_CLOSE_RECOVERY_OK", { timeout: 45000 });
    expect(target.isClosed()).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
