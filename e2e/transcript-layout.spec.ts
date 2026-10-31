import { test, expect, assistantResponse, delayedResponse, textResponse, startProvider, openExtension, configure, dispose } from "./fixtures";

test("keeps message, tool and waiting rows on the same spacing and type scale", async () => {
  const lines = ["我来帮你探索这个网站。让我先查看当前页面内容。", "让我继续浏览页面，收集更多内容。", "继续浏览页面内容。", "主页面内容已经扫描完毕。让我进一步查看页面导航和分类结构。"];
  const replies = lines.map((content, index) => assistantResponse({ content, tool_calls: Array.from({ length: index === lines.length - 1 ? 2 : 1 }, (_, call) => ({ id: `visual-${index}-${call}`, type: "function", function: { name: "execute_program", arguments: JSON.stringify({ code: "return await page.title();" }) } })) }));
  const provider = await startProvider([...replies, delayedResponse(textResponse("完成"), 30000)]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 400, height: 850 });
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("查看网站");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("waiting-status")).toContainText("等待推理提供商响应");
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveCount(3);
    await expect(opened.page.getByTestId("live-tool-calls").locator(".activity")).toHaveCount(2);
    const gaps = await opened.page.locator(".conversation-turn").last().evaluate((turn) => {
      const message = turn.querySelector<HTMLElement>(".assistant-message-content")!;
      const activity = message.querySelector<HTMLElement>('[data-testid="live-tool-calls"]')!;
      const rows = activity.querySelectorAll<HTMLElement>(".activity");
      const waiting = turn.querySelector<HTMLElement>('[data-testid="waiting-status"]')!;
      const completed = message.querySelector<HTMLElement>('[data-testid="tool-group-summary"]')!;
      const activeSummary = rows[0]!.querySelector<HTMLElement>("summary")!;
      return { turn: getComputedStyle(turn).rowGap, message: getComputedStyle(message).rowGap, activities: getComputedStyle(activity).rowGap,
        actual: Math.round(waiting.getBoundingClientRect().top - activity.getBoundingClientRect().bottom),
        rowSpace: Math.round(rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().bottom),
        sizes: [completed, activeSummary, waiting].map((element) => getComputedStyle(element).fontSize),
        offsets: [completed, activeSummary, waiting].map((element) => Math.round(element.getBoundingClientRect().left - turn.getBoundingClientRect().left)) };
    });
    expect(gaps).toEqual({ turn: "8px", message: "8px", activities: "8px", actual: 8, rowSpace: 8,
      sizes: ["13px", "13px", "13px"], offsets: [0, 0, 0] });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
