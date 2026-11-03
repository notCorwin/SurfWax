import { chromium, expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { test, p95, textResponse, assistantResponse, delayedResponse, commandResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

const completedInfo = /^查看页面信息 · \d+\.\d{2} 秒$/;
const infoCall = (id: string) => ({ id, type: "function", function: { name: "get_page_info", arguments: "{}" } });

test("uses the same line-height ratio across conversation content", async () => {
  const markdown = "# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n#### 四级标题\n\n##### 五级标题\n\n###### 六级标题\n\n正文内容\n\n```js\nconst n = 1;\n```\n\n| 列 | 值 |\n| --- | --- |\n| 一 | 二 |";
  const provider = await startProvider([commandResponse("get_page_info", {}, "line-height-tool"), delayedResponse(textResponse(markdown), 3_000), textResponse("排版测试")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("字号和行高测试");
    await opened.page.getByTestId("composer-input").press("Enter");
    const assertRatio = async (locator: Locator) => {
      const { fontSize, lineHeight } = await locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
      });
      expect(lineHeight).toBeCloseTo(fontSize * 1.5, 1);
    };
    const userBubble = opened.page.getByTestId("user-message-bubble");
    const tool = opened.page.getByTestId("live-tool-calls").locator(".activity");
    const waiting = opened.page.getByTestId("waiting-status");
    await expect(tool).toHaveCount(1);
    await expect(waiting).toBeVisible();
    await assertRatio(userBubble);
    await assertRatio(tool);
    await assertRatio(waiting);
    const rendered = opened.page.locator(".markdown-body").last();
    await expect(rendered).toContainText("正文内容");
    for (const selector of ["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "th", "td"]) {
      const node = rendered.locator(selector).first();
      await expect(node).toBeVisible();
      await assertRatio(node);
    }
    await opened.page.getByTestId("edit-message-button").click();
    const editor = opened.page.getByTestId("edit-message-input");
    await expect(editor).toBeVisible();
    await assertRatio(editor);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("keeps at most three recent tool calls and summarizes them after interruption", async () => {
  const provider = await startProvider([assistantResponse({ tool_calls: [infoCall("rolling-0"), infoCall("rolling-1"), infoCall("rolling-2"),
    { id: "rolling-3", type: "function", function: { name: "verify_state", arguments: JSON.stringify({ target: { by: "css", value: "#never" }, state: "visible", timeoutMs: 60_000 }) } },
  ] })]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run four tools");
    await opened.page.getByTestId("composer-input").press("Enter");
    const list = opened.page.getByTestId("live-tool-calls");
    const rows = list.locator(".activity");
    await expect(rows).toHaveCount(3);
    await expect(rows.last()).toHaveText(/^检查页面状态 · \d+\.\d{2} 秒$/);
    const before = await rows.last().innerText();
    await expect.poll(() => rows.last().innerText()).not.toBe(before);
    await opened.page.getByRole("button", { name: "停止生成" }).click();
    await expect(list).toHaveCount(0);
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveCount(1);
    await expect(opened.page.getByTestId("tool-group-summary")).toContainText("查看页面信息并检查页面状态");
    await expect(opened.page.getByRole("button", { name: "继续" })).toBeVisible();
    await expect(opened.page.getByTestId("tool-group-summary").locator("summary, button")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("bounds live tool calls and summarizes earlier failures", async () => {
  const failing = Array.from({ length: 5 }, (_, index) => ({
    id: `failed-${index}`, type: "function", function: { name: "get_page_info", arguments: JSON.stringify({ tabId: 2147483647 }) },
  }));
  const recent = Array.from({ length: 3 }, (_, index) => infoCall(`recent-${index}`));
  const provider = await startProvider([
    assistantResponse({ tool_calls: [...failing, ...recent] }), delayedResponse(textResponse("FAILURE_SUMMARY_DONE"), 5_000), textResponse("工具状态测试"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run failed and successful tools");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && [...failing, ...recent].some((tool) => tool.id === event.toolCallId)).length).toBe(8);
    const viewport = opened.page.getByTestId("live-tool-viewport");
    const rows = viewport.locator("[data-tool-id]");
    await expect(rows).toHaveCount(3);
    await expect.poll(() => rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-tool-id")))).toEqual(recent.map((tool) => tool.id));
    const failure = opened.page.getByTestId("tool-failure-summary");
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("5 项未完成");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FAILURE_SUMMARY_DONE");
    await expect(opened.page.getByTestId("live-tool-viewport")).toHaveCount(0);
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveCount(1);
    await expect(opened.page.getByTestId("tool-failure-summary")).toHaveCount(1);
    await expect(opened.page.getByTestId("tool-failure-summary")).toContainText("5 项未完成");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("animates tool turnover and honors reduced motion", async () => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const provider = await startProvider([
      assistantResponse({ tool_calls: [infoCall("motion-0"), infoCall("motion-1"), infoCall("motion-2")] }),
      delayedResponse(assistantResponse({ tool_calls: [infoCall("motion-3")] }), 1_000),
      delayedResponse(textResponse("MOTION_DONE"), 1_500), textResponse("动画测试"),
    ]);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      const options = await configure(opened.context, opened.page, provider.baseURL);
      await options.close();
      await opened.page.emulateMedia({ reducedMotion });
      await opened.page.evaluate(() => {
        const samples: { id: string | null; hidden: boolean; transform: string }[] = [];
        (window as any).__toolAnimationSamples = samples;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args: Parameters<typeof animate>) {
          const result = animate.apply(this, args);
          if (this.closest('[data-testid="live-tool-viewport"]')) {
            const element = this;
            const sample = { id: element.getAttribute("data-tool-id"), hidden: element.getAttribute("aria-hidden") === "true", transform: "" };
            samples.push(sample);
            requestAnimationFrame(() => requestAnimationFrame(() => { sample.transform = getComputedStyle(element).transform; }));
          }
          return result;
        };
      });
      await opened.page.getByTestId("composer-input").fill("run four tools in sequence");
      await opened.page.getByTestId("composer-input").press("Enter");
      const viewport = opened.page.getByTestId("live-tool-viewport");
      await expect(viewport.locator('[data-tool-id="motion-0"]')).toBeVisible();
      await expect(viewport.locator('[data-tool-id="motion-3"]')).toBeVisible();
      if (reducedMotion === "no-preference") {
        await expect.poll(() => opened.page.evaluate(() => (window as any).__toolAnimationSamples.some((sample: any) => sample.id === "motion-0" && sample.hidden && sample.transform && sample.transform !== "none" && sample.transform !== "matrix(1, 0, 0, 1, 0, 0)"))).toBe(true);
        await expect.poll(() => opened.page.evaluate(() => (window as any).__toolAnimationSamples.some((sample: any) => sample.id === "motion-3" && !sample.hidden && sample.transform && sample.transform !== "none" && sample.transform !== "matrix(1, 0, 0, 1, 0, 0)"))).toBe(true);
      } else {
        expect(await opened.page.evaluate(() => (window as any).__toolAnimationSamples)).toEqual([]);
      }
      await expect(opened.page.locator(".markdown-body").last()).toContainText("MOTION_DONE");
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  }
});

test("keeps completed tools visible while waiting for the next provider response", async () => {
  const provider = await startProvider([
    commandResponse("get_page_info", {}, "call-chrome-e2e"), delayedResponse(textResponse("FINAL_AFTER_WAIT"), 2_500), textResponse("等待回复"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run then reply");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("live-tool-calls").locator(".activity")).toHaveText(completedInfo);
    const waiting = opened.page.getByTestId("waiting-status");
    await expect(waiting).toContainText("正在等待推理提供商响应");
    const before = await waiting.innerText();
    await expect.poll(() => waiting.innerText()).not.toBe(before);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_AFTER_WAIT");
    await expect(waiting).toHaveCount(0);
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveText(completedInfo);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

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
      expect(await options.locator('[data-slot="input"]').first().evaluate((input) => getComputedStyle(input).fontSize)).toBe("14px");
      await options.getByRole("tab", { name: "数据管理" }).click();
      await expectThemeButton(options.getByTestId("event-log-clear"), colorScheme, "destructive");
      await options.getByRole("tab", { name: "模型与连接" }).click();
      await options.getByLabel("Provider", { exact: true }).click();
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


test("summarizes adjacent commands in one non-expandable line", async () => {
  const provider = await startProvider([assistantResponse({ tool_calls: [infoCall("call-queued-0"), infoCall("call-queued-1")] }), textResponse("完成")], 500);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run two commands");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("完成");
    const summary = opened.page.getByTestId("tool-group-summary");
    await expect(summary).toHaveCount(1);
    await expect(summary).toHaveText(completedInfo);
    await expect(summary.locator("summary, button")).toHaveCount(0);
    await expect(opened.page.getByTestId("live-tool-calls")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("keeps text between tool groups in its chronological position", async () => {
  const provider = await startProvider([
    commandResponse("get_page_info", {}, "call-before-text"),
    assistantResponse({ content: "BETWEEN_PROCESS_GROUPS", tool_calls: [infoCall("call-after-text")] }),
    delayedResponse(textResponse("FINAL_AFTER_GROUPS"), 1_500), textResponse("分段过程记录"), textResponse("REGENERATED_TURN"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("split process records around text");
    await opened.page.getByTestId("composer-input").press("Enter");
    const turn = opened.page.locator(".conversation-turn").last();
    await expect(turn.locator(".markdown-body", { hasText: "BETWEEN_PROCESS_GROUPS" })).toBeVisible();
    await expect(turn.getByRole("button", { name: "重新生成回复" })).toHaveCount(0);
    await expect(turn.getByRole("button", { name: "复制消息" })).toHaveCount(0);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_AFTER_GROUPS");
    const summaries = opened.page.getByTestId("tool-group-summary");
    await expect(summaries).toHaveCount(2);
    await expect(summaries.nth(0)).toHaveText(completedInfo);
    await expect(summaries.nth(1)).toHaveText(completedInfo);
    const ordered = await opened.page.locator('.conversation-turn').last().evaluate((turn) => {
      const nodes = [...turn.querySelectorAll('[data-testid="tool-group-summary"], .markdown-body')];
      return nodes.map((node) => node.textContent ?? "");
    });
    const between = ordered.findIndex((value) => value.includes("BETWEEN_PROCESS_GROUPS"));
    const groups = ordered.flatMap((value, index) => value.includes("查看页面信息") ? [index] : []);
    const final = ordered.findIndex((value) => value.includes("FINAL_AFTER_GROUPS"));
    expect(groups[0]).toBeLessThan(between);
    expect(between).toBeLessThan(groups[1]!);
    expect(groups[1]).toBeLessThan(final);
    await expect(turn.getByRole("button", { name: "重新生成回复" })).toHaveCount(1);
    const copyButtons = turn.getByRole("button", { name: "复制消息" });
    await expect(copyButtons).toHaveCount(2); // User message and the complete assistant turn.
    await opened.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
    });
    await copyButtons.last().click();
    await expect.poll(() => opened.page.evaluate(() => (window as any).__copied)).toBe("BETWEEN_PROCESS_GROUPS\nFINAL_AFTER_GROUPS");
    const requestCount = provider.requests.length;
    await turn.getByRole("button", { name: "重新生成回复" }).click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REGENERATED_TURN");
    const retry = provider.requests.slice(requestCount).find((request) => request.messages?.at(-1)?.role === "user");
    expect(retry).toBeDefined();
    expect(retry.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("split process records around text"))).toBe(true);
    expect(retry.messages.some((message: any) => message.role === "assistant")).toBe(false);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("groups consecutive reasoning and tool cycles into one bounded activity", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    reasoning_content: `REASONING_${index}`,
    tool_calls: [infoCall(`reasoning-tool-${index}`)],
  }));
  const provider = await startProvider([
    ...calls.map((call) => assistantResponse(call)),
    delayedResponse(textResponse("REASONING_CYCLES_DONE"), 4_000), textResponse("活动测试"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run repeated reasoning and tool cycles");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).filter((event) => event.type === "tool.finished" && String(event.toolCallId).startsWith("reasoning-tool-")).length).toBe(4);
    const turn = opened.page.locator(".conversation-turn").last();
    await expect(turn.getByTestId("reasoning-item")).toHaveCount(1);
    await expect(turn.getByTestId("live-tool-calls")).toHaveCount(1);
    await expect(turn.getByTestId("tool-group-summary")).toHaveCount(0);
    const rows = turn.getByTestId("live-tool-viewport").locator('[data-tool-id]:not([aria-hidden="true"])');
    await expect.poll(() => rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-tool-id")))).toEqual([
      "reasoning-tool-1", "reasoning-tool-2", "reasoning-tool-3",
    ]);
    await expect(turn.locator(".markdown-body", { hasText: "REASONING_CYCLES_DONE" })).toBeVisible();
    await expect(turn.getByTestId("live-tool-calls")).toHaveCount(0);
    await expect(turn.getByTestId("tool-group-summary")).toHaveCount(1);
    await expect(turn.getByTestId("reasoning-item")).toHaveCount(1);
    await turn.getByTestId("reasoning-item").locator("summary").click();
    for (let index = 0; index < 4; index++) {
      await expect(turn.getByTestId("reasoning-item")).toContainText(`REASONING_${index}`);
    }
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("keeps reasoning and live tool activity in order", async () => {
  const provider = await startProvider([
    assistantResponse({ content: "PROGRESS_BEFORE_ACTIVITIES", reasoning_content: "PLAN", tool_calls: [
      infoCall("call-queued-0"), infoCall("call-queued-1"),
    ] }), delayedResponse(textResponse("NEXT_PROGRESS_TEXT"), 2_500), textResponse("活动顺序测试"),
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
    await expect(opened.page.getByTestId("reasoning-item")).toHaveCount(1);
    const calls = opened.page.getByTestId("live-tool-calls").locator(".activity");
    await expect(calls).toHaveCount(2);
    await expect(calls.first()).toHaveText(completedInfo);
    await expect(calls.last()).toHaveText(completedInfo);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEXT_PROGRESS_TEXT");
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveCount(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("ends activity when the model request fails", async () => {
  const provider = await startProvider([commandResponse("get_page_info", {}, "call-chrome-e2e"), { status: 400, error: "fatal request" }]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run then fail");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveText(completedInfo);
    await expect(opened.page.getByTestId("live-tool-calls")).toHaveCount(0);
    await expect(opened.page.getByTestId("waiting-status")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("restores the chronological timeline and wall-clock group duration", async () => {
  const provider = await startProvider([
    assistantResponse({ content: "PROGRESS_TEXT", tool_calls: [{ id: "call-chrome-e2e", type: "function", function: { name: "verify_state", arguments: JSON.stringify({ target: { by: "css", value: "body" }, state: "hidden", timeoutMs: 300 }) } }] }),
    textResponse("FINAL_REPLY"), textResponse("工作摘要标题"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("do the work");
    await opened.page.getByTestId("composer-input").press("Enter");
    const summary = opened.page.getByTestId("tool-group-summary");
    await expect(summary).toHaveText(/^检查页面状态 · \d+\.\d{2} 秒$/);
    await expect(opened.page.locator('.markdown-body', { hasText: "PROGRESS_TEXT" })).toHaveCount(1);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_REPLY");
    const events = await readEvents(opened.page);
    const started = events.find((event) => event.type === "tool.started" && event.toolCallId === "call-chrome-e2e");
    const ended = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-chrome-e2e");
    const elapsed = (Math.max(0, Date.parse(ended.timestamp) - Date.parse(started.timestamp)) / 1000).toFixed(2);
    await expect(summary).toHaveText(`检查页面状态 · ${elapsed} 秒`);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "工作摘要标题" }).locator(".conversation-select").click();
    await expect(opened.page.getByTestId("tool-group-summary")).toHaveText(`检查页面状态 · ${elapsed} 秒`);
    await expect(opened.page.locator('.markdown-body', { hasText: "PROGRESS_TEXT" })).toHaveCount(1);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_REPLY");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("executes complete tool arguments once they arrive", async () => {
  const provider = await startProvider([commandResponse("verify_state", { target: { by: "css", value: "body" }, state: "hidden", timeoutMs: 800 }, "call-phase"), delayedResponse(textResponse("PHASE_DONE"), 1_000)]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run one complete command");
    await opened.page.getByTestId("composer-input").press("Enter");
    const label = opened.page.getByTestId("live-tool-calls").locator(".activity > span");
    await expect(label).toHaveText(/^检查页面状态(?: · \d+\.\d{2} 秒)?$/);
    await expect(label).toHaveText(/^检查页面状态 · \d+\.\d{2} 秒$/);
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
    expect(await tableScroll.evaluate((scroll) => getComputedStyle(scroll).outlineStyle)).toBe("none");
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
    })).toEqual({ background: "rgba(0, 0, 0, 0)", paragraphGap: 12, lineHeight: "19.5px" });
    await opened.page.getByTestId("thread-viewport").evaluate((viewport) => { viewport.scrollTop = 0; });
    await expect(composer).toBeInViewport();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("follows the bottom through layout changes while respecting manual scrolling", async () => {
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
    await opened.page.mouse.wheel(0, 500);
    await opened.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await opened.page.setViewportSize({ width: 430, height: 650 });
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await viewport.focus();
    await viewport.press("ArrowDown");
    await opened.page.setViewportSize({ width: 430, height: 550 });
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    // Reflow and virtual-item measurements can move offsets independently of
    // user intent. Following must survive each new layout, not just one resize.
    for (const size of [{ width: 600, height: 700 }, { width: 380, height: 500 }, { width: 430, height: 550 }]) {
      await opened.page.setViewportSize(size);
      await expect.poll(remaining).toBeLessThanOrEqual(1);
    }
    const growLastTurn = async () => {
      const turn = viewport.locator(".conversation-turn");
      await expect(turn).toHaveCount(1);
      // Following the current bottom can finish before the virtualizer's next
      // measurement catches up with a width reflow. Establish the growth
      // baseline only after its single-turn spacer matches the actual layout.
      await expect.poll(() => turn.evaluate((element) => {
        const spacer = element.parentElement;
        if (!spacer) throw new Error("virtual turn has no spacer");
        return Math.abs(spacer.getBoundingClientRect().height - element.getBoundingClientRect().height);
      })).toBeLessThanOrEqual(1);
      const height = await viewport.evaluate((element) => {
        const turn = element.querySelector(".conversation-turn");
        if (!turn) throw new Error("virtual turn is missing");
        const height = element.scrollHeight;
        const extra = document.createElement("div");
        extra.style.height = "400px";
        turn.append(extra);
        return height;
      });
      await expect.poll(() => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(height + 350);
    };
    await growLastTurn();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await opened.page.mouse.wheel(0, -1_200);
    await expect.poll(remaining).toBeGreaterThan(500);
    const position = await viewport.evaluate((element) => element.scrollTop);
    await opened.page.setViewportSize({ width: 430, height: 650 });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(position);
    await growLastTurn();
    await expect.poll(remaining).toBeGreaterThan(500);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(position);

    const jump = opened.page.getByRole("button", { name: "滚动到底部" });
    await expect(jump).toBeVisible();
    await expect(jump).toBeEnabled();
    await jump.click();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_SCROLL_MARKER");
    await growLastTurn();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
