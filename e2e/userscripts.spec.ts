import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, browserResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

test("ships the MV3 Harness and user-script manager", async () => {
  const opened = await openExtension();
  try {
    const manifest = await opened.page.evaluate(() => chrome.runtime.getManifest());
    expect(manifest).toMatchObject({ name: "Surf Wax", manifest_version: 3, minimum_chrome_version: "138", version: JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")).version });
    expect(manifest.permissions).toEqual(["debugger", "scripting", "sidePanel", "storage", "tabs", "unlimitedStorage", "userScripts"]);
    expect(manifest.optional_permissions).toEqual(["downloads"]);
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(false);
    expect(manifest.permissions).toContain("userScripts");
    expect(existsSync(resolve(process.cwd(), "dist/userscripts.html"))).toBe(true);
    await expect(opened.page.getByTestId("open-user-scripts")).toBeVisible();
    await expect(opened.page.locator("h1")).toHaveText("Surf Wax");
    await expect(opened.page.getByTestId("config-required-state")).toBeVisible();

    const options = await configure(opened.context, opened.page, "https://provider.test/v1");
    await expect(options.getByTestId("options-card").locator("input")).toHaveCount(5);
    await expect(options.getByTestId("event-log-clear")).toBeVisible();
    await expect(options.getByRole("link", { name: "打开脚本管理" })).toBeVisible();
    await expect(options.getByTestId("event-log")).toHaveCount(0);
    await expect(options.getByTestId("user-scripts-panel")).toHaveCount(0);
    await expect(opened.page.getByTestId("welcome-options")).toHaveCount(0);
    await expect(opened.page.getByTestId("edit-message-button")).toHaveCount(0);
    await expect(opened.page.getByTestId("model-label")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});


test("restores saved user scripts on browser startup", async () => {
  const provider = await startProvider([]);
  let opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const script = { id: "restored", matches: [`${provider.origin}/*`], js: [{ code: "document.documentElement.dataset.restoredScript = 'ran'" }] };
    await opened.page.evaluate((script) => chrome.storage.local.set({
      "side-agent:user-scripts": [script],
      "side-agent:unrelated": "keep",
    }), script);
    await opened.context.close();
    opened = await openExtension(opened.userDataDirectory);
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await expect.poll(() => opened.page.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["restored"] })).length)).toBe(1);
    expect((await opened.page.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toMatchObject([script]);
    expect(await opened.page.evaluate(async () => (await chrome.storage.local.get("side-agent:unrelated"))["side-agent:unrelated"])).toBe("keep");
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await expect.poll(() => target.evaluate(() => document.documentElement.dataset.restoredScript)).toBe("ran");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("lets the agent create, inspect, edit and toggle a user script", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const script = { id: "agent-script", matches: [`${provider.origin}/*`], js: [{ code: "document.documentElement.dataset.agentScript = 'first'" }] };
    responses.push(
      commandResponse("userscript-create", { script }, "call-script-create"),
      commandResponse("userscript-list", {}, "call-script-list"),
      commandResponse("userscript-read", { id: script.id }, "call-script-read"),
      commandResponse("userscript-edit", { id: script.id, changes: { js: [{ code: "document.documentElement.dataset.agentScript = 'edited'" }] } }, "call-script-edit"),
      commandResponse("userscript-set-enabled", { id: script.id, enabled: false }, "call-script-disable"),
      commandResponse("userscript-set-enabled", { id: script.id, enabled: true }, "call-script-enable"),
      textResponse("SCRIPT_TOOLS_DONE"), textResponse("脚本工具"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("创建、查看、编辑并切换脚本");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCRIPT_TOOLS_DONE");
    const result = await opened.page.evaluate(async () => ({
      scripts: await chrome.userScripts.getScripts({ ids: ["agent-script"] }),
      disabled: (await chrome.storage.local.get("side-agent:user-scripts-disabled"))["side-agent:user-scripts-disabled"],
    }));
    expect(result.scripts).toMatchObject([{ id: script.id, js: [{ code: "document.documentElement.dataset.agentScript = 'edited'" }] }]);
    expect(result.disabled).toEqual([]);
    const events = await readEvents(opened.page);
    for (const id of ["call-script-create", "call-script-list", "call-script-read", "call-script-edit", "call-script-disable", "call-script-enable"]) {
      expect(events.some((event) => event.toolCallId === id && event.type === "tool.finished")).toBe(true);
    }
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("contains a long user script restore error without hiding the manager", async () => {
  const opened = await openExtension();
  try {
    const [scripts] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await scripts.setViewportSize({ width: 360, height: 700 });
    await scripts.evaluate(() => chrome.storage.local.set({ "side-agent:user-scripts-error": "SCRIPT_ERROR_".repeat(2000) }));
    const notice = scripts.locator(".app-error-notice").filter({ hasText: "用户脚本恢复失败" });
    await expect(notice).toBeVisible();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("SCRIPT_ERROR_");
    expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(scripts.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});


test("manages, edits and deletes scripts in the native Chrome scripts workbench", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const [disabledManager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await expect(disabledManager.getByRole("status")).toContainText("Allow User Scripts");
    await disabledManager.close();
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const [manager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await manager.waitForLoadState("domcontentloaded");
    await expect(manager.getByTestId("user-scripts-panel")).toBeVisible();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByText("在网页中试运行")).toHaveCount(0);
    const script = { id: "managed", matches: [`${provider.origin}/*`], js: [{ code: "const CSS_TOP='body{color:red}';document.documentElement.dataset.managed = 'first'; 'RUN_OK'" }], world: "USER_SCRIPT" };
    await manager.getByRole("button", { name: "新建脚本" }).click();
    await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-id-error")).toContainText("请输入脚本 ID");
    await expect(manager.locator("#script-matches-error")).toContainText("网站匹配规则");
    await manager.locator("#script-id").fill(script.id);
    await manager.locator("#script-matches").fill(script.matches[0]);
    await manager.locator("#script-code .cm-content").fill(script.js[0].code);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-code .cm-content")).toHaveAttribute("contenteditable", "true");
    await expect(manager.locator("#script-code .cm-content")).toContainText("color: red;");
    await expect(manager.locator("#script-code .cm-content")).toContainText("CSS_TOP = `");
    await expect(manager.locator("#script-code .cm-line span").filter({ hasText: /^body$/ })).toBeVisible();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toBeVisible();
    expect(await warnsOnLeave(manager)).toBe(false);
    const initialScripts = (await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[];
    expect(initialScripts).toHaveLength(1);
    expect(initialScripts[0].js?.[0].code).toContain("\n");
    expect(initialScripts[0].js?.[0].code).toContain("color: red;");
    await manager.getByRole("button", { name: "停用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"]).toHaveLength(1);
    await manager.reload();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.locator("#script-code .cm-content").fill(`${script.js[0].code}\n// edited while disabled`);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByRole("status")).toContainText("脚本已保存");
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).toMatchObject([{ js: [{ code: expect.stringContaining("edited while disabled") }] }]);
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("button", { name: "启用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已注册")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.locator("#script-search").fill("no-match");
    await expect(manager.getByText("没有匹配的脚本")).toBeVisible();
    await manager.locator("#script-search").fill("managed");
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "JSON 高级编辑" }).click();
    const definition = manager.locator("#script-definition");
    await definition.fill(JSON.stringify({ ...script, runAt: "document_start", excludeMatches: ["https://example.org/*"] }));
    await manager.getByRole("button", { name: "返回表单" }).click();
    await manager.locator("#script-code .cm-content").fill("document.documentElement.dataset.managed='updated';'RUN_OK'");
    await manager.getByRole("button", { name: "格式化代码" }).click();
    await expect(manager.locator("#script-code .cm-content")).toContainText("document.documentElement.dataset.managed = \"updated\";");
    expect(await warnsOnLeave(manager)).toBe(true);
    manager.once("dialog", (dialog) => dialog.dismiss());
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    await expect(manager.locator("#script-code .cm-content")).toContainText("updated");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[]).toMatchObject([{ js: [{ code: expect.stringContaining("first") }] }]);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByRole("status")).toContainText("脚本已保存");
    expect(await warnsOnLeave(manager)).toBe(false);
    const savedScript = ((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[])[0];
    expect(savedScript.runAt).toBe("document_start");
    expect(savedScript.excludeMatches).toEqual(["https://example.org/*"]);
    expect(savedScript.js?.[0].code).toContain("updated");
    await manager.goBack();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await manager.goForward();
    await expect(manager.getByRole("heading", { name: "managed" })).toBeVisible();
    await manager.locator("#script-code .cm-content").fill("// discard this draft");
    manager.once("dialog", (dialog) => dialog.accept());
    await manager.getByRole("button", { name: "返回列表" }).click();
    expect(await warnsOnLeave(manager)).toBe(false);
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await expect(manager.locator("#script-code .cm-content")).toContainText("updated");
    await manager.setViewportSize({ width: 390, height: 800 });
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    }
    await manager.getByRole("button", { name: "返回列表" }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(manager.getByRole("button", { name: "停用 managed" })).toBeVisible();
    }
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.setViewportSize({ width: 1280, height: 800 });
    const settings = await opened.context.newPage();
    await settings.goto(`chrome://extensions/?id=${opened.extensionId}`);
    const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
    await toggle.click();
    await expect.poll(() => toggle.evaluate((element) => element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed"))).toBe("false");
    await manager.reload();
    await expect(manager.getByRole("status")).toContainText("Allow User Scripts");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toHaveLength(1);
    await toggle.click();
    await expect.poll(() => toggle.evaluate((element) => element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed"))).toBe("true");
    await manager.reload();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已注册")).toBeVisible();
    await settings.close();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.evaluate(async () => chrome.userScripts.unregister({ ids: ["managed"] }));
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(1);
    await manager.getByRole("button", { name: "停用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "删除" }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      await manager.mouse.move(0, 0);
      await expect.poll(() => manager.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme);
      await expectThemeButton(manager.getByRole("button", { name: "确认删除" }), colorScheme, "destructive");
    }
    await manager.getByRole("button", { name: "确认删除" }).click();
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toHaveCount(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"]).toEqual([]);
    await manager.getByRole("button", { name: "新建脚本" }).click();
    await manager.getByRole("button", { name: "JSON 高级编辑" }).click();
    await manager.locator("#script-definition").fill(JSON.stringify({ ...script, id: "complex", js: [{ code: "1" }, { code: "2" }] }));
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-definition")).toBeVisible();
    await expect(manager.getByRole("button", { name: "返回表单" })).toBeDisabled();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[])[0].js).toHaveLength(2);
    await manager.getByRole("button", { name: "复制为新脚本" }).click();
    await expect(manager.locator("#script-definition")).toContainText('"id": "complex-copy"');
    await manager.getByRole("button", { name: "保存" }).click();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("checkbox", { name: "选择当前搜索结果" }).click();
    await manager.getByRole("button", { name: "批量停用" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts()).length)).toBe(0);
    const downloadPromise = manager.waitForEvent("download");
    await manager.getByRole("button", { name: "导出所选" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("surf-wax-user-scripts.json");
    const exported = JSON.parse(await readFile(await download.path(), "utf8")) as chrome.userScripts.RegisteredUserScript[];
    expect(exported.map((item) => item.id).sort()).toEqual(["complex", "complex-copy"]);
    expect(exported.every((item) => !("enabled" in item))).toBe(true);
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([{ ...script, enabled: false }])) });
    await expect(manager.getByRole("alert")).toContainText("原生字段");
    await expect(manager.getByRole("heading", { name: "预览导入" })).toHaveCount(0);
    const imported = [
      { id: "complex", matches: script.matches, js: [{ code: "'imported'" }], runAt: "document_start" },
      { id: "new-one", matches: script.matches, js: [{ code: "'new'" }] },
    ];
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "scripts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(manager.getByRole("heading", { name: "预览导入" })).toBeVisible();
    await manager.getByRole("button", { name: "导入所选" }).click();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).find((item) => item.id === "complex")).toMatchObject({ js: [{ code: "1" }, { code: "2" }] });
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "scripts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await manager.getByRole("checkbox", { name: "覆盖 complex" }).click();
    await manager.getByRole("button", { name: "导入所选" }).click();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).find((item) => item.id === "complex")).toMatchObject({ runAt: "document_start", js: [{ code: "'imported'" }] });
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["complex"] })).length)).toBe(0);
    await manager.getByRole("button", { name: "批量启用" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["complex", "complex-copy"] })).length)).toBe(2);
    await manager.getByRole("button", { name: "批量删除" }).click();
    await manager.getByRole("button", { name: "确认删除" }).click();
    await expect(manager.getByLabel("已保存脚本").getByRole("button", { name: /complex/ })).toHaveCount(0);
    await manager.evaluate(async () => chrome.storage.local.set({ "side-agent:user-scripts": { legacy: "unreadable" } }));
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect(manager.getByRole("alert").first()).toContainText("原始数据已保留");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toEqual({ legacy: "unreadable" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
