import { expect, test, type Locator, type Page } from "@playwright/test";
import { configure, dispose, enableUserScripts, focusPageControl, openExtension, startProvider } from "./fixtures";

async function expectFocus(page: Page, control: Locator, owner: Locator, color: string) {
  await page.bringToFront();
  await control.evaluate((element) => (element as HTMLElement).blur());
  const shadow = await owner.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    return getComputedStyle(element).boxShadow;
  });
  await focusPageControl(page, control);
  await page.keyboard.press("Tab");
  await control.focus();
  await expect(control).toBeFocused();
  await expect(owner).toHaveCSS("outline-style", "solid");
  await expect(owner).toHaveCSS("outline-width", "2px");
  await expect(owner).toHaveCSS("outline-color", color);
  await expect(owner).toHaveCSS("outline-offset", "2px");
  await expect(owner).toHaveCSS("box-shadow", shadow);
}

test("shows one shared focus indicator across search, composer, settings and script editing", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await opened.page.evaluate(() => chrome.storage.local.set({
      "side-agent:user-scripts": [{ id: "focus-demo", matches: ["https://example.org/*"], js: [{ code: "void 0;" }], world: "USER_SCRIPT" }],
      "side-agent:user-scripts-disabled": ["focus-demo"],
    }));
    const manager = await opened.context.newPage();
    await manager.goto(`chrome-extension://${opened.extensionId}/userscripts.html`);
    const checkbox = manager.getByRole("checkbox", { name: "选择 focus-demo", exact: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      await expectFocus(manager, checkbox, checkbox, colorScheme === "light" ? "rgb(115, 115, 115)" : "rgb(163, 163, 163)");
      await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
    }
    await manager.getByRole("button", { name: "新建脚本" }).click();

    for (const colorScheme of ["light", "dark"] as const) {
      const color = colorScheme === "light" ? "rgb(115, 115, 115)" : "rgb(163, 163, 163)";
      for (const page of [opened.page, options, manager]) await page.emulateMedia({ colorScheme });

      await opened.page.bringToFront();
      await opened.page.getByTestId("conversation-menu").click();
      const search = opened.page.getByRole("searchbox", { name: "搜索会话" });
      const searchGroup = opened.page.getByRole("dialog", { name: "对话列表" }).locator('[data-slot="input-group"]');
      await expectFocus(opened.page, search, searchGroup, color);
      await expect(search).toHaveCSS("outline-style", "none");
      expect(await searchGroup.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThan(0);
      const path = test.info().outputPath(`conversation-search-focus-${colorScheme}.png`);
      await opened.page.screenshot({ path });
      await test.info().attach(`conversation-search-focus-${colorScheme}`, { path, contentType: "image/png" });
      await opened.page.keyboard.press("Escape");

      const composer = opened.page.getByTestId("composer-input");
      const composerGroup = opened.page.getByRole("group", { name: "发送浏览器任务" });
      await expectFocus(opened.page, composer, composerGroup, color);
      await expect(composer).toHaveCSS("outline-style", "none");
      const composerShadow = await composerGroup.evaluate((element) => getComputedStyle(element).boxShadow);
      await composer.fill("保留焦点检查草稿");
      const send = opened.page.getByRole("button", { name: "发送消息", exact: true });
      await expectFocus(opened.page, send, send, color);
      await expect(composerGroup).toHaveCSS("outline-style", "none");
      await expect(composerGroup).toHaveCSS("box-shadow", composerShadow);
      const reasoning = opened.page.getByTestId("reasoning-effort");
      await expectFocus(opened.page, reasoning, reasoning, color);
      await expect(reasoning).toHaveCSS("box-shadow", "none");
      await expect(composerGroup).toHaveCSS("outline-style", "none");

      const providerInput = options.getByRole("combobox", { name: "Provider", exact: true });
      await expectFocus(options, providerInput, options.locator(".search-combobox").first(), color);
      await expect(providerInput).toHaveCSS("outline-style", "none");
      const baseURL = options.getByRole("textbox", { name: "Base URL", exact: true });
      await expectFocus(options, baseURL, baseURL, color);

      const code = manager.locator("#script-code .cm-content");
      await expectFocus(manager, code, manager.locator("#script-code"), color);
      await expect(code).toHaveCSS("outline-style", "none");
      await expect(manager.locator("#script-code .cm-editor")).toHaveCSS("outline-style", "none");
      const matches = manager.getByRole("textbox", { name: "运行于哪些网站", exact: true });
      await expectFocus(manager, matches, matches, color);
    }

    await manager.getByRole("button", { name: "保存", exact: true }).click();
    await expect(manager.locator("#script-id-error")).toContainText("请输入脚本 ID");
    await expect(manager.locator("#script-id")).toBeFocused();
    await expect(manager.locator("#script-id")).toHaveCSS("outline-width", "2px");
    await expect(manager.locator("#script-id")).toHaveCSS("outline-color", "rgb(239, 68, 68)");
    await expect(opened.page.getByTestId("composer-input")).toHaveValue("保留焦点检查草稿");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
