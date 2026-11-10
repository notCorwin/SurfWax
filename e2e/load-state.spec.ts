import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
import { inspectText } from "./snapshot-format";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("inspection waits for the root document to load after a child frame has loaded", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const target = await opened.context.newPage();
    await target.route("**/load-state-root", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Root load</title><main>Root ready<iframe id="child" src="about:blank"></iframe><img src="/held-load"></main>' }));
    await target.route("**/held-load", async (route) => { await hold; await route.fulfill({ status: 204, body: "" }); });
    await target.route("**/child-load-state", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Child load</title>Child ready" }));
    await target.goto(`${provider.origin}/load-state-root`, { waitUntil: "domcontentloaded" });
    const crossOrigin = provider.origin.replace("127.0.0.1", "localhost");
    await target.evaluate((url) => { document.querySelector<HTMLIFrameElement>("#child")!.src = url; }, `${crossOrigin}/child-load-state`);
    await expect.poll(() => target.frames().map((frame) => frame.url())).toContain(`${crossOrigin}/child-load-state`);
    await target.frames().find((frame) => frame.url() === `${crossOrigin}/child-load-state`)!.waitForLoadState("load");
    expect(await target.evaluate(() => document.readyState)).toBe("interactive");
    responses.push(commandResponse("inspect_page", { timeoutMs: 30_000 }, "inspect-loaded"),
      (request) => { const result = lastTool(request); expect(inspectText(result.items)).toContain("Root ready"); return textResponse("ROOT_LOAD_STATE_OK"); },
      textResponse("页面加载检查"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect the loaded root page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "tool.started" && event.toolCallId === "inspect-loaded")).toBe(true);
    expect((await readEvents(opened.page)).filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "inspect-loaded")).toHaveLength(0);
    expect(provider.requests.filter((request) => Array.isArray(request.tools))).toHaveLength(1);
    release();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ROOT_LOAD_STATE_OK", { timeout: 45_000 });
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
