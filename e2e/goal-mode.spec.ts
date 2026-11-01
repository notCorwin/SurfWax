import { expect, test, startProvider, textResponse, delayedResponse, commandResponse, configure, openExtension, dispose, readEvents } from "./fixtures";

test("goal mode keeps working until its completion tool is called", async () => {
  let releaseReply!: () => void;
  const replyMayFinish = new Promise<void>((resolve) => { releaseReply = resolve; });
  const provider = await startProvider([
    delayedResponse(textResponse("Still working"), 0, replyMayFinish),
    commandResponse("complete_goal", { status: "completed", summary: "Goal reached" }, "goal-complete"),
    textResponse("目标模式测试"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    const longModel = "provider/extraordinarily-long-browser-automation-model-name";
    await options.getByLabel("Model ID", { exact: true }).fill(longModel);
    await options.getByRole("button", { name: "保存配置" }).click();
    const model = opened.page.getByTestId("composer-model");
    await expect(model).toHaveAttribute("title", longModel);
    await options.close();
    const mode = opened.page.getByRole("switch", { name: "目标模式" });
    const reasoning = opened.page.getByRole("combobox", { name: "思考强度" });
    const context = opened.page.getByTestId("context-indicator");
    const send = opened.page.getByRole("button", { name: "发送消息" });
    await expect(mode).toContainText("普通模式");
    await expect(mode).not.toBeChecked();
    // The name yields space to interactive controls at side-panel widths, in both themes.
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      for (const width of [320, 400]) {
        await opened.page.setViewportSize({ width, height: 720 });
        for (const control of [model, mode, reasoning, context, send]) await expect(control).toBeInViewport();
        const boxes = await Promise.all([model, mode, reasoning, context, send].map((control) => control.boundingBox()));
        expect(boxes.every((box) => box && box.width > 0 && box.x >= 0 && box.x + box.width <= width)).toBe(true);
        for (let i = 1; i < boxes.length; i++) expect(boxes[i - 1]!.x + boxes[i - 1]!.width).toBeLessThanOrEqual(boxes[i]!.x + 0.5);
        expect(await opened.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await mode.click();
    await expect(mode).toBeChecked();
    await expect(mode).toContainText("目标模式");
    await opened.page.mouse.move(0, 0);
    await expect(mode).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await mode.click();
    await expect(mode).not.toBeChecked();
    await mode.focus();
    await expect(mode).toBeFocused();
    await mode.press("Space");
    await expect(mode).toBeChecked();
    await expect(mode).toContainText("目标模式");
    await opened.page.getByTestId("composer-input").fill("Complete the goal");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(mode).toBeDisabled();
    await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("complete_goal");

    releaseReply();
    await expect(mode).toBeEnabled();
    await expect(mode).toBeChecked();
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const events = await readEvents(opened.page);
    expect(events.some((event) => event.type === "conversation.finished")).toBe(true);
    expect(events.some((event) => event.type === "tool.finished" && JSON.stringify(event.content).includes("complete_goal"))).toBe(true);
  } finally {
    releaseReply();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
