import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, openExtension, reloadUpgradedExtension, configure, configureWithImages, dispose, startProvider, commandResponse, textResponse, readEvents, nativePanel, submitNative, readNativeEvents, type MockResponse } from "./fixtures";

test("lists actual Chrome download metadata through its own tool", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const browser = await opened.context.browser()!.newBrowserCDPSession();
    await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: resolve(opened.userDataDirectory, "downloads"), eventsEnabled: true });
    const downloadId = await opened.page.evaluate(() => chrome.downloads.download({ url: "data:text/plain;base64,aGVsbG8=", filename: "tool-listing.txt", saveAs: false }));
    await expect.poll(() => opened.page.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, downloadId)).toBe("complete");
    const recorded = await opened.page.evaluate(async (id) => (await chrome.downloads.search({ id }))[0], downloadId);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    responses.push(
      commandResponse("list_downloads", { limit: 100 }, "list-downloads"),
      commandResponse("list_downloads", { downloadId }, "read-download-metadata"),
      textResponse("DOWNLOAD_METADATA_OK"), textResponse("下载记录"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect the completed download");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DOWNLOAD_METADATA_OK");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => ["list-downloads", "read-download-metadata"].includes(event.toolCallId) && event.type === "tool.failed")).toEqual([]);
    const listing = events.find((event) => event.type === "tool.finished" && event.toolCallId === "list-downloads")?.output;
    const exact = events.find((event) => event.type === "tool.finished" && event.toolCallId === "read-download-metadata")?.output;
    expect(listing).toMatchObject({ scope: "chrome-profile", consistency: "live", existence: "may-be-stale", downloads: expect.arrayContaining([expect.objectContaining({ id: downloadId })]) });
    expect(exact).toMatchObject({ downloads: [expect.objectContaining({ id: downloadId, state: "complete", filename: recorded!.filename, url: recorded!.url })], hasMore: false });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("closing the native panel during a pending download restores the existing artifact without recapturing it", async () => {
  const responses: MockResponse[] = [commandResponse("execute_program", { code: `return await page.screenshot(${JSON.stringify({ filename: "pending-close.png", save: true })});` }, "pending-artifact")];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    const native = await nativePanel(opened, `${provider.origin}/target`);
    // Hold the Chrome API at its pending boundary so native close can interrupt it.
    await native.panel.evaluate(`chrome.downloads.download = () => new Promise(() => { globalThis.__downloadStarted = true; })`);
    await submitNative(native.panel, "capture and save a screenshot");
    await expect.poll(() => native.panel.evaluate<boolean>('Boolean(globalThis.__downloadStarted)')).toBe(true);
    const artifact = (await readNativeEvents(native.panel)).find(event => event.type === "tool.result.data" && event.content?.filename === "pending-close.png")!;
    expect(artifact?.output.base64).toEqual(expect.any(String));
    await native.panel.close();
    expect((await native.browser.send("Target.closeTarget", { targetId: native.targetId })).success).toBe(true);
    await expect(native.target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    const recovery = await opened.context.newPage();
    await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect.poll(async () => (await readEvents(recovery)).filter(event => event.type === "tool.failed" && event.toolCallId === "pending-artifact").length).toBe(1);
    const restored = (await readEvents(recovery)).find(event => event.type === "tool.failed" && event.toolCallId === "pending-artifact")!;
    await test.info().attach("interrupted-artifact-events", { body: JSON.stringify((await readEvents(recovery)).filter(event => ["tool.started", "tool.failed", "tool.result.data"].includes(event.type)).map(({ id, type, runId, toolCallId, content, output }) => ({ id, type, runId, toolCallId, content, output: type === "tool.failed" ? output : undefined }))), contentType: "application/json" });
    expect(restored.output).toMatchObject({ artifact: { id: artifact.id, filename: "pending-close.png", mimeType: "image/png" } });
    await recovery.getByTestId("conversation-menu").click();
    await recovery.locator(".conversation-item").first().locator(".conversation-select").click();
    await expect(recovery.getByTestId("interrupted-message")).toBeVisible();
    responses.push(commandResponse("execute_program", { code: `return await artifacts.save(${JSON.stringify(artifact.id)},${JSON.stringify(undefined)});` }, "save-restored-artifact"), textResponse("EXISTING_ARTIFACT_ONLY"), textResponse("保存原产物"));
    await native.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: resolve(opened.userDataDirectory, "downloads"), eventsEnabled: true });
    await recovery.getByTestId("composer-input").fill("save the already captured artifact");
    await recovery.getByTestId("composer-input").press("Enter");
    await expect(recovery.locator(".markdown-body").last()).toContainText("EXISTING_ARTIFACT_ONLY");
    await expect(recovery.getByTestId("download-permission")).toHaveCount(0);
    const saved = (await readEvents(recovery)).find(event => event.type === "tool.finished" && event.toolCallId === "save-restored-artifact")!;
    await expect.poll(() => recovery.evaluate(async id => (await chrome.downloads.search({ id }))[0]?.state, saved.output.result.artifact.downloadId)).toBe("complete");
    const [download] = await recovery.evaluate(id => chrome.downloads.search({ id }), saved.output.result.artifact.downloadId);
    expect(await readFile(download!.filename)).toEqual(Buffer.from(artifact.output.base64, "base64"));
    const artifacts = (await readEvents(recovery)).filter(event => event.type === "tool.result.data" && event.content?.filename === "pending-close.png");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.output).toEqual(artifact.output);
    expect(await recovery.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const installation of ["fresh", "reloaded"] as const) test(`${installation} installation saves exactly the persisted artifact without runtime authorization`, async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "surf-wax-native-download-"));
  const extension = resolve(profile, "extension");
  await cp(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist"), extension, { recursive: true });
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  let opened = await openExtension(profile, { extensionPath: extension });
  try {
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    if (installation === "reloaded") {
      await opened.context.close();
      await cp(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist"), extension, { recursive: true });
      opened = await openExtension(profile, { extensionPath: extension });
      await reloadUpgradedExtension(opened);
    }
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    const browser = await opened.context.browser()!.newBrowserCDPSession();
    await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: resolve(profile, "downloads"), eventsEnabled: true });
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`); await target.bringToFront();
    responses.push(commandResponse("execute_program", { code: `return await page.screenshot(${JSON.stringify({ filename: "native-artifact.png" })});` }, "native-artifact"), textResponse("CAPTURED_ONCE"), textResponse("保存产物"));
    await opened.page.getByTestId("composer-input").fill("capture an internal screenshot"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CAPTURED_ONCE");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("保存产物");
    const artifact = (await readEvents(opened.page)).find((event) => event.type === "tool.result.data" && event.content?.filename === "native-artifact.png")!;
    expect(artifact?.output.base64).toEqual(expect.any(String));
    responses.push(commandResponse("execute_program", { code: `return await artifacts.save(${JSON.stringify(artifact.id)},${JSON.stringify(undefined)});` }, "native-save"), textResponse("NATIVE_SAVE_DONE"));
    await opened.page.getByTestId("composer-input").fill("save that existing artifact"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_SAVE_DONE");
    await expect(opened.page.getByTestId("download-permission")).toHaveCount(0);
    const saved = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "native-save")!;
    const downloadId = saved.output.result.artifact.downloadId;
    await expect.poll(() => opened.page.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, downloadId)).toBe("complete");
    const [download] = await opened.page.evaluate((id) => chrome.downloads.search({ id }), downloadId);
    expect(await readFile(download!.filename)).toEqual(Buffer.from(artifact.output.base64, "base64"));
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.result.data" && event.content?.filename === "native-artifact.png")).toHaveLength(1);
    responses.push(commandResponse("execute_program", { code: `return await artifacts.save(${JSON.stringify(artifact.id)},${JSON.stringify("native-artifact-copy.png")});` }, "native-save-again"), textResponse("SAVED_AGAIN"));
    await opened.page.getByTestId("composer-input").fill("save the same artifact again"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SAVED_AGAIN");
    await expect(opened.page.getByTestId("download-permission")).toHaveCount(0);
    const repeated = (await readEvents(opened.page)).find(event => event.type === "tool.finished" && event.toolCallId === "native-save-again")!;
    await expect.poll(() => opened.page.evaluate(async id => (await chrome.downloads.search({ id }))[0]?.state, repeated.output.result.artifact.downloadId)).toBe("complete");
    const [copy] = await opened.page.evaluate(id => chrome.downloads.search({ id }), repeated.output.result.artifact.downloadId);
    expect(await readFile(copy!.filename)).toEqual(Buffer.from(artifact.output.base64, "base64"));
    expect((await readEvents(opened.page)).filter(event => event.type === "tool.result.data" && event.content?.filename === "native-artifact.png")).toHaveLength(1);
  } finally { await dispose(opened.context, profile, provider.server); }
});
