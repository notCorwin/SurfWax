import { expect, test, startProvider, textResponse, delayedResponse, commandResponse, configure, openExtension, dispose, readEvents } from "./fixtures";

test("goal mode recovers after progress text and a failed action, then verifies the browser outcome", async () => {
  const lastTool = (request: any) => {
    const content = request.messages.filter((entry: any) => entry.role === "tool").at(-1).content;
    return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
  };
  let uncertainEvidenceId: string | undefined;
  const provider = await startProvider([
    textResponse("I am checking the form."),
    commandResponse("inspect_page", {}, "initial-page"),
    commandResponse("fill", { target: { by: "label", value: "Old email", exact: true }, value: "agent@example.com", timeoutMs: 100 }, "missing-input"),
    (request) => {
      const failed = lastTool(request);
      expect(failed).toMatchObject({ ok: false, evidenceId: expect.any(String) });
      if (failed.error?.effectUnknown) uncertainEvidenceId = failed.evidenceId;
      return textResponse("I will inspect the current form and continue.");
    },
    commandResponse("inspect_page", {}, "updated-page"),
    commandResponse("fill", { target: { by: "label", value: "Email", exact: true }, value: "agent@example.com" }, "fill-email"),
    commandResponse("click", { target: { by: "role", value: "button", name: "Sign in", exact: true } }, "submit"),
    commandResponse("verify_state", { target: { by: "css", value: "output" }, textEquals: "Welcome agent@example.com" }, "verify"),
    (request) => {
      const result = lastTool(request);
      expect(result).toMatchObject({ ok: true, result: { verified: true }, evidenceId: expect.any(String) });
      return commandResponse("complete_goal", { taskType: "browser", status: "completed",
        evidence: [{ evidenceId: result.evidenceId, observation: "The form displays Welcome agent@example.com; the requested final value and submission outcome are verified after the interrupted attempt.", ...(uncertainEvidenceId ? { resolves: [uncertainEvidenceId] } : {}) }] }, "finish", "Verified the submitted form.");
    },
    textResponse("Form completed"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, undefined, {});
    await options.close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await opened.page.getByTestId("composer-input").fill("Submit this form using agent@example.com and verify the welcome message.");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".assistant-message").filter({ hasText: "Verified the submitted form." })).toBeVisible();
    await expect(target.locator("output")).toHaveText("Welcome agent@example.com");
    await expect(opened.page.getByRole("switch", { name: "目标模式" })).toBeEnabled();
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "conversation.finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.goal.continued")).toHaveLength(2);
    expect(events.some((event) => event.type === "tool.failed" && event.toolCallId?.endsWith("missing-input"))).toBe(true);
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(7);
    expect(events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type))).toHaveLength(7);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("goal mode keeps working until its completion tool is called", async () => {
  let releaseReply!: () => void;
  const replyMayFinish = new Promise<void>((resolve) => { releaseReply = resolve; });
  const provider = await startProvider([
    delayedResponse(textResponse("Still working"), 0, replyMayFinish),
    commandResponse("complete_goal", { taskType: "answer", status: "completed" }, "goal-complete"),
    textResponse("目标模式测试"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 1_000_000, {});
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
    await expect(mode).toContainText("目标模式");
    await expect(mode).toBeChecked();
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
    await opened.page.mouse.move(0, 0);
    await expect(mode).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await mode.click();
    await expect(mode).not.toBeChecked();
    await expect.poll(() => opened.page.evaluate(async () => (await chrome.storage.local.get("side-agent:goal-mode"))["side-agent:goal-mode"])).toBe(false);
    await opened.page.reload();
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
