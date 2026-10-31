import { expect } from "@playwright/test";
import { test, configure, delayedResponse, dispose, openExtension, readEvents, startProvider, textResponse, type MockResponse } from "./fixtures";

test("sends the fully loaded snapshot after an external page refresh during a run", async () => {
  let releaseModel!: () => void;
  let releaseLoad!: () => void;
  const modelMayFinish = new Promise<void>((resolve) => { releaseModel = resolve; });
  const loadMayFinish = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const responses: MockResponse[] = [
    delayedResponse(textResponse("BEFORE_REFRESH_REPLY"), 0, modelMayFinish),
    textResponse("AFTER_REFRESH_REPLY"),
    textResponse("刷新测试"),
  ];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    let documents = 0;
    await target.route("**/refresh-target", async (route) => {
      documents++;
      const body = documents === 1
        ? "<!doctype html><title>Refresh target</title><main>Initial page</main>"
        : `<!doctype html><title>Refresh target</title><main>Loading page</main><img src="/refresh-held-resource"><script>window.addEventListener('load', () => { document.querySelector('main').textContent = 'REFRESH_AFTER_LOAD_MARKER'; });</script>`;
      await route.fulfill({ contentType: "text/html", body });
    });
    await target.route("**/refresh-held-resource", async (route) => { await loadMayFinish; await route.fulfill({ status: 204, body: "" }); });
    await target.goto(`${provider.origin}/refresh-target`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Observe changes to the page");
    await opened.page.getByTestId("composer-input").press("Enter");
    const agentRequests = () => provider.requests.filter((request) => Array.isArray(request.tools));
    await expect.poll(() => agentRequests().length).toBe(1);

    await target.reload({ waitUntil: "domcontentloaded" });
    expect(await target.evaluate(() => document.readyState)).toBe("interactive");
    releaseModel();
    await expect(opened.page.locator(".markdown-body")).toContainText(["BEFORE_REFRESH_REPLY"]);
    expect(agentRequests()).toHaveLength(1);
    releaseLoad();
    await target.waitForLoadState("load");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("AFTER_REFRESH_REPLY", { timeout: 45_000 });
    expect(agentRequests()).toHaveLength(2);
    const nextMessages = JSON.stringify(agentRequests()[1].messages);
    expect(nextMessages).toContain("<page-refresh>");
    expect(nextMessages).toContain("REFRESH_AFTER_LOAD_MARKER");
    expect(nextMessages.indexOf("BEFORE_REFRESH_REPLY")).toBeLessThan(nextMessages.indexOf("REFRESH_AFTER_LOAD_MARKER"));
    const events = await readEvents(opened.page);
    expect(JSON.stringify(events.filter((event) => event.type === "conversation.message"))).toContain("REFRESH_AFTER_LOAD_MARKER");
    await expect(opened.page.getByText("REFRESH_AFTER_LOAD_MARKER")).toHaveCount(0);
  } finally {
    releaseModel();
    releaseLoad();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
