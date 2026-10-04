import { expect, test } from "@playwright/test";
import { commandResponse, streamingTextResponse, textResponse, startProvider, openExtension, configure, nameCurrentConversation, readEvents, dispose } from "./fixtures";

test("executes more than 100 act steps and records a single tool result", async () => {
  const responses = [commandResponse("act", { timeoutMs: 30000, steps: Array.from({ length: 121 }, () => ({ type: "click", target: { by: "role", value: "button", name: "Increment" } })) }, "over-100"), textResponse("ALL_121_DONE")];
  const provider = await startProvider(responses); const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/performance`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await nameCurrentConversation(opened.page, "Unbounded act"); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("execute 121 actions"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("121", { timeout: 30000 });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ALL_121_DONE");
    const log = await readEvents(opened.page);
    expect(log.filter((event) => event.type === "automation.action.finished" && event.toolCallId === "over-100")).toHaveLength(121);
    expect(log.filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "over-100")).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("keeps user clicks, keys and paste blocked throughout agent input and iframe work", async () => {
  const provider = await startProvider([commandResponse("run-code", { timeoutMs: 30000, code: `async page => {
    for (let index = 0; index < 30; index++) {
      await page.locator('#agent').focus();
      await page.insertText('海🌊');
      await page.locator('#increment').click();
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return page.locator('#agent').inputValue();
  }` }, "guard-input"), textResponse("INPUT_GUARDED")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.evaluate((origin) => {
      document.body.innerHTML = `<input id="agent"><button id="increment" style="position:fixed;left:20px;top:80px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Increment</button><iframe src="${origin}/target"></iframe>`;
      window.addEventListener('keydown', (event) => { if (event.key === 'U') document.body.dataset.userKey = 'yes'; }, true);
      window.addEventListener('paste', () => { document.body.dataset.userPaste = 'yes'; }, true);
    }, provider.origin);
    await (await configure(opened.context, opened.page, provider.baseURL)).close(); await nameCurrentConversation(opened.page, "Guard tickets"); await target.bringToFront();
    const user = await opened.context.newCDPSession(target);
    await opened.page.getByTestId("composer-input").fill("type while preserving the interaction blocker"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("#__surf-wax-page-guard")).toBeAttached();
    await expect.poll(() => target.frames()[1]?.locator("#__surf-wax-page-guard").count()).toBe(1);
    await expect(target.locator("#agent")).not.toHaveValue("");
    for (let index = 0; index < 20; index++) {
      await user.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 95, button: "left", clickCount: 1 });
      await user.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 40, y: 95, button: "left", clickCount: 1 });
      await user.send("Input.dispatchKeyEvent", { type: "keyDown", key: "U", code: "KeyU", text: "U" });
      await user.send("Input.dispatchKeyEvent", { type: "keyUp", key: "U", code: "KeyU" });
      await user.send("Input.insertText", { text: "USER_PASTE" });
    }
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INPUT_GUARDED");
    await expect(target.locator("#agent")).toHaveValue("海🌊".repeat(30));
    expect(await target.evaluate(() => ({ ...document.body.dataset }))).toEqual({ clicks: "30" });
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    const terminals = (await readEvents(opened.page)).filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "guard-input");
    expect(terminals).toHaveLength(1); expect(terminals[0].type).toBe("tool.finished");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("applies explicit model and prompt changes next turn and retries user messages as logged branches", async () => {
  const provider = await startProvider([
    streamingTextResponse(["CONFIG_RUNNING", ...Array.from({ length: 200 }, () => "."), "CONFIG_DONE"]),
    textResponse("NEXT_TURN"), textResponse("USER_RETRY_BRANCH"),
  ], 10);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await nameCurrentConversation(opened.page, "Deferred settings");
    await opened.page.getByTestId("composer-input").fill("first turn"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CONFIG_RUNNING");
    await expect(opened.page.getByTestId("retry-user-message-button")).toBeDisabled();
    await options.getByLabel("Model ID", { exact: true }).fill("next-model");
    await options.getByLabel("自定义系统提示词").fill("CUSTOM_NEXT_TURN");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存"); await options.close();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CONFIG_DONE");
    expect(provider.requests[0].model).toBe("test-model"); expect(provider.stats.abortedResponses).toBe(0);
    await expect(opened.page.getByTestId("retry-user-message-button")).toBeEnabled();
    await opened.page.getByTestId("composer-input").fill("next turn"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEXT_TURN");
    expect(provider.requests[1].model).toBe("next-model");
    expect(provider.requests[1].messages[0].content).toMatch(/^CUSTOM_NEXT_TURN\n\n/);
    expect(provider.requests[1].messages[0].content).toContain("run-code");
    const nextMessage = (await readEvents(opened.page)).filter((event) => event.type === "conversation.message" && event.content?.role === "assistant").at(-1).content.id;
    await opened.page.getByTestId("retry-user-message-button").last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("USER_RETRY_BRANCH");
    await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEXT_TURN");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "context.prompt.updated")).toHaveLength(2);
    expect(events.filter((event) => event.type === "conversation.branch.selected").at(-1).content.headId).toBe(nextMessage);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
