import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, openExtension, reloadUpgradedExtension, configure, dispose, startProvider, commandResponse, textResponse, readEvents, nativePanel, submitNative, readNativeEvents, type MockResponse } from "./fixtures";

test("closing the native panel during download authorization restores the existing artifact without recapturing it", async () => {
  const responses: MockResponse[] = [commandResponse("screenshot", { filename: "pending-close.png", save: true }, "pending-artifact")];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(false);
    const native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, "capture and save a screenshot");
    await expect.poll(() => native.panel.evaluate<boolean>(`Boolean(document.querySelector('[data-testid="download-permission"]'))`)).toBe(true);
    const artifact = (await readNativeEvents(native.panel)).find(event => event.type === "tool.result.data" && event.content?.filename === "pending-close.png")!;
    expect(artifact?.output.base64).toEqual(expect.any(String));
    await native.panel.close();
    expect((await native.browser.send("Target.closeTarget", { targetId: native.targetId })).success).toBe(true);
    await expect(native.target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    const recovery = await opened.context.newPage();
    await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect.poll(async () => (await readEvents(recovery)).filter(event => event.type === "tool.failed" && event.toolCallId === "pending-artifact").length).toBe(1);
    const restored = (await readEvents(recovery)).find(event => event.type === "tool.failed" && event.toolCallId === "pending-artifact")!;
    expect(restored.output.artifact).toMatchObject({ id: artifact.id, filename: "pending-close.png", mimeType: "image/png" });
    await recovery.getByTestId("conversation-menu").click();
    await recovery.locator(".conversation-item").first().locator(".conversation-select").click();
    await expect(recovery.getByTestId("interrupted-message")).toBeVisible();
    responses.push(commandResponse("artifact-save", { id: artifact.id }, "save-restored-artifact"), textResponse("EXISTING_ARTIFACT_ONLY"), textResponse("保存原产物"));
    await recovery.getByTestId("composer-input").fill("save the already captured artifact");
    await recovery.getByTestId("composer-input").press("Enter");
    await expect(recovery.getByTestId("download-permission")).toBeVisible();
    await recovery.getByRole("button", { name: "取消保存" }).click();
    await expect(recovery.locator(".markdown-body").last()).toContainText("EXISTING_ARTIFACT_ONLY");
    const artifacts = (await readEvents(recovery)).filter(event => event.type === "tool.result.data" && event.content?.filename === "pending-close.png");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.output).toEqual(artifact.output);
    expect(await recovery.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("an upgraded download grant saves exactly the persisted artifact and native revocation requests it again", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "surf-wax-native-download-"));
  const extension = resolve(profile, "extension");
  await cp(resolve(".dev/upgrade-v0.2.0/dist"), extension, { recursive: true });
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  let opened = await openExtension(profile, { extensionPath: extension });
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    await opened.context.close();
    await cp(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist"), extension, { recursive: true });
    opened = await openExtension(profile, { extensionPath: extension });
    await reloadUpgradedExtension(opened);
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    const browser = await opened.context.browser()!.newBrowserCDPSession();
    await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: resolve(profile, "downloads"), eventsEnabled: true });
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`); await target.bringToFront();
    responses.push(commandResponse("screenshot", { filename: "native-artifact.png" }, "native-artifact"), textResponse("CAPTURED_ONCE"), textResponse("保存产物"));
    await opened.page.getByTestId("composer-input").fill("capture an internal screenshot"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CAPTURED_ONCE");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("保存产物");
    const artifact = (await readEvents(opened.page)).find((event) => event.type === "tool.result.data" && event.content?.filename === "native-artifact.png")!;
    expect(artifact?.output.base64).toEqual(expect.any(String));
    responses.push(commandResponse("artifact-save", { id: artifact.id }, "native-save"), textResponse("NATIVE_SAVE_DONE"));
    await opened.page.getByTestId("composer-input").fill("save that existing artifact"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_SAVE_DONE");
    await expect(opened.page.getByTestId("download-permission")).toHaveCount(0);
    const saved = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "native-save")!;
    const downloadId = saved.output.artifact.downloadId;
    await expect.poll(() => opened.page.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, downloadId)).toBe("complete");
    const [download] = await opened.page.evaluate((id) => chrome.downloads.search({ id }), downloadId);
    expect(await readFile(download!.filename)).toEqual(Buffer.from(artifact.output.base64, "base64"));
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.result.data" && event.content?.filename === "native-artifact.png")).toHaveLength(1);
    expect(await opened.page.evaluate(() => chrome.permissions.remove({ permissions: ["downloads"] }))).toBe(true);
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(false);
    responses.push(commandResponse("artifact-save", { id: artifact.id }, "native-save-revoked"), textResponse("SAVE_CANCELLED"));
    await opened.page.getByTestId("composer-input").fill("save the same artifact again"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("download-permission")).toBeVisible();
    await opened.page.getByRole("button", { name: "取消保存" }).click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SAVE_CANCELLED");
    expect((await readEvents(opened.page)).find((event) => event.type === "tool.failed" && event.toolCallId === "native-save-revoked")?.output).toMatchObject({ ok: false });
  } finally { await dispose(opened.context, profile, provider.server); }
});
