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
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const mode = opened.page.getByTestId("work-mode");
    await expect(mode).toContainText("普通模式");
    await mode.click();
    await opened.page.getByRole("option", { name: "目标模式" }).click();
    await expect(mode).toContainText("目标模式");
    await opened.page.getByTestId("composer-input").fill("Complete the goal");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(mode).toBeDisabled();
    await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("complete_goal");

    releaseReply();
    await expect(mode).toBeEnabled();
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const events = await readEvents(opened.page);
    expect(events.some((event) => event.type === "conversation.finished")).toBe(true);
    expect(events.some((event) => event.type === "tool.finished" && JSON.stringify(event.content).includes("complete_goal"))).toBe(true);
  } finally {
    releaseReply();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
