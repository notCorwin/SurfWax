import { expect, type Locator, type Page } from "@playwright/test";
import { test, configure, dispose, enableUserScripts, focusPageControl, openExtension, startProvider } from "./fixtures";

async function expectFocus(page: Page, control: Locator, owner: Locator) {
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
  await expect(control).toHaveCSS("outline-style", "none");
  await expect(owner).toHaveCSS("outline-style", "none");
  await expect(owner).toHaveCSS("box-shadow", shadow);
}

test("keeps keyboard controls functional without focus rings across the extension", async () => {
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
      await expectFocus(manager, checkbox, checkbox);
      await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
    }
    await manager.getByRole("button", { name: "新建脚本" }).click();

    for (const colorScheme of ["light", "dark"] as const) {
      for (const page of [opened.page, options, manager]) await page.emulateMedia({ colorScheme });

      await opened.page.bringToFront();
      await opened.page.getByTestId("conversation-menu").click();
      await opened.page.getByRole("dialog", { name: "对话列表" }).getByRole("button", { name: "搜索会话" }).click();
      const search = opened.page.getByRole("searchbox", { name: "搜索会话" });
      const searchGroup = opened.page.getByRole("dialog", { name: "对话列表" }).locator('[data-slot="input-group"]');
      await expectFocus(opened.page, search, searchGroup);
      await expect(search).toHaveCSS("outline-style", "none");
      expect(await searchGroup.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThan(0);
      await opened.page.keyboard.press("Escape");

      const composer = opened.page.getByTestId("composer-input");
      const composerGroup = opened.page.getByRole("group", { name: "发送浏览器任务" });
      await expectFocus(opened.page, composer, composerGroup);
      await expect(composer).toHaveCSS("outline-style", "none");
      const composerShadow = await composerGroup.evaluate((element) => getComputedStyle(element).boxShadow);
      await composer.fill("保留焦点检查草稿");
      const send = opened.page.getByRole("button", { name: "发送消息", exact: true });
      await expectFocus(opened.page, send, send);
      await expect(composerGroup).toHaveCSS("outline-style", "none");
      await expect(composerGroup).toHaveCSS("box-shadow", composerShadow);
      const reasoning = opened.page.getByTestId("reasoning-effort");
      await expectFocus(opened.page, reasoning, reasoning);
      await expect(reasoning).toHaveCSS("box-shadow", "none");
      await expect(composerGroup).toHaveCSS("outline-style", "none");

      const providerInput = options.getByRole("combobox", { name: "Provider", exact: true });
      await expectFocus(options, providerInput, options.locator(".search-combobox").first());
      await expect(providerInput).toHaveCSS("outline-style", "none");
      const baseURL = options.getByRole("textbox", { name: "Base URL", exact: true });
      await expectFocus(options, baseURL, baseURL);

      const code = manager.locator("#script-code .cm-content");
      await expectFocus(manager, code, manager.locator("#script-code"));
      await expect(code).toHaveCSS("outline-style", "none");
      await expect(manager.locator("#script-code .cm-editor")).toHaveCSS("outline-style", "none");
      const matches = manager.getByRole("textbox", { name: "运行于哪些网站", exact: true });
      await expectFocus(manager, matches, matches);
    }

    await manager.getByRole("button", { name: "保存", exact: true }).click();
    await expect(manager.locator("#script-id-error")).toContainText("请输入脚本 ID");
    await expect(manager.locator("#script-id")).toBeFocused();
    await expect(manager.locator("#script-id")).toHaveCSS("outline-style", "none");
    await expect(manager.locator("#script-id")).toHaveAttribute("aria-invalid", "true");
    await expect(opened.page.getByTestId("composer-input")).toHaveValue("保留焦点检查草稿");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
