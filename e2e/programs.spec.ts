import { expect } from "@playwright/test";
import { test, commandResponse, delayedResponse, textResponse, startProvider, openExtension, configure, nameCurrentConversation, readEvents, dispose, enableUserScripts, reloadUpgradedExtension, nativePanel, submitNative, readNativeEvents, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const value = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(value) ? value.find((part: any) => part.type === "text").text : value);
}
async function submit(page: any, prompt = "Exercise browser tools") {
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-input").press("Enter");
}

// Dialog, chooser, cross-origin frame and download handoffs are covered by
// dispatch-tools, chooser-prompt-tools and binary-transfer-tools respectively.
test("publishes atomic tools, defaults vision inspection to text, and acts using screenshot coordinates", async () => {
  const provider = await startProvider([
    commandResponse("inspect_page", {}, "text-default"),
    (request) => { expect(lastTool(request)).not.toHaveProperty("screenshot"); return commandResponse("take_screenshot", {}, "pixels-requested"); },
    (request) => {
      const image = lastTool(request).result;
      expect(image).toMatchObject({ tabId: expect.any(Number), documentId: expect.any(Number), observationId: expect.any(String), screenshot: expect.any(Object) });
      return commandResponse("move_pointer", { observationId: image.observationId, x: 50 * image.screenshot.scale, y: 40 * image.screenshot.scale }, "visual-move");
    },
    (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("press_pointer", {}, "visual-down"); },
    (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("release_pointer", {}, "visual-up"); },
    (request) => { expect(lastTool(request).ok).toBe(true); return textResponse("TEXT_AND_PIXELS_VERIFIED"); },
    textResponse("视觉测试"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/visual`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByLabel("图片输入能力").click();
    await options.getByRole("option", { name: "支持", exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存"); await options.close();
    await target.bringToFront(); await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("TEXT_AND_PIXELS_VERIFIED");
    const names = provider.requests[0].tools.map((item: any) => item.function.name);
    expect(names).toEqual(expect.arrayContaining(["inspect_page", "click", "fill", "move_pointer", "press_pointer", "release_pointer"]));
    expect(names).not.toContain("execute_program");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "text-default")?.output).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(events.filter((event) => event.type === "tool.result.data" && event.content?.mimeType?.startsWith("image/"))).toHaveLength(1);
    expect(await target.evaluate(() => document.body.dataset.clicked)).toBe("yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("persists MAIN and USER_SCRIPT matching and enablement through extension reload", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  const main = { id: "program-main", matches: [`${provider.origin}/*`], excludeMatches: [`${provider.origin}/frame`], js: [{ code: "document.documentElement.dataset.mainScript='first'" }], world: "MAIN", runAt: "document_end" };
  const user = { id: "program-user", matches: [`${provider.origin}/*`], js: [{ code: "document.documentElement.dataset.userScript='yes'" }], world: "USER_SCRIPT", runAt: "document_end" };
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await nameCurrentConversation(opened.page, "Script persistence");
    responses.push(
      commandResponse("create_script", { definition: main }, "create-main"),
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("create_script", { definition: user }, "create-user"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("disable_script", { scriptId: main.id }, "disable-main"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("update_script", { scriptId: main.id, changes: { js: [{ code: "document.documentElement.dataset.mainScript='edited'" }] } }, "edit-main"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("read_script", { scriptId: main.id }, "read-main"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { enabled: false, script: { js: [{ code: expect.stringContaining("edited") }] } } }); return textResponse("SCRIPTS_PERSISTED"); },
      textResponse("用户脚本"),
    );
    await target.bringToFront(); await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCRIPTS_PERSISTED");
    await reloadUpgradedExtension(opened);
    expect(await opened.page.evaluate(async () => (await chrome.userScripts.getScripts()).map(({ id, world }) => ({ id, world })))).toEqual([{ id: "program-user", world: "USER_SCRIPT" }]);
    responses.push(
      commandResponse("read_script", { scriptId: main.id }, "read-restored"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { enabled: false, script: { js: [{ code: expect.stringContaining("edited") }] } } }); return commandResponse("enable_script", { scriptId: main.id }, "enable-main"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("reload", {}, "reload-script-target"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("list_scripts", {}, "list-restored"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return textResponse("SCRIPTS_RESTORED"); },
      textResponse("恢复脚本"),
    );
    await target.bringToFront(); await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCRIPTS_RESTORED");
    await expect(target.locator("html")).toHaveAttribute("data-main-script", "edited");
    await expect(target.locator("html")).toHaveAttribute("data-user-script", "yes");
    await target.goto(`${provider.origin}/frame`);
    await expect(target.locator("html")).not.toHaveAttribute("data-main-script");
    await expect(target.locator("html")).toHaveAttribute("data-user-script", "yes");
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.failed")).toEqual([]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("preserves a completed form effect after an action fails and recovers", async () => {
  const provider = await startProvider([
    commandResponse("fill", { target: { by: "label", value: "Email" }, value: "kept@example.com" }, "partial-fill"),
    (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("click", { target: { by: "role", value: "button", name: "Missing action" } }, "missing-action"); },
    (request) => { expect(lastTool(request).ok).toBe(false); return commandResponse("read_value", { target: { by: "label", value: "Email" } }, "retained-value"); },
    (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "kept@example.com" }); return commandResponse("click", { target: { by: "role", value: "button", name: "Sign in" } }, "recover-submit"); },
    (request) => { expect(lastTool(request).ok).toBe(true); return textResponse("FAILURE_RECOVERED"); },
    textResponse("操作恢复"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront(); await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FAILURE_RECOVERED");
    await expect(target.locator("output")).toHaveText("Welcome kept@example.com");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.failed" && event.toolCallId === "missing-action")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.finished" && event.toolCallId === "recover-submit")).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("panel reload interrupts a background wait while retaining the preceding browser effect", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/performance`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await nameCurrentConversation(opened.page, "Background restart");
    let jobId = "";
    responses.push(
      commandResponse("click", { target: { by: "role", value: "button", name: "Increment" } }, "increment-before-reload"),
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("verify_state", { target: { by: "css", value: "#never-exists" }, state: "visible", timeoutMs: 60_000, background: true }, "reload-job"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ accepted: true, complete: false, jobId: expect.any(String) }); jobId = result.jobId; return delayedResponse(textResponse("unreachable"), 0, new Promise<void>(() => undefined)) as any; },
    );
    await target.bringToFront(); await submit(opened.page);
    await expect.poll(() => jobId).not.toBe("");
    await expect(target.locator("output")).toHaveText("1");
    await opened.page.reload(); await expect(opened.page.getByTestId("composer-input")).toBeEnabled();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "Background restart" }).locator(".conversation-select").click();
    responses.push(
      commandResponse("get_job", { jobId }, "reloaded-status"),
      (request) => { expect(lastTool(request)).toMatchObject({ terminal: true }); return commandResponse("read_text", { target: { by: "css", value: "output" } }, "reloaded-value"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "1" }); return textResponse("RESTART_RECEIPTS_VERIFIED"); },
    );
    await target.bringToFront(); await expect(opened.page.getByTestId("interrupted-message")).toBeVisible();
    await opened.page.getByTestId("continue-interrupted").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESTART_RECEIPTS_VERIFIED");
    const events = await readEvents(opened.page);
    const status = events.find((event) => event.toolCallId === "reloaded-status" && ["tool.failed", "tool.finished"].includes(event.type))?.output;
    expect(["interrupted", "cancelled"]).toContain(status.state); expect(status.terminal).toBe(true);
    expect(events.filter((event) => event.type === "tool.finished" && event.toolCallId === "increment-before-reload")).toHaveLength(1);
    await expect(target.locator("output")).toHaveText("1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("closing the native Side Panel releases held input while an operation waits", async () => {
  const provider = await startProvider([
    commandResponse("fill", { target: { by: "label", value: "Email" }, value: "native@example.com" }, "native-fill"),
    commandResponse("key_down", { key: "Shift" }, "native-held-key"),
    commandResponse("verify_state", { target: { by: "css", value: "#never-exists" }, state: "visible", timeoutMs: 60_000 }, "native-wait"),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/automation`);
    await native.target.evaluate(() => document.addEventListener("keyup", (event) => { if (event.key === "Shift") document.body.dataset.shiftReleased = "yes"; }));
    await submitNative(native.panel, "fill the field, hold Shift and wait");
    await expect.poll(async () => (await readNativeEvents(native.panel)).some((event) => event.type === "tool.started" && event.toolCallId === "native-wait")).toBe(true);
    await native.panel.close();
    expect((await native.browser.send("Target.closeTarget", { targetId: native.targetId })).success).toBe(true);
    await expect(native.target.locator("body")).toHaveAttribute("data-shift-released", "yes");
    await expect(native.target.getByLabel("Email")).toHaveValue("native@example.com");
    const recovery = await opened.context.newPage(); await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    expect((await readEvents(recovery)).filter((event) => event.type === "tool.finished" && event.toolCallId === "native-held-key")).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
