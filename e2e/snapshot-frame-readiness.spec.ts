import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

for (const crossOrigin of [false, true]) {
  test(`waits for a dynamically inserted ${crossOrigin ? "cross-origin" : "same-origin"} frame to load before capturing`, async () => {
    const responses: MockResponse[] = [commandResponse("inspect_page", { budget: 12000 }, "frame-load"), textResponse("FRAME_LOADED"), textResponse("完成")];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    let releaseLoad!: () => void;
    let resourceStarted!: () => void;
    const loadMayFinish = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const requested = new Promise<void>((resolve) => { resourceStarted = resolve; });
    try {
      const target = await opened.context.newPage();
      await target.route("**/snapshot-frame-document", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><main>Partial frame</main><img src="/snapshot-frame-held"><script>addEventListener('load',()=>document.querySelector('main').textContent='FRAME_FULLY_LOADED')</script>` }));
      await target.route("**/snapshot-frame-held", async (route) => { resourceStarted(); await loadMayFinish; await route.fulfill({ status: 204, body: "" }); });
      await target.goto(`${provider.origin}/target`);
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      const frameOrigin = crossOrigin ? provider.origin.replace("127.0.0.1", "localhost") : provider.origin;
      await target.evaluate((src) => { const frame = document.createElement("iframe"); frame.src = src; document.body.append(frame); }, `${frameOrigin}/snapshot-frame-document`);
      await requested;
      expect(await target.evaluate(() => document.readyState)).toBe("complete");
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the page");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "tool.started" && event.toolCallId === "frame-load")).toBe(true);
      await opened.page.waitForTimeout(500);
      expect((await readEvents(opened.page)).some((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "frame-load")).toBe(false);
      releaseLoad();
      await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_LOADED", { timeout: 45_000 });
      const completed = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "frame-load");
      expect(JSON.stringify(completed?.output)).toContain("FRAME_FULLY_LOADED");
      expect(JSON.stringify(completed?.output)).not.toContain("Partial frame");
    } finally {
      releaseLoad();
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  });
}
