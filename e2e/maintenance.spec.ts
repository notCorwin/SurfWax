import { expect, test, openExtension, configure, dispose, startProvider, commandResponse, readEvents, textResponse } from "./fixtures";

test("worker restart closes orphaned calls, releases page protection and never replays an operation", async () => {
  const provider = await startProvider([
    commandResponse("run", { code: `return await page.keyboard.down(${JSON.stringify("Shift")});` }, "restart-held-key"),
    commandResponse("run", { code: `return await page.locator(${JSON.stringify("#missing-until-restart")}).fill(${JSON.stringify("waiting")});`, timeoutMs: 300_000 }, "restart-waiting"),
    textResponse("AFTER_WORKER_RESTART"), textResponse("重启后恢复"),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => document.addEventListener("keyup", (event) => { if (event.key === "Shift") document.documentElement.dataset.shiftReleased = "yes"; }));
    await target.bringToFront();
    const protocol = await opened.context.newCDPSession(opened.page);
    let versionId: string | undefined;
    protocol.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      versionId = versions.find((version) => version.scriptURL.startsWith(`chrome-extension://${opened.extensionId}/`) && version.runningStatus === "running")?.versionId ?? versionId;
    });
    await protocol.send("ServiceWorker.enable");
    await expect.poll(() => versionId).toBeTruthy();
    await opened.page.getByTestId("composer-input").fill("hold Shift then wait for an element");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "tool.started" && event.toolCallId === "restart-waiting")).toBe(true);
    await expect(target.locator("#__surf-wax-page-guard")).toBeAttached();
    await protocol.send("ServiceWorker.stopWorker", { versionId: versionId! });
    await expect(opened.page.getByTestId("fatal-log-error")).toBeVisible();
    await opened.page.getByTestId("reload-sidepanel").click();
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    await expect.poll(() => target.evaluate(() => document.documentElement.dataset.shiftReleased)).toBe("yes");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.finished" && event.toolCallId === "restart-held-key")).toHaveLength(1);
    const interrupted = events.filter((event) => event.type === "tool.failed" && event.toolCallId === "restart-waiting");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].output).toMatchObject({ error: { effectUnknown: true } });
    expect(events.filter((event) => event.type === "conversation.aborted")).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
    await opened.page.reload();
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.failed" && event.toolCallId === "restart-waiting")).toHaveLength(1);
    await opened.page.getByTestId("composer-input").fill("start a new task after restarting");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("AFTER_WORKER_RESTART");
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.started" && event.toolCallId === "restart-held-key")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
