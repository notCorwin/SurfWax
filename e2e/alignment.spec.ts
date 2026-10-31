import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, delayedResponse, startProvider, openExtension, configure, nameCurrentConversation, readEvents, dispose } from "./fixtures";

test("shares the job-state Web Lock between the side panel and service worker", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const worker = opened.context.serviceWorkers()[0] ?? await opened.context.waitForEvent("serviceworker");
    await worker.evaluate(async () => {
      let ready!: () => void;
      const acquired = new Promise<void>((resolve) => { ready = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      (globalThis as any).__surfWaxTestReleaseJobLock = release;
      void navigator.locks.request("surf-wax:job-state-log", async () => { ready(); await held; });
      await acquired;
    });
    expect(await opened.page.evaluate(() => navigator.locks.request("surf-wax:job-state-log", { ifAvailable: true }, (lock) => lock === null))).toBe(true);
    await worker.evaluate(() => (globalThis as any).__surfWaxTestReleaseJobLock());
    await expect.poll(() => opened.page.evaluate(() => navigator.locks.request("surf-wax:job-state-log", { ifAvailable: true }, (lock) => Boolean(lock)))).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("executes more than 100 program operations and records a single tool result", async () => {
  const responses = [commandResponse("execute_program", { timeoutMs: 30000, code: "for (let i=0;i<121;i++) await page.getByRole('button',{name:'Increment'}).click(); await check(await page.locator('output').innerText()==='121');" }, "over-100"), textResponse("ALL_121_DONE")];
  const provider = await startProvider(responses); const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/performance`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await nameCurrentConversation(opened.page, "Unbounded program"); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("execute 121 actions"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("121", { timeout: 30000 });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ALL_121_DONE");
    const log = await readEvents(opened.page);
    expect(log.filter((event) => event.type === "automation.action.finished" && event.toolCallId === "over-100" && event.content.operation === "click")).toHaveLength(121);
    expect(log.some(event => event.type === "browser.job.progress" && event.toolCallId === "over-100" && event.content.operation === "check" && event.content.state === "verified")).toBe(true);
    expect(log.filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "over-100")).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("allows user interaction while the agent is working", async () => {
  const provider = await startProvider([commandResponse("execute_program", { code: `
    await page.evaluate(() => { document.body.dataset.agentStarted = 'yes'; });
    await new Promise(resolve => setTimeout(resolve, 4000));
    await page.locator('#agent').fill('agent value');
    return page.locator('#agent').inputValue();
  `, timeoutMs: 30000 }, "concurrent-input"), textResponse("INPUT_DONE")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<input id="agent"><input id="user"><button id="increment" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Increment</button>`;
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("work while I use the page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("body")).toHaveAttribute("data-agent-started", "yes");
    await target.locator("#user").click();
    await target.keyboard.type("user value");
    await target.locator("#increment").click();
    await expect(target.locator("#user")).toHaveValue("user value");
    await expect(target.locator("body")).toHaveAttribute("data-clicks", "1");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INPUT_DONE");
    await expect(target.locator("#agent")).toHaveValue("agent value");
    const terminals = (await readEvents(opened.page)).filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "concurrent-input");
    expect(terminals).toHaveLength(1); expect(terminals[0].type).toBe("tool.finished");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("applies explicit model and prompt changes next turn and retries user messages as logged branches", async () => {
  const provider = await startProvider([
    delayedResponse(textResponse("CONFIG_DONE"), 250),
    textResponse("NEXT_TURN"), textResponse("USER_RETRY_BRANCH"),
  ], 10);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await nameCurrentConversation(opened.page, "Deferred settings");
    await opened.page.getByTestId("composer-input").fill("first turn"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.getByTestId("retry-user-message-button")).toHaveCount(0);
    await options.getByLabel("Model ID", { exact: true }).fill("next-model");
    await options.getByRole("tab", { name: "智能体" }).click();
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
    expect(provider.requests[1].messages[0].content).toContain("- inspect_page:");
    expect(provider.requests[1].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["inspect_page", "click", "fill", "execute_program", "list_jobs", "get_job", "cancel_job"]));
    let nextMessage: string | undefined;
    await expect.poll(async () => {
      nextMessage = (await readEvents(opened.page)).find((event) => event.type === "conversation.message" && event.content?.role === "assistant" && event.content.parts?.some((part: any) => part.type === "text" && part.text === "NEXT_TURN"))?.content.id;
      return nextMessage;
    }).toBeTruthy();
    await opened.page.getByTestId("retry-user-message-button").last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("USER_RETRY_BRANCH");
    await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEXT_TURN");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "context.prompt.updated")).toHaveLength(2);
    await expect.poll(async () => (await readEvents(opened.page)).filter((event) => event.type === "conversation.branch.selected").at(-1)?.content.headId).toBe(nextMessage);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
