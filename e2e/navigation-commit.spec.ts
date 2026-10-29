import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("navigation tools report the committed document and same-document history", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.route("**/slow-navigation", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Slow Navigation</title><main>committed</main>" });
    });
    const url = `${provider.origin}/slow-navigation`;
    responses.push(
      commandResponse("navigate", { url }, "slow-navigation"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { url, title: "Slow Navigation" } }); return commandResponse("navigate", { url: `${url}#part` }, "hash-navigation"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { url: `${url}#part` } }); return commandResponse("go_back", {}, "back"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { url } }); return commandResponse("go_forward", {}, "forward"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { url: `${url}#part` } }); return commandResponse("reload", {}, "reload"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { url: `${url}#part`, title: "Slow Navigation" } }); return textResponse("NAVIGATION_COMMITTED_OK"); },
      textResponse("导航测试"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("navigate, inspect history, and reload");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NAVIGATION_COMMITTED_OK", { timeout: 45_000 });
    await expect(target).toHaveURL(`${url}#part`);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
