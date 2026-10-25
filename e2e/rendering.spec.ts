import { chromium, expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { test, p95, textResponse, assistantResponse, delayedResponse, toolResponse, pageResponse, commandResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

test("follows the system color scheme across every visible extension surface without reloading", async () => {
  const provider = await startProvider([
    textResponse("```javascript\nconst theme = 'system';\n```\n\n$$x^2$$"), textResponse("主题测试"),
  ]);
  const opened = await openExtension();
  try {
    const metadata = (page: Page) => page.evaluate(() => ({
      colorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
      themeColors: [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => [meta.media, meta.content]),
    }));
    const expectedMetadata = { colorScheme: "light dark", themeColors: [
      ["(prefers-color-scheme: light)", "#ffffff"], ["(prefers-color-scheme: dark)", "#181818"],
    ] };
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByLabel("Provider", { exact: true }).click();
    await expect(options.locator(".search-combobox-content")).toBeVisible();
    expect(await metadata(options)).toEqual(expectedMetadata);
    const optionSnapshots: Record<string, Awaited<ReturnType<typeof themeColors>>> = {};
    for (const colorScheme of ["light", "dark"] as const) {
      await options.emulateMedia({ colorScheme });
      await options.mouse.move(0, 0);
      await expect.poll(() => options.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme);
      await expect.poll(() => options.locator('[data-slot="input"]').first().evaluate((input) => getComputedStyle(input).color))
        .toBe(colorScheme === "dark" ? "rgb(245, 245, 245)" : "rgb(23, 23, 23)");
      optionSnapshots[colorScheme] = await themeColors(options, ["body", '[data-slot="card"]', '[data-slot="input"]', ".search-combobox-content"]);
      await expectThemeButton(options.getByRole("button", { name: "保存配置" }), colorScheme, "default");
      await expectThemeButton(options.getByTestId("event-log-clear"), colorScheme, "destructive");
      expect(await options.locator('[data-slot="input"]').first().evaluate((input) => getComputedStyle(input).fontSize)).toBe("14px");
    }
    expect(optionSnapshots.light).toEqual({ colorScheme: "light", colors: [
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(23, 23, 23)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(23, 23, 23)" },
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
    ] });
    expect(optionSnapshots.dark.colorScheme).toBe("dark");
    expect(optionSnapshots.dark.colors.slice(0, 2)).toEqual([
      { background: "rgb(24, 24, 24)", foreground: "rgb(245, 245, 245)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(245, 245, 245)" },
    ]);
    expect(optionSnapshots.dark.colors[2]?.foreground).toBe("rgb(245, 245, 245)");
    expect(optionSnapshots.dark.colors[2]?.background).toBe(optionSnapshots.light.colors[2]?.background);
    expect(optionSnapshots.dark.colors[3]).toEqual({ background: "rgb(32, 32, 32)", foreground: "rgb(245, 245, 245)" });
    await options.close();

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("show theme markdown");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("const theme");
    await expect(opened.page.locator(".katex")).not.toHaveCount(0);
    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-dropdown")).toBeVisible();
    expect(await metadata(opened.page)).toEqual(expectedMetadata);
    const sideSnapshots: Record<string, Awaited<ReturnType<typeof themeColors>>> = {};
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      await opened.page.mouse.move(0, 0);
      await expect.poll(() => opened.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme);
      await expect.poll(() => opened.page.locator(".conversation-dropdown").evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(colorScheme === "dark" ? "rgb(32, 32, 32)" : "rgb(255, 255, 255)");
      sideSnapshots[colorScheme] = await themeColors(opened.page, ["body", '[data-testid="thread-root"]', ".conversation-dropdown", '[data-streamdown="code-block"] pre', ".katex"]);
      await expectThemeButton(opened.page.getByRole("button", { name: "发送消息", includeHidden: true }), colorScheme, "default");
      expect(await opened.page.getByTestId("composer-input").evaluate((input) => getComputedStyle(input).fontSize)).toBe("14px");
    }
    expect(sideSnapshots.light.colors.slice(0, 3)).toEqual([
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(23, 23, 23)" },
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
    ]);
    expect(sideSnapshots.dark.colors.slice(0, 3)).toEqual([
      { background: "rgb(24, 24, 24)", foreground: "rgb(245, 245, 245)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(245, 245, 245)" },
      { background: "rgb(32, 32, 32)", foreground: "rgb(245, 245, 245)" },
    ]);
    expect(sideSnapshots.dark.colors[3]).not.toEqual(sideSnapshots.light.colors[3]);
    expect(sideSnapshots.dark.colors[4]?.foreground).toBe("rgb(245, 245, 245)");
    await opened.page.keyboard.press("Escape");

  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("collapses adjacent commands into one line without hiding their details", async () => {
  const provider = await startProvider([
    queuedToolResponse("return 'FIRST_RESULT'", "return 'SECOND_RESULT'"),
    textResponse("完成"),
  ], 500);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run two commands");
    await opened.page.getByTestId("composer-input").press("Enter");
    const group = opened.page.getByTestId("process-trace");
    const work = opened.page.getByTestId("work-summary");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("完成");
    await expect(work).toHaveCount(1);
    await work.locator(":scope > summary").click();
    await expect(opened.page.locator(".activity[data-status=complete]")).toHaveCount(2);
    await expect(group).toHaveCount(1);
    await expect(group.locator(":scope > summary")).toBeVisible();
    await expect(group.locator("summary svg")).toHaveCount(0);
    await expect(group.locator(".activity").first()).toBeHidden();
    await expect(opened.page.locator(".activity[data-status]")).toHaveCount(2);
    await expect(group.locator(":scope > summary")).toHaveText("已执行 2 次命令");
    await expect(group.locator(".activity")).toHaveCount(2);
    await expect(group).not.toHaveAttribute("open", "");
    await group.locator(":scope > summary").click();
    await group.locator(".activity summary").first().click();
    await expect(group).toContainText("FIRST_RESULT");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("完成");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("starts a new process line after assistant text", async () => {
  const provider = await startProvider([
    toolResponse("return 'FIRST_RESULT'", "call-before-text"),
    assistantResponse({ content: "BETWEEN_PROCESS_GROUPS", tool_calls: [{ id: "call-after-text", type: "function", function: { name: "run", arguments: JSON.stringify({ code: "return 'SECOND_RESULT';" }) } }] }),
    delayedResponse(textResponse("FINAL_AFTER_GROUPS"), 1_500),
    textResponse("分段过程记录"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("split process records around text");
    await opened.page.getByTestId("composer-input").press("Enter");
    const liveGroups = opened.page.getByTestId("process-trace");
    await expect(liveGroups).toHaveCount(2);
    await expect(liveGroups.nth(0).locator(":scope > summary")).toHaveText("已执行 1 次命令");
    await expect(liveGroups.nth(1).locator(":scope > summary")).toHaveText("正在执行命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_AFTER_GROUPS");
    const work = opened.page.getByTestId("work-summary");
    await work.locator(":scope > summary").click();
    const groups = work.getByTestId("process-trace");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator(":scope > summary")).toHaveText("已执行 1 次命令");
    await expect(groups.nth(1).locator(":scope > summary")).toHaveText("已执行 1 次命令");
    await expect(work).toContainText("BETWEEN_PROCESS_GROUPS");
    await expect(work).not.toContainText("FINAL_AFTER_GROUPS");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("continues the latest activity after earlier progress text", async () => {
  const provider = await startProvider([
    assistantResponse({ content: "PROGRESS_BEFORE_ACTIVITIES", reasoning_content: "PLAN", tool_calls: [
      { id: "call-queued-0", type: "function", function: { name: "run", arguments: JSON.stringify({ code: "return 'FIRST_RESULT'" }) } },
      { id: "call-queued-1", type: "function", function: { name: "run", arguments: JSON.stringify({ code: "return 'SECOND_RESULT'" }) } },
    ] }),
    delayedResponse(textResponse("NEXT_PROGRESS_TEXT"), 2_500),
    textResponse("活动顺序测试"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("progress then think and run twice");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body", { hasText: "PROGRESS_BEFORE_ACTIVITIES" })).toHaveCount(1);
    const group = opened.page.getByTestId("process-trace");
    await expect(group.locator(".activity")).toHaveCount(2);
    await expect(group.locator(":scope > summary")).toHaveText("正在执行命令");
    await group.locator(":scope > summary").click();
    await expect(group.getByTestId("reasoning-item").locator(":scope > summary")).toHaveText("思考完成");
    await expect(group.locator(".activity").first().locator(":scope > summary")).toHaveText("命令执行完成");
    await expect(group.locator(".activity").last().locator(":scope > summary")).toHaveText("正在执行命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEXT_PROGRESS_TEXT");
    await opened.page.getByTestId("work-summary").locator(":scope > summary").click();
    await expect(group.locator(":scope > summary")).toHaveText("已思考并执行 2 次命令");
    await expect(group.locator(".activity").last().locator(":scope > summary")).toHaveText("命令执行完成");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("continues the command label while waiting for the next complete response", async () => {
  const provider = await startProvider([
    toolResponse("return 'DONE'"),
    delayedResponse(textResponse("FINAL_AFTER_WAIT"), 1_500),
    textResponse("等待回复"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run then reply");
    await opened.page.getByTestId("composer-input").press("Enter");
    const group = opened.page.getByTestId("process-trace");
    await expect(group.locator(":scope > summary")).toHaveText("正在执行命令");
    await expect(group.locator(".activity summary")).toHaveText("正在执行命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_AFTER_WAIT");
    await opened.page.getByTestId("work-summary").locator(":scope > summary").click();
    await expect(group.locator(":scope > summary")).toHaveText("已执行 1 次命令");
    await expect(group.locator(".activity summary")).toHaveText("命令执行完成");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows completed reasoning alongside command execution", async () => {
  const provider = await startProvider([
    assistantResponse({ reasoning_content: "PLAN", tool_calls: [{ id: "call-chrome-e2e", type: "function", function: { name: "run", arguments: JSON.stringify({ code: "return 'DONE'" }) } }] }),
    delayedResponse(textResponse("ANSWER_AFTER_REASONING"), 1_500),
    textResponse("推理测试"),
  ], 600);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("reason then run");
    await opened.page.getByTestId("composer-input").press("Enter");
    const group = opened.page.getByTestId("process-trace");
    await expect(group.locator(":scope > summary")).toHaveText("正在执行命令");
    await group.locator(":scope > summary").click();
    await expect(group.getByTestId("reasoning-item").locator(":scope > summary")).toHaveText("思考完成");
    await expect(group.locator(".activity summary")).toHaveText("正在执行命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ANSWER_AFTER_REASONING");
    await opened.page.getByTestId("work-summary").locator(":scope > summary").click();
    await expect(group.locator(":scope > summary")).toHaveText("已思考并执行 1 次命令");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("stops continued activity when a reply is interrupted", async () => {
  const provider = await startProvider([
    queuedToolResponse(
      "await new Promise((resolve) => setTimeout(resolve, 60_000)); return 'TOO_LATE'",
      "return 'NEVER_STARTED'",
    ),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("interrupt two commands");
    await opened.page.getByTestId("composer-input").press("Enter");
    const group = opened.page.getByTestId("process-trace");
    await expect(group).toHaveCount(1);
    await expect(group.locator(":scope > summary")).toContainText("正在执行命令");
    await expect(group.locator(".activity[data-status=running]")).toHaveCount(2);
    await expect(group.locator(".activity[data-status=running]").first()).toBeHidden();
    await opened.page.getByRole("button", { name: "停止生成" }).click();
    await expect(group.locator(":scope > summary")).toHaveText("回复中断");
    await group.locator(":scope > summary").click();
    await expect(group.locator(".activity[data-status]")).toHaveCount(2);
    await expect(group.locator(".activity[data-status=running]")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("stops continued activity when the model request fails", async () => {
  const provider = await startProvider([toolResponse("return 'DONE'"), { status: 400, error: "fatal request" }]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run then fail");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("process-trace").locator(":scope > summary")).toHaveText("回复失败");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows live work, then folds it under elapsed time while keeping the final reply visible after restore", async () => {
  const provider = await startProvider([
    assistantResponse({ content: "PROGRESS_TEXT", tool_calls: [{ id: "call-chrome-e2e", type: "function", function: { name: "run", arguments: JSON.stringify({ code: "await new Promise((resolve) => setTimeout(resolve, 300)); return 'WORK_RESULT'" }) } }] }),
    textResponse("FINAL_REPLY"),
    textResponse("工作摘要标题"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("do the work");
    await opened.page.getByTestId("composer-input").press("Enter");
    const work = opened.page.getByTestId("work-summary");
    await expect(work.locator(":scope > summary")).toHaveText(/^工作了 \d+ 秒$/);
    await expect(work.locator(":scope > summary svg")).toHaveCount(0);
    const workLeft = await work.locator(":scope > summary span").evaluate((element) => element.getBoundingClientRect().left);
    const answerLeft = await opened.page.locator(".conversation-turn").last().locator(".markdown-body p").last()
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(workLeft).toBe(answerLeft);
    await expect(work).not.toHaveAttribute("open", "");
    await expect(work.locator(".activity")).toBeHidden();
    await expect(work).toContainText("PROGRESS_TEXT");
    await expect(work).not.toContainText("FINAL_REPLY");
    await expect(work.locator(".markdown-body p")).toBeHidden();
    await expect(opened.page.locator(".conversation-turn").last().locator(".markdown-body").last()).toContainText("FINAL_REPLY");
    await expect(work.locator(".markdown-body")).toContainText("PROGRESS_TEXT");
    await expect(opened.page.locator('[data-role="user"]').last()).toContainText("do the work");
    const events = await readEvents(opened.page);
    const submitted = events.find((event) => event.type === "conversation.submitted");
    const finished = events.find((event) => event.type === "conversation.finished" && event.runId === submitted?.runId);
    const seconds = Math.floor((Date.parse(finished.timestamp) - Date.parse(submitted.timestamp)) / 1000);
    await expect(work.locator(":scope > summary")).toHaveText(`工作了 ${seconds} 秒`);
    await work.locator(":scope > summary").click();
    await work.getByTestId('process-trace').locator(':scope > summary').click();
    await work.locator('.activity > summary').click();
    await expect(work).toContainText("WORK_RESULT");
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "工作摘要标题" }).locator(".conversation-select").click();
    await expect(opened.page.getByTestId("work-summary")).toHaveCount(1);
    await expect(opened.page.getByTestId("work-summary")).not.toHaveAttribute("open", "");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_REPLY");
    await opened.page.getByTestId("work-summary").locator(":scope > summary").click();
    await expect(opened.page.getByTestId("process-trace").locator(":scope > summary")).toHaveText("已执行 1 次命令");
    await opened.page.getByTestId('process-trace').locator(':scope > summary').click();
    await opened.page.locator('.activity > summary').click();
    await expect(opened.page.getByTestId('work-summary')).toContainText('WORK_RESULT');
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("executes complete tool arguments once they arrive", async () => {
  const provider = await startProvider([toolResponse('await sleep(800); return await page.title();', "call-phase"), textResponse("PHASE_DONE")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run one complete command");
    await opened.page.getByTestId("composer-input").press("Enter");
    const label = opened.page.getByTestId("process-trace").locator(":scope > summary span");
    await expect(label).toHaveText("正在执行命令");
    await expect(label).toHaveText("已执行 1 次命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PHASE_DONE");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.started" && event.toolCallId === "call-phase")).toHaveLength(1);
    expect(events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "call-phase")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("renders a complete Markdown response without blocking draft input", async () => {
  const markdown = [
    "# Heading\n\n> quote\n\n- [x] task\n\n~~strike~~ and [link](https://example.com).\n\n",
    "| 搜索引擎 | 公司/国家 | 国际内容 | 中文内容 | 隐私功能 |\n| - | - | - | - | - |\n| Google | 美国 Google | ★★★ 最强 | ★★ 充足 | 一般 |\n| Bing 必应 | 美国 微软 | ★★ 仅次于 Google | ★★★ 丰富 | 一般 |\n\nInline $x^2$ and block:\n\n$$y=x+1$$\n\n",
    "```javascript\nconst answer = 42;\n```\n\nFootnote[^1].\n\n[^1]: note\n\nFINAL_MARKER",
  ].join("");
  const provider = await startProvider([delayedResponse(textResponse("LONG_RESPONSE_LINE\n\n".repeat(100) + markdown), 700), textResponse("Markdown 测试")]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 1000 });
    await opened.page.emulateMedia({ colorScheme: "dark" });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("render complete markdown");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.locator(".markdown-body")).toHaveCount(0);
    const draft = "responsive-draft-".repeat(40);
    const started = Date.now();
    await composer.pressSequentially(draft);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(composer).toHaveValue(draft);
    const rendered = opened.page.locator(".markdown-body").last();
    await expect(rendered).toContainText("FINAL_MARKER");
    await expect(rendered.locator("table")).toBeVisible();
    await expect(rendered.locator('input[type="checkbox"]')).toBeChecked();
    await expect(rendered.locator("del")).toHaveText("strike");
    await expect(rendered.locator("blockquote")).toContainText("quote");
    await expect(rendered.locator("pre code")).toContainText("const answer = 42");
    await expect(rendered.locator(".katex")).not.toHaveCount(0);
    await expect(rendered.locator("sup")).not.toHaveCount(0);
    expect(await rendered.evaluate((element) => {
      const find = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        return node;
      };
      const border = (selector: string) => getComputedStyle(find(selector)).borderTopWidth;
      return {
        code: border('[data-streamdown="code-block"]'),
        codeBody: border('[data-streamdown="code-block-body"]'),
        codeBodyPaddingLeft: getComputedStyle(find('[data-streamdown="code-block-body"]')).paddingLeft,
        pre: border('[data-streamdown="code-block-body"] pre'),
        actions: border('[data-streamdown="code-block-actions"]'),
        table: border('[data-streamdown="table-wrapper"]'),
        tableBody: border('[data-streamdown="table-wrapper"] > :last-child'),
        striped: getComputedStyle(find('[data-streamdown="table-body"] tr:nth-child(2)')).backgroundColor,
      };
    })).toEqual({ code: "1px", codeBody: "0px", codeBodyPaddingLeft: "0px", pre: "0px", actions: "0px", table: "1px", tableBody: "0px", striped: "rgb(36, 36, 36)" });
    const tableScroll = rendered.locator('[data-streamdown="table-wrapper"] > :last-child');
    for (const colorScheme of ["dark", "light"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      for (const width of [430, 900]) {
        await opened.page.setViewportSize({ width, height: 1000 });
        const layout = await tableScroll.evaluate((scroll) => {
          const table = scroll.querySelector("table")!;
          const row = table.querySelector("tbody tr")!;
          const cells = [...row.querySelectorAll("td")];
          return {
            scrollWidth: scroll.scrollWidth,
            clientWidth: scroll.clientWidth,
            rowHeight: row.getBoundingClientRect().height,
            minCellWidth: Math.min(...cells.map((cell) => cell.getBoundingClientRect().width)),
          };
        });
        expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
        expect(layout.minCellWidth).toBeGreaterThanOrEqual(144);
        expect(layout.rowHeight).toBeLessThan(90);
        await tableScroll.evaluate((scroll) => { scroll.scrollLeft = scroll.scrollWidth; });
        expect(await tableScroll.evaluate((scroll) => scroll.scrollLeft)).toBeGreaterThan(0);
        expect(await opened.page.getByTestId("thread-viewport").evaluate((viewport) => viewport.scrollWidth)).toBeLessThanOrEqual(width);
        await expect(composer).toBeInViewport();
      }
    }
    await opened.page.setViewportSize({ width: 430, height: 1000 });
    await rendered.locator('[data-streamdown="table-wrapper"] button').last().focus();
    await opened.page.keyboard.press("Tab");
    await expect(tableScroll).toBeFocused();
    expect(await tableScroll.evaluate((scroll) => getComputedStyle(scroll).outlineWidth)).toBe("2px");
    await tableScroll.evaluate((scroll) => { scroll.scrollLeft = 0; });
    await opened.page.keyboard.press("ArrowRight");
    await expect.poll(() => tableScroll.evaluate((scroll) => scroll.scrollLeft)).toBeGreaterThan(0);
    await opened.page.emulateMedia({ colorScheme: "dark" });
    await rendered.locator('[data-streamdown="table-wrapper"] button').last().click();
    const fullscreen = opened.page.locator('[data-streamdown="table-fullscreen"]');
    await expect(fullscreen).toBeVisible();
    for (const width of [430, 900]) {
      await opened.page.setViewportSize({ width, height: 1000 });
      expect(await fullscreen.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })))
        .toEqual({ width, height: 1000 });
      const layout = await fullscreen.locator('[data-streamdown="table"] tbody tr').first().evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        minCellWidth: Math.min(...[...row.querySelectorAll("td")].map((cell) => cell.getBoundingClientRect().width)),
      }));
      expect(layout.minCellWidth).toBeGreaterThanOrEqual(144);
      expect(layout.height).toBeLessThan(90);
    }
    await opened.page.setViewportSize({ width: 430, height: 1000 });
    const fullscreenScroll = fullscreen.locator('[data-streamdown="table-wrapper"] > :last-child');
    expect(await fullscreenScroll.evaluate((scroll) => scroll.scrollWidth)).toBeGreaterThan(await fullscreenScroll.evaluate((scroll) => scroll.clientWidth));
    await fullscreenScroll.evaluate((scroll) => { scroll.scrollLeft = scroll.scrollWidth; });
    expect(await fullscreenScroll.evaluate((scroll) => scroll.scrollLeft)).toBeGreaterThan(0);
    await fullscreen.locator("button").last().click();
    await expect(fullscreen).toHaveCount(0);
    const copy = rendered.getByRole("button", { name: "Copy Code" });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(rendered.locator('output[aria-live="polite"]')).toHaveText("Copied");
    await rendered.locator("p").first().scrollIntoViewIfNeeded();
    expect(await rendered.evaluate((element) => {
      const root = document.querySelector<HTMLElement>('[data-testid="thread-root"]');
      const [first, second] = element.querySelectorAll("p");
      if (!root || !first || !second) throw new Error("transcript layout is incomplete");
      return {
        background: getComputedStyle(root).backgroundColor,
        paragraphGap: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
        lineHeight: getComputedStyle(first).lineHeight,
      };
    })).toEqual({ background: "rgba(0, 0, 0, 0)", paragraphGap: 12, lineHeight: "21px" });
    await opened.page.getByTestId("thread-viewport").evaluate((viewport) => { viewport.scrollTop = 0; });
    await expect(composer).toBeInViewport();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps jump-to-bottom usable after a long complete response", async () => {
  const longReply = "SCROLL_LINE\n\n".repeat(400) + Array.from({ length: 500 }, (_, index) => index % 40 === 0 ? `\nline ${index}\n` : ".").join("") + "FINAL_SCROLL_MARKER";
  const provider = await startProvider([textResponse(longReply), textResponse("滚动测试")]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 850 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("render a long response");
    await composer.press("Enter");

    const viewport = opened.page.getByTestId("thread-viewport");
    const remaining = () => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1_200);
    await expect(opened.page.getByTestId("edit-message-button")).toBeVisible();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    const box = await viewport.boundingBox();
    if (!box) throw new Error("thread viewport has no bounding box");
    await opened.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await opened.page.mouse.wheel(0, -1_200);
    await expect.poll(remaining).toBeGreaterThan(500);

    const jump = opened.page.getByRole("button", { name: "滚动到底部" });
    await expect(jump).toBeVisible();
    await expect(jump).toBeEnabled();
    await jump.click();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_SCROLL_MARKER");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
