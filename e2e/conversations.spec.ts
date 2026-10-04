import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, browserResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

test("executes run-code through the page facade, restores the conversation, and clears the log", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  const code = "return { title: await page.title(), url: await page.url() };";
  responses.push(toolResponse(code), textResponse("META_OK"), textResponse("工具测试"));
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(targetUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("exercise the page facade");
    await composer.press("Enter");
    const process = opened.page.getByTestId("process-trace");
    await expect(process).toHaveCount(1);
    await expect(process.locator(":scope > summary")).toContainText("已执行 1 次命令");
    await expect(process.locator(":scope > summary span")).not.toHaveClass(/shimmer/);
    await expect(process).not.toHaveAttribute("open", "");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("META_OK");
    await opened.page.getByTestId("work-summary").locator(":scope > summary").click();
    await process.locator(":scope > summary").click();
    await process.locator(".activity summary").click();
    await expect(process.locator(".activity")).toContainText("Side Agent Target");

    await expect.poll(() => provider.requests.length).toBe(3);
    expect(provider.requests[0].reasoning_effort).toBe("minimal");
    expect(provider.requests[0].tools).toHaveLength(49);
    expect(provider.requests[0].tools.map((tool: any) => tool.function.name)).not.toContain("browser");
    expect(provider.requests[0].tools).toContainEqual(expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "run-code" }) }));
    const events = await readEvents(opened.page);
    const tool = events.find((event) => event.type === "tool.finished");
    expect(tool).toMatchObject({ toolCallId: "call-chrome-e2e", input: { code: expect.stringContaining("async page") }, latencyMs: expect.any(Number) });
    expect(tool.output).toMatchObject({ title: "Side Agent Target", url: targetUrl });
    expect(events.filter((event) => /^(model|request|tool)\./.test(event.type)).every((event) => typeof event.conversationId === "string")).toBe(true);
    expect(events.filter((event) => event.type === "conversation.message")).toHaveLength(2);

    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.locator('[data-role="user"]')).toHaveCount(0);
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "工具测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator('[data-role="user"]')).toContainText("exercise the page facade");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("META_OK");

    const clearOptions = await configure(opened.context, opened.page, provider.baseURL);
    clearOptions.once("dialog", (dialog) => dialog.accept());
    await clearOptions.getByTestId("event-log-clear").click();
    await expect(clearOptions.getByRole("status")).toContainText("已清空");
    await expect.poll(() => readEvents(clearOptions)).toEqual([]);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("queues multiple follow-up messages while running and dispatches them in FIFO order", async () => {
  const provider = await startProvider([
    streamingTextResponse(["FIRST_RUNNING", ...Array.from({ length: 80 }, () => "."), " FIRST_DONE"]),
    textResponse("SECOND_DONE"),
    textResponse("THIRD_DONE"),
  ], 120);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await nameCurrentConversation(opened.page, "Follow-up FIFO");
    await composer.fill("initial request");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.getByRole("button", { name: "排队消息", exact: true })).toHaveCount(0);
    await expect(composer).toBeEnabled();

    await composer.fill("second request");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await opened.page.getByRole("button", { name: "排队消息", exact: true }).click();
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.getByRole("button", { name: "排队消息", exact: true })).toHaveCount(0);
    await composer.fill("third request");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("followup-item")).toHaveText([/second request/, /third request/]);

    await expect(opened.page.locator(".markdown-body").last()).toContainText("THIRD_DONE", { timeout: 15_000 });
    await expect(opened.page.getByTestId("followup-queue")).toHaveCount(0);
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBe(3);
    const agentRequests = provider.requests.filter((request) => request.tools);
    expect(JSON.stringify(agentRequests[1].messages)).toContain("second request");
    expect(JSON.stringify(agentRequests[2].messages)).toContain("third request");
    expect(JSON.stringify(agentRequests[2].messages).indexOf("second request"))
      .toBeLessThan(JSON.stringify(agentRequests[2].messages).indexOf("third request"));
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "conversation.followup.queued")).toHaveLength(2);
    expect(events.filter((event) => event.type === "conversation.followup.dispatched").map((event) => event.content.mode))
      .toEqual(["followup", "followup"]);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("sends a selected follow-up immediately, closes interrupted tools and keeps the remaining queue", async () => {
  const provider = await startProvider([
    toolResponse("await new Promise((resolve) => setTimeout(resolve, 60_000)); return 'TOO_LATE'", "call-followup-interrupted"),
    textResponse("URGENT_DONE"),
    textResponse("LATER_DONE"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await nameCurrentConversation(opened.page, "Follow-up immediate");
    await composer.fill("long running request");
    await composer.press("Enter");
    await expect(opened.page.locator(".process-trace[data-status=running]")).toBeVisible();
    for (const message of ["later request", "urgent request", "remove request"]) {
      await composer.fill(message);
      await composer.press("Enter");
    }
    const queue = opened.page.getByTestId("followup-queue");
    await expect(queue.getByTestId("followup-item")).toHaveCount(3);
    await queue.getByTestId("followup-item").filter({ hasText: "remove request" }).getByRole("button", { name: "移除排队消息" }).click();
    await expect(queue).not.toContainText("remove request");
    await queue.getByTestId("followup-item").filter({ hasText: "urgent request" }).getByRole("button", { name: "立即发送" }).click();

    await expect(opened.page.locator(".markdown-body").last()).toContainText("LATER_DONE", { timeout: 15_000 });
    await expect(queue).toHaveCount(0);
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBe(3);
    expect(provider.requests).toHaveLength(3);
    const agentRequests = provider.requests.filter((request) => request.tools);
    expect(JSON.stringify(agentRequests[1].messages)).toContain("urgent request");
    expect(JSON.stringify(agentRequests[2].messages)).toContain("later request");
    const events = await readEvents(opened.page);
    expect(events.some((event) => event.type === "conversation.aborted")).toBe(true);
    expect(JSON.stringify(events.find((event) => event.type === "tool.failed" && event.toolCallId === "call-followup-interrupted")?.error))
      .toMatch(/abort/i);
    expect(events.some((event) => event.type === "conversation.followup.removed")).toBe(true);
    expect(events.find((event) => event.type === "conversation.followup.dispatched" && event.content.mode === "immediate")).toBeTruthy();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps paused follow-ups after stop and panel reload until the user resumes them", async () => {
  const provider = await startProvider([
    streamingTextResponse(["WORKING", ...Array.from({ length: 80 }, () => ".")]),
    textResponse("RESUMED_DONE"),
  ], 120);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await nameCurrentConversation(opened.page, "Paused follow-up");
    await composer.fill("long request");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await composer.fill("saved request");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("followup-queue")).toContainText("saved request");

    await opened.page.getByRole("button", { name: "停止生成" }).click();
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "Paused follow-up" }).locator(".conversation-select").click();
    const queue = opened.page.getByTestId("followup-queue");
    await expect(queue).toContainText("saved request");
    await opened.page.waitForTimeout(500);
    expect(provider.requests.filter((request) => request.tools)).toHaveLength(1);

    await queue.getByRole("button", { name: "立即发送" }).click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESUMED_DONE", { timeout: 15_000 });
    await expect(queue).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("creates, titles, switches, starts fresh on reload and permanently deletes local conversations", async () => {
  const provider = await startProvider([
    textResponse("FIRST_REPLY"),
    textResponse("第一标题"),
    textResponse("SECOND_REPLY"),
    textResponse("第二标题"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first conversation");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_REPLY");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第一标题");
    expect(provider.requests[1]).toMatchObject({ model: "test-model" });
    expect(provider.requests[1].tools).toBeUndefined();

    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await composer.fill("second conversation");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_REPLY");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第二标题");

    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-item")).toHaveCount(2);
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_REPLY");
    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.locator(".markdown-body")).toHaveCount(0);

    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_REPLY");

    await opened.page.getByTestId("conversation-menu").click();
    opened.page.once("dialog", (dialog) => dialog.accept());
    await opened.page.locator(".conversation-item", { hasText: "第二标题" }).locator(".conversation-delete").click();
    await expect(opened.page.locator(".conversation-item")).toHaveCount(1);
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "conversation.created")).toHaveLength(1);
    expect(events.some((event) => event.type === "conversation.deleted" && event.content.conversationId)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("searches saved messages, renames, archives and restores conversations", async () => {
  const provider = await startProvider([textResponse("FIRST_REPLY"), textResponse("第一标题")]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("unique saved message");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第一标题");
    await opened.page.getByTestId("conversation-menu").click();
    const search = opened.page.getByRole("searchbox", { name: "搜索会话" });
    await search.fill("unique saved message");
    expect(await search.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe("solid");
    await expect(opened.page.locator(".conversation-item")).toHaveCount(1);
    await search.fill("not found");
    await expect(opened.page.getByText("没有找到匹配的会话")).toBeVisible();
    await search.fill("");

    await opened.page.getByRole("button", { name: "重命名 第一标题" }).click();
    const name = opened.page.getByRole("textbox", { name: "会话名称" });
    await name.fill("  ");
    await name.press("Enter");
    await expect(opened.page.getByText("请输入会话名称")).toBeVisible();
    await name.fill("取消的标题");
    await name.press("Escape");
    await expect(opened.page.locator(".conversation-item")).toContainText("第一标题");
    await opened.page.getByRole("button", { name: "重命名 第一标题" }).click();
    await name.fill("手动命名");
    await name.press("Enter");
    await expect(opened.page.locator(".conversation-item")).toContainText("手动命名");
    await opened.page.getByRole("button", { name: "归档 手动命名" }).click();
    await expect(opened.page.getByText("已归档", { exact: true })).toBeVisible();
    await search.fill("手动命名");
    await expect(opened.page.locator(".conversation-item")).toHaveCount(1);
    await opened.page.getByRole("button", { name: "关闭对话列表" }).click();
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.getByText("已归档", { exact: true })).toBeVisible();
    await opened.page.getByRole("searchbox", { name: "搜索会话" }).fill("unique saved message");
    await expect(opened.page.locator(".conversation-item")).toContainText("手动命名");
    await opened.page.getByRole("button", { name: "恢复 手动命名" }).click();
    await expect(opened.page.getByText("已归档", { exact: true })).toHaveCount(0);
    await expect(opened.page.locator(".conversation-item")).toContainText("手动命名");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("blocks leaving a running conversation without aborting it", async () => {
  const slowReply = [chunk({ role: "assistant", content: "STREAM_RUNNING" }), ...Array.from({ length: 100 }, () => chunk({ content: "." })), chunk({ content: "STREAM_DONE" }), chunk({}, "stop"), "data: [DONE]\n\n"];
  const provider = await startProvider([textResponse("FIRST_REPLY"), textResponse("第一标题"), slowReply, textResponse("第二标题")], 20);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first task");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第一标题");
    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await composer.fill("second task");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_RUNNING");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.keyboard.press("Escape");
    await expect(opened.page.getByTestId("new-conversation")).toBeDisabled();
    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select")).toBeDisabled();
    for (const control of await opened.page.locator(".conversation-action, .conversation-delete").all()) await expect(control).toBeDisabled();
    await expect(opened.page.locator(".conversation-dialog")).toBeVisible();
    await expect(opened.page.locator(".conversation-dialog").getByTestId("new-conversation")).toHaveCount(0);
    await expect(opened.page.locator(".conversation-item")).toHaveCount(2);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_DONE");
    expect(provider.stats.abortedResponses).toBe(0);
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_REPLY");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("manual renaming wins over an in-flight automatic title", async () => {
  const slowTitle = [chunk({ role: "assistant", content: "自动标题" }), ...Array.from({ length: 60 }, () => chunk({ content: "。" })), chunk({}, "stop"), "data: [DONE]\n\n"];
  const provider = await startProvider([textResponse("REPLY"), slowTitle], 20);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("title race");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REPLY");
    await expect.poll(() => provider.requests.length).toBeGreaterThanOrEqual(2);
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item .conversation-action").first().click();
    await opened.page.getByRole("textbox", { name: "会话名称" }).fill("用户指定标题");
    await opened.page.getByRole("textbox", { name: "会话名称" }).press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("用户指定标题");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "model.title.finished")).toBe(true);
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("用户指定标题");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("resets conversation UI while retaining only each conversation's own draft", async () => {
  const provider = await startProvider([
    textResponse("LONG_REPLY\n\n".repeat(300)), textResponse("第一标题"),
    textResponse("SECOND_REPLY"), textResponse("第二标题"),
  ]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first conversation");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第一标题");
    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await composer.fill("second conversation");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第二标题");

    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body")).toContainText("LONG_REPLY");
    const viewport = opened.page.getByTestId("thread-viewport");
    await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
    await viewport.hover();
    await opened.page.mouse.wheel(0, -100_000);
    await expect(opened.page.getByRole("button", { name: "滚动到底部" })).toBeVisible();
    await composer.fill("first unsent draft");
    await opened.context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.sendMessage({ type: "surf-wax:guard-warning", tabId: 1 }));
    await expect(opened.page.getByText("标签页 1 无法启用防点击保护；智能体仍可继续运行。")).toBeVisible();

    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await expect(opened.page.getByRole("button", { name: "滚动到底部" })).toHaveCount(0);
    await expect(opened.page.locator(".markdown-body")).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(opened.page.getByText("标签页 1 无法启用防点击保护；智能体仍可继续运行。")).toHaveCount(0);
    await expect(viewport).toHaveJSProperty("scrollTop", 0);

    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第二标题" }).locator(".conversation-select").click();
    // fill() can target an inert textarea behind the still-open dialog. Wait
    // for the destination to commit, as a real user must before typing.
    await expect(opened.page.getByRole("dialog", { name: "对话列表" })).toBeHidden();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第二标题");
    await expect(composer).toHaveValue("");
    await composer.fill("second unsent draft");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(composer).toHaveValue("first unsent draft");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第二标题" }).locator(".conversation-select").click();
    await expect(composer).toHaveValue("second unsent draft");
    const events = JSON.stringify(await readEvents(opened.page));
    expect(events).not.toContain("first unsent draft");
    expect(events).not.toContain("second unsent draft");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("edits user messages, regenerates replies and restores the selected branch", async () => {
  const originalQuestion = "帮我收藏24小时成交量至少1000万USDT的非TradFi永续合约。成交量越小越先收藏。";
  const slowReply = streamingTextResponse(["BRANCH_RUNNING", ...Array.from({ length: 80 }, () => "."), "BRANCH_DONE"]);
  const provider = await startProvider([
    textResponse("ORIGINAL_REPLY"),
    textResponse("分支测试"),
    textResponse("REGENERATED_REPLY"),
    textResponse("EDITED_REPLY"),
    textResponse("FOLLOWUP_REPLY"),
    slowReply,
  ], 10);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill(originalQuestion);
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("分支测试");
    const originalReply = (await readEvents(opened.page)).find((event) => event.type === "conversation.message"
      && event.content?.parts?.some((part: any) => part.type === "text" && part.text === "ORIGINAL_REPLY"))?.content.id;
    expect(originalReply).toBeTruthy();

    await opened.page.getByTestId("replay-message-button").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REGENERATED_REPLY");
    await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByTestId("work-summary")).toHaveCount(1);
    await expect.poll(async () => (await readEvents(opened.page)).filter((event) => event.type === "conversation.branch.selected").at(-1)?.content?.headId).toBe(originalReply);

    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "分支测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");

    const bubbleBeforeEdit = await opened.page.getByTestId("user-message-bubble").boundingBox();
    await opened.page.getByTestId("edit-message-button").click();
    const bubbleDuringEdit = await opened.page.getByTestId("user-message-bubble").boundingBox();
    expect(bubbleDuringEdit?.width).toBeCloseTo(bubbleBeforeEdit!.width, 0);
    expect(Math.abs(bubbleDuringEdit!.height - bubbleBeforeEdit!.height)).toBeLessThan(4);
    await opened.page.setViewportSize({ width: 320, height: 720 });
    await opened.page.getByTestId("edit-message-input").fill("long-edit-text-".repeat(40));
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      expect(await opened.page.getByTestId("edit-message-input").evaluate((input) => {
        const editor = input.closest("form")!;
        return {
          outline: getComputedStyle(input).outlineStyle,
          resize: getComputedStyle(input).resize,
          focused: editor.matches(":focus-within"),
          capped: input.clientHeight <= 128 && input.scrollHeight > input.clientHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      })).toEqual({ outline: "none", resize: "none", focused: true, capped: true, overflow: false });
    }
    await opened.page.getByTestId("edit-message-input").fill("cancelled edit");
    await opened.page.getByRole("button", { name: "取消" }).click();
    await expect(opened.page.getByTestId("edit-message-input")).toHaveCount(0);
    expect(provider.requests).toHaveLength(3);
    await opened.page.getByTestId("edit-message-button").click();
    await opened.page.getByTestId("edit-message-input").fill("edited question");
    await opened.page.getByRole("button", { name: "保存并重新生成" }).click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITED_REPLY");
    await composer.fill("follow up");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOLLOWUP_REPLY");
    const recordedMessages = JSON.stringify((await readEvents(opened.page)).filter((event) => event.type === "conversation.message").map((event) => event.content));
    for (const text of [originalQuestion, "edited question", "ORIGINAL_REPLY", "REGENERATED_REPLY", "EDITED_REPLY", "FOLLOWUP_REPLY"]) {
      expect(recordedMessages).toContain(text);
    }
    const promptTexts = provider.requests.at(-1).messages.flatMap((message: any) => typeof message.content === "string"
      ? [message.content]
      : message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text) ?? []);
    expect(promptTexts).toEqual(expect.arrayContaining(["edited question", "follow up"]));
    expect(JSON.stringify(provider.requests.at(-1).messages)).not.toContain(originalQuestion);

    await opened.page.getByRole("button", { name: "上一个分支" }).first().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect.poll(async () => (await readEvents(opened.page)).filter((event) => event.type === "conversation.branch.selected").at(-1)?.content?.headId).toBe(originalReply);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "分支测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByLabel("消息分支").first()).toBeVisible();
    await composer.fill("check branch visibility");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    for (const branch of await opened.page.getByLabel("消息分支").getByRole("button").all()) await expect(branch).toBeDisabled();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BRANCH_DONE");
    await expect(opened.page.getByLabel("消息分支").first()).toBeVisible();
  } catch (error) {
    await test.info().attach("branch-events-final.json", { body: JSON.stringify(await readEvents(opened.page), null, 2), contentType: "application/json" });
    throw error;
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps the original reply after a failed regeneration", async () => {
  const provider = await startProvider([
    textResponse("ORIGINAL_REPLY"),
    textResponse("失败重试测试"),
    { status: 400, error: "regeneration rejected" },
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("initial question");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("失败重试测试");
    await opened.page.getByTestId("replay-message-button").click();
    await expect.poll(() => provider.requests.length).toBe(3);
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "conversation.failed")).toBe(true);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "失败重试测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps a running conversation alive when a switch is blocked", async () => {
  const slowReply = [
    chunk({ role: "assistant", content: "STREAM_RUNNING" }),
    ...Array.from({ length: 200 }, () => chunk({ content: "." })),
    chunk({ content: "BACKGROUND_DONE" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const provider = await startProvider([slowReply, textResponse("后台标题")], 20);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("keep running in background");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_RUNNING");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.keyboard.press("Escape");
    await expect(opened.page.getByTestId("new-conversation")).toBeDisabled();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BACKGROUND_DONE");
    await expect.poll(() => provider.requests.length).toBe(2);
    expect(provider.stats.abortedResponses).toBe(0);
    await startNewConversation(opened.page);
    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-item")).toHaveCount(1);
    await opened.page.locator(".conversation-item", { hasText: "后台标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BACKGROUND_DONE");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("contains a long conversation search error inside the menu", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        if (names === "events" && mode === "readonly") throw new Error("SEARCH_ERROR_".repeat(2000));
        return original.call(this, names, mode, options);
      };
    });
    await opened.page.getByTestId("conversation-menu").click();
    const dialog = opened.page.locator(".conversation-dialog");
    const notice = dialog.locator(".app-error-notice");
    await expect(notice).toContainText("搜索记录读取失败");
    await expect(dialog.getByRole("button", { name: "关闭对话列表" })).toBeVisible();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("SEARCH_ERROR_");
    expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(dialog.getByRole("searchbox")).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
