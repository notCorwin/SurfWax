import { expect } from "@playwright/test";
import { test, configure, dispose, nameCurrentConversation, openExtension, startProvider, textResponse } from "./fixtures";

test("offers editable task suggestions and keeps the redesigned panel usable in narrow light and dark views", async () => {
  const provider = await startProvider([textResponse("## 页面重点\n\n已经整理好当前页面的主要内容。\n\n- 保留关键信息\n- 列出下一步行动"), textResponse("页面重点整理")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await opened.page.setViewportSize({ width: 430, height: 820 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      await expect(opened.page.getByTestId("thread-empty")).toBeVisible();
      await opened.page.screenshot({ animations: "disabled", path: test.info().outputPath(`welcome-${colorScheme}.png`) });
    }
    await opened.page.getByRole("button", { name: /读懂当前页面/ }).click();
    const composer = opened.page.getByTestId("composer-input");
    await expect(composer).toHaveValue("请阅读当前页面，提炼核心内容和关键结论。");
    await expect(composer).toBeFocused();
    expect(provider.requests).toHaveLength(0);
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("下一步行动");
    await expect(opened.page.getByTestId("thread-empty")).toHaveCount(0);
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("页面重点整理");
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      for (const width of [320, 430]) {
        await opened.page.setViewportSize({ width, height: 820 });
        await expect(composer).toBeInViewport();
        expect(await opened.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const reply = opened.page.locator(".assistant-message").last();
        expect(await reply.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        await opened.page.screenshot({ animations: "disabled", path: test.info().outputPath(`conversation-${colorScheme}-${width}.png`) });
      }
    }
    await opened.page.getByTestId("conversation-menu").click();
    const dialog = opened.page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "搜索会话" })).toBeVisible();
    await opened.page.screenshot({ animations: "disabled", path: test.info().outputPath("conversations-drawer.png") });
    await opened.page.keyboard.press("Escape");
    await expect(opened.page.getByTestId("conversation-menu")).toBeFocused();

    const longTitle = "这是一个用于检查窄侧栏会话标题显示的长标题";
    await nameCurrentConversation(opened.page, longTitle);
    const header = opened.page.locator(".app-header");
    const title = header.getByTestId("conversation-menu");
    await expect(header.getByRole("heading", { name: longTitle })).toBeVisible();
    await expect(title).toHaveAccessibleName(longTitle);
    await expect(title).not.toHaveAttribute("title");
    await expect(header.getByText("就绪")).toHaveCount(0);
    for (const width of [320, 430]) {
      await opened.page.setViewportSize({ width, height: 820 });
      const titleBox = await title.boundingBox();
      const actionsBox = await header.locator(".header-actions").boundingBox();
      expect(titleBox && actionsBox && titleBox.x + titleBox.width <= actionsBox.x).toBe(true);
      await expect(header.getByTestId("new-conversation")).toBeInViewport();
      await expect(header.getByTestId("open-settings")).toBeInViewport();
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
