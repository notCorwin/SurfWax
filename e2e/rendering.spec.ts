import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, browserResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

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
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
      { background: "rgba(0, 0, 0, 0)", foreground: "rgb(23, 23, 23)" },
      { background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" },
    ] });
    expect(optionSnapshots.dark.colorScheme).toBe("dark");
    expect(optionSnapshots.dark.colors.slice(0, 2)).toEqual([
      { background: "rgb(24, 24, 24)", foreground: "rgb(245, 245, 245)" },
      { background: "rgb(32, 32, 32)", foreground: "rgb(245, 245, 245)" },
    ]);
    expect(optionSnapshots.dark.colors[2]?.foreground).toBe("rgb(245, 245, 245)");
    expect(optionSnapshots.dark.colors[2]?.background).not.toBe(optionSnapshots.light.colors[2]?.background);
    expect(optionSnapshots.dark.colors[3]).toEqual({ background: "rgb(32, 32, 32)", foreground: "rgb(245, 245, 245)" });
    await options.close();

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("show theme markdown");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("const theme");
    await expect(opened.page.locator(".katex")).not.toHaveCount(0);
    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-dialog")).toBeVisible();
    expect(await metadata(opened.page)).toEqual(expectedMetadata);
    const sideSnapshots: Record<string, Awaited<ReturnType<typeof themeColors>>> = {};
    for (const colorScheme of ["light", "dark"] as const) {
      await opened.page.emulateMedia({ colorScheme });
      await opened.page.mouse.move(0, 0);
      await expect.poll(() => opened.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme);
      await expect.poll(() => opened.page.locator(".conversation-dialog").evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(colorScheme === "dark" ? "rgb(24, 24, 24)" : "rgb(255, 255, 255)");
      sideSnapshots[colorScheme] = await themeColors(opened.page, ["body", '[data-testid="thread-root"]', ".conversation-dialog", '[data-streamdown="code-block"] pre', ".katex"]);
      await expectThemeButton(opened.page.getByRole("button", { name: "发送消息", includeHidden: true }), colorScheme, "default");
      expect(await opened.page.getByTestId("composer-input").evaluate((input) => getComputedStyle(input).fontSize)).toBe("14px");
    }
    expect(sideSnapshots.light.colors.slice(0, 3)).toEqual(Array(3).fill({ background: "rgb(255, 255, 255)", foreground: "rgb(23, 23, 23)" }));
    expect(sideSnapshots.dark.colors.slice(0, 3)).toEqual(Array(3).fill({ background: "rgb(24, 24, 24)", foreground: "rgb(245, 245, 245)" }));
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
    await expect(opened.page.locator(".activity[data-status=complete]")).toHaveCount(2);
    await expect(group).toHaveCount(1);
    await expect(group.locator(":scope > summary")).toBeVisible();
    await expect(group.locator("summary svg")).toHaveCount(0);
    await expect(group.locator(".activity").first()).toBeHidden();
    await expect(opened.page.locator(".activity[data-status]")).toHaveCount(2);
    await expect(work).toHaveCount(1);
    await work.locator(":scope > summary").click();
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
    [
      chunk({ role: "assistant", content: "BETWEEN_PROCESS_GROUPS" }),
      chunk({ tool_calls: [{ index: 0, id: "call-after-text", type: "function", function: { name: "run-code", arguments: JSON.stringify({ code: "async page => { return 'SECOND_RESULT'; }" }) } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ],
    { parts: textResponse("FINAL_AFTER_GROUPS"), delayMs: 1500 },
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
    [
      chunk({ role: "assistant", content: "PROGRESS_BEFORE_ACTIVITIES" }),
      chunk({ reasoning_content: "PLAN" }),
      ...queuedToolResponse("return 'FIRST_RESULT'", "return 'SECOND_RESULT'"),
    ],
    { parts: textResponse("NEXT_PROGRESS_TEXT"), delayMs: 2500 },
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


test("continues the command label until assistant text arrives", async () => {
  const provider = await startProvider([
    toolResponse("return 'DONE'"),
    { parts: textResponse("FINAL_AFTER_WAIT"), delayMs: 1500 },
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


test("switches from reasoning to command while keeping completion labels for text", async () => {
  const provider = await startProvider([
    [chunk({ role: "assistant", reasoning_content: "PLAN" }), ...toolResponse("return 'DONE'")],
    { parts: textResponse("ANSWER_AFTER_REASONING"), delayMs: 1500 },
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
    await expect(group.locator(":scope > summary")).toHaveText("正在思考");
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
    [chunk({ role: "assistant", content: "PROGRESS_TEXT" }), ...toolResponse("await new Promise((resolve) => setTimeout(resolve, 300)); return 'WORK_RESULT'")],
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
    const answerLeft = await opened.page.locator(".conversation-turn").last().locator(".markdown-body").last()
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(workLeft).toBe(answerLeft);
    await expect(work).not.toHaveAttribute("open", "");
    await expect(work.locator(".activity")).toBeHidden();
    await expect(work).toContainText("PROGRESS_TEXT");
    await expect(work).not.toContainText("FINAL_REPLY");
    await expect(work.locator(".markdown-body")).toBeHidden();
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


test("distinguishes streaming command input from command execution", async () => {
  const input = JSON.stringify({ code: 'async page => { await new Promise((resolve) => setTimeout(resolve, 800)); return page.title(); }' });
  const provider = await startProvider([[
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-phase", type: "function", function: { name: "run-code", arguments: input.slice(0, 25) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: input.slice(25) } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ], textResponse("PHASE_DONE")], 300);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run a staged command");
    await opened.page.getByTestId("composer-input").press("Enter");
    const label = opened.page.getByTestId("process-trace").locator(":scope > summary span");
    await expect(label).toHaveText("正在输入命令");
    await expect(label).toHaveText("正在执行命令");
    await expect(label).toHaveText("已执行 1 次命令");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PHASE_DONE");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("streams complete Markdown without blocking draft input", async () => {
  const markdown = [
    "# Heading\n\n> quote\n\n- [x] task\n\n~~strike~~ and [link](https://example.com).\n\n",
    "| 搜索引擎 | 公司/国家 | 国际内容 | 中文内容 | 隐私功能 |\n| - | - | - | - | - |\n| Google | 美国 Google | ★★★ 最强 | ★★ 充足 | 一般 |\n| Bing 必应 | 美国 微软 | ★★ 仅次于 Google | ★★★ 丰富 | 一般 |\n\nInline $x^2$ and block:\n\n$$y=x+1$$\n\n",
    "```javascript\nconst answer = 42;\n```\n\nFootnote[^1].\n\n[^1]: note\n\nFINAL_MARKER",
  ].join("");
  const parts = [chunk({ role: "assistant", content: "LONG_RUNNING_LINE\n\n".repeat(100) }), ...[...markdown].map((content) => chunk({ content })), chunk({}, "stop"), "data: [DONE]\n\n"];
  const provider = await startProvider([parts, textResponse("Markdown 测试")], 2);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 1000 });
    await opened.page.emulateMedia({ colorScheme: "dark" });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("stream markdown");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toHaveAttribute("data-status", "running");
    await opened.page.getByTestId("thread-viewport").evaluate((viewport) => { viewport.scrollTop = 0; });
    await expect(composer).toBeInViewport();

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
    expect(await rendered.evaluate((element) => {
      const root = document.querySelector<HTMLElement>('[data-testid="thread-root"]');
      const flow = element.querySelector<HTMLElement>(".markdown-flow");
      const wrapper = flow?.firstElementChild;
      // GFM reference/footnote definitions require one shared parse block.
      const firstBlock = wrapper?.childElementCount && wrapper.childElementCount > 1 ? wrapper.firstElementChild : wrapper;
      const content = element.closest<HTMLElement>(".assistant-message-content");
      const turn = element.closest<HTMLElement>(".conversation-turn");
      if (!root || !firstBlock || !content || !turn) throw new Error("transcript layout is incomplete");
      return {
        background: getComputedStyle(root).backgroundColor,
        variable: getComputedStyle(root).getPropertyValue("--transcript-block-gap").trim(),
        markdownGap: getComputedStyle(firstBlock).marginBottom,
        partGap: getComputedStyle(content).rowGap,
        turnGap: getComputedStyle(turn).rowGap,
      };
    })).toEqual({ background: "rgb(24, 24, 24)", variable: "1.25rem", markdownGap: "20px", partGap: "20px", turnGap: "20px" });
    await opened.page.getByTestId("thread-viewport").evaluate((viewport) => { viewport.scrollTop = 0; });
    await expect(composer).toBeInViewport();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps jump-to-bottom usable while a long response is streaming", async () => {
  const parts = [
    chunk({ role: "assistant", content: "SCROLL_LINE\n\n".repeat(400) }),
    ...Array.from({ length: 500 }, (_, index) => chunk({ content: index % 40 === 0 ? `\nline ${index}\n` : "." })),
    chunk({ content: "FINAL_SCROLL_MARKER" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const provider = await startProvider([parts, textResponse("滚动测试")], 3);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 850 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("stream a long response");
    await composer.press("Enter");

    const viewport = opened.page.getByTestId("thread-viewport");
    const remaining = () => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1_200);
    for (const edit of await opened.page.getByTestId("edit-message-button").all()) await expect(edit).toBeDisabled();
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
