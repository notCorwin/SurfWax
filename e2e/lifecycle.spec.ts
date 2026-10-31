import { chromium, expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { test, p95, textResponse, assistantResponse, delayedResponse, toolResponse, pageResponse, commandResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, nativePanel, openNativeSidePanel, submitNative, readNativeEvents, type MockResponse } from './fixtures';

function nativeAssistantText(panel: Awaited<ReturnType<typeof attachTarget>>) {
  return panel.evaluate<string>(`Array.from(document.querySelectorAll('[data-role="assistant"]'))
    .map(element => element.textContent || '').join('\\n')`);
}

test("opens the real side panel through the extension action", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const browserSession = await opened.context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }, { exclude: true }],
    });
    const tab = targetInfos.find((info) => info.type === "tab" && info.url === target.url());
    expect(tab).toBeDefined();
    try { await browserSession.send("Extensions.triggerAction", { id: opened.extensionId, targetId: tab!.targetId }); }
    catch (error) {
      test.skip(/Extensions\.triggerAction.*(?:wasn't found|not found)|method not found/i.test(String(error)),
        'Chrome 138 lacks the CDP Extensions.triggerAction command; native panel API opening is covered by the lifecycle tests.');
      throw error;
    }
    await expect.poll(async () => (await browserSession.send("Target.getTargets")).targetInfos
      .some((info) => info.url.split(/[?#]/, 1)[0] === `chrome-extension://${opened.extensionId}/sidepanel.html`)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("uses a large observation from the real side panel before acting on its ref", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let panel: Awaited<ReturnType<typeof attachTarget>> | undefined;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<button id="exact">Run exact action</button>';
      document.querySelector("#exact")!.addEventListener("click", () => { document.body.dataset.clicked = "yes"; });
      for (let index = 0; index < 350; index += 1) {
        const button = document.createElement("button");
        button.textContent = `Filler action ${String(index).padStart(3, "0")} with a deliberately long accessible name`;
        document.body.append(button);
      }
    });
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/target`);
    expect(tab?.id).toBeDefined();

    responses.push(
      commandResponse("inspect_page", { budget: 100000 }, "call-large-observe"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const ref = JSON.parse(message.content).$ref;
        return commandResponse("execute_program", { code: `return await artifacts.read(${JSON.stringify(ref)}, {path:["items"],offset:0,limit:5});` }, "call-read-snapshot");
      },
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const items = JSON.parse(message.content).result;
        const ref = items.find((item: any) => item.line.includes('button "Run exact action"'))?.ref;
        if (!ref) throw new Error("The selected snapshot did not contain the target ref");
        return commandResponse("execute_program", { code: `await page.ref(${JSON.stringify(ref)}).click(); await page.locator('body[data-clicked=yes]').waitFor({state:'attached'});` }, "call-act-from-ref");
      },
      textResponse("REAL_SIDE_PANEL_OK"),
      textResponse("真实侧边栏"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    panel = (await nativePanel(opened, target.url(), { target })).panel;
    await panel.evaluate(`(async () => {
      const input = document.querySelector('[data-testid=composer-input]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'observe the large page and use its exact ref');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      input.closest('form').requestSubmit();
    })()`);
    await expect.poll(() => panel!.evaluate<string>('Array.from(document.querySelectorAll(".markdown-body")).at(-1)?.textContent || ""'), { timeout: 45_000 }).toContain("REAL_SIDE_PANEL_OK");
    await expect.poll(() => target.locator("body").getAttribute("data-clicked")).toBe("yes");

    const events = await panel.evaluate<any[]>(`new Promise((resolve, reject) => {
      const request = indexedDB.open('side-agent-runtime');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const all = request.result.transaction('events', 'readonly').objectStore('events').getAll();
        all.onerror = () => reject(all.error); all.onsuccess = () => resolve(all.result);
      };
    })`);
    const data = events.filter((event) => event.type === "tool.result.data");
    expect(data).toHaveLength(1);
    expect(data[0].output.items.length).toBeGreaterThan(100);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-large-observe")?.output).toMatchObject({ $ref: data[0].id });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-read-snapshot")?.output.result).toEqual(expect.arrayContaining([expect.objectContaining({ line: expect.stringContaining('button "Run exact action"'), ref: expect.any(String) })]));
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-act-from-ref")?.output).toMatchObject({ ok: true });
  } finally {
    await panel?.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("executes a completed DSML scrolling program in the side panel", async () => {
  const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="execute_program"><｜DSML｜ parameter name="code" string="true">await page.mouse.wheel(0,600);</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
  const provider = await startProvider([
    textResponse(dsml),
    textResponse("SCROLL_OK"),
    textResponse("滚动测试"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/scroll-target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("scroll the page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCROLL_OK");
    await expect.poll(() => target.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(opened.page.locator('[data-role="assistant"]').last()).not.toContainText("DSML");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "execute_program")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("executes a completed DSML page evaluation program in the side panel", async () => {
  const func = "() => { const txt = document.body.innerText.replace(/\\s+/g,' '); const idx = txt.indexOf('知识点掌握度'); return JSON.stringify({around: txt.slice(idx, idx+500)}); }";
  const dsml = `\n\n<｜DSML｜ calls><｜DSML｜ invoke name="execute_program"><｜DSML｜ parameter name="code" string="true">return await page.evaluate(${JSON.stringify(func)});</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`;
  const provider = await startProvider([
    textResponse(dsml),
    textResponse("EVAL_OK"),
    textResponse("读取页面"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => { document.body.textContent = "知识点掌握度 72%"; });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("read the knowledge score");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EVAL_OK");
    await expect(opened.page.locator('[data-role="assistant"]').last()).not.toContainText("DSML");
    const events = await readEvents(opened.page);
    const terminal = events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "execute_program");
    expect(terminal).toHaveLength(1);
    expect(JSON.parse(terminal[0].output.result)).toEqual({ around: "知识点掌握度 72%" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps the page guard visibly breathing despite website animation overrides", async () => {
  const provider = await startProvider([toolResponse("await new Promise(() => undefined);")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.emulateMedia({ reducedMotion: "no-preference" });
    await target.evaluate(() => {
      document.body.style.cssText = "margin:0;background:white";
      document.body.replaceChildren();
      const style = document.createElement("style");
      style.textContent = "div::before, div::after { content: none !important; animation: none !important; background: transparent !important; border: 0 !important; }";
      document.head.append(style);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("keep the page guarded");
    await opened.page.getByTestId("composer-input").press("Enter");
    const guard = target.locator("#__surf-wax-page-guard");
    await expect(guard).toBeAttached();

    // Sample rendered pixels in a blank area, rather than merely checking that
    // an animation declaration exists. The page's own CSS must not hide it.
    const sample = async () => {
      const screenshot = await target.screenshot({ clip: { x: 300, y: 300, width: 1, height: 1 } });
      return target.evaluate(async (data) => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, 1, 1).data[0]!;
      }, screenshot.toString("base64"));
    };
    const pixels: number[] = [];
    for (let index = 0; index < 12; index++) {
      pixels.push(await sample());
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(Math.max(...pixels) - Math.min(...pixels)).toBeGreaterThan(20);
    expect(Math.min(...pixels)).toBeGreaterThan(180);

    await target.emulateMedia({ reducedMotion: "reduce" });
    const resting = await sample();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Math.abs(await sample() - resting)).toBeLessThanOrEqual(1);
    expect(resting).toBeLessThan(250);
    await opened.page.close();
    await expect(guard).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("blocks page clicks while the agent runs and removes the guard after navigation and panel close", async () => {
  const responses: MockResponse[] = [
    toolResponse("await new Promise((resolve) => setTimeout(resolve, 2500)); return true;"),
    textResponse("GUARD_DONE"),
    textResponse("点击防护"),
  ];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("test page guard");
    await opened.page.getByTestId("composer-input").press("Enter");
    const guard = target.locator("#__surf-wax-page-guard");
    await expect(guard).toBeAttached();
    expect(await guard.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    await target.goto(`${provider.origin}/complex-next`);
    await expect(guard).toBeAttached();
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "page action";
      button.style.cssText = "position:fixed;left:20px;top:20px;width:120px;height:40px";
      button.onclick = () => { document.documentElement.dataset.clicks = String(Number(document.documentElement.dataset.clicks || 0) + 1); };
      document.body.append(button);
    });
    await target.mouse.click(40, 40);
    expect(await target.evaluate(() => document.documentElement.dataset.clicks)).toBeUndefined();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("GUARD_DONE");
    await expect(guard).toHaveCount(0);
    await target.mouse.click(40, 40);
    expect(await target.evaluate(() => document.documentElement.dataset.clicks)).toBe("1");

    responses.push(toolResponse("await new Promise(() => undefined);"));
    await opened.page.getByTestId("composer-input").fill("run until panel closes");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(guard).toBeAttached();
    await opened.page.close();
    await expect(guard).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("closing the panel cancels a pending complete response and continues only on request", async () => {
  const provider = await startProvider([delayedResponse(textResponse("CANCELLED_RESPONSE"), 30_000), textResponse("CONTINUED"), textResponse("恢复后的标题")]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("cancel the pending reply");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => provider.requests.length).toBe(1);
    await opened.page.close();
    await expect.poll(() => provider.stats.abortedResponses).toBe(1);

    const resumed = await opened.context.newPage();
    await resumed.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect(resumed.getByTestId("conversation-menu")).toContainText("新对话");
    await resumed.getByTestId("conversation-menu").click();
    await resumed.locator(".conversation-item").first().locator(".conversation-select").click();
    await expect(resumed.getByTestId("interrupted-message")).toBeVisible();
    await expect(resumed.getByTestId("live-tool-calls")).toHaveCount(0);
    expect(JSON.stringify(await readEvents(resumed))).not.toContain("CANCELLED_RESPONSE");
    await resumed.getByTestId("continue-interrupted").click();
    await expect(resumed.locator('[data-role="user"]').last()).toContainText("继续上一次被中断的工作");
    await expect(resumed.locator(".markdown-body").last()).toContainText("CONTINUED");
    await expect(resumed.getByTestId("conversation-menu")).toContainText("恢复后的标题");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("closing the panel prevents a queued chrome call from starting", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  responses.push(queuedToolResponse(
    "await new Promise((resolve) => setTimeout(resolve, 60_000)); return true;",
    "await page.evaluate(() => { document.documentElement.dataset.queuedToolRan = 'yes'; }); return true;",
  ));
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(targetUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("queue two calls");
    await opened.page.getByTestId("composer-input").press("Enter");
    const process = opened.page.getByTestId("live-tool-calls");
    await expect(process).toHaveCount(1);
    await expect(process.locator(".activity[data-status]")).toHaveCount(2);
    await expect(process.locator(".activity > summary").last()).toContainText("执行浏览器操作");
    const runningLabel = process.locator(".activity > summary span").last();
    await expect(runningLabel).toHaveClass(/shimmer/);
    await expect.poll(() => runningLabel.evaluate((label) => getComputedStyle(label, "::before").animationPlayState)).toBe("running");
    await opened.page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => runningLabel.evaluate((label) => getComputedStyle(label, "::before").animationPlayState)).toBe("running");
    await opened.page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect.poll(() => runningLabel.evaluate((label) => getComputedStyle(label, "::before").animationPlayState)).toBe("paused");
    await opened.page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await expect.poll(() => runningLabel.evaluate((label) => getComputedStyle(label, "::before").animationPlayState)).toBe("running");
    await expect(target.locator("#__surf-wax-page-guard")).toBeAttached();
    await opened.page.close();
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    await expect.poll(() => target.evaluate(() => document.documentElement.dataset.queuedToolRan)).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("guards every touched tab while CDP pointer input still reaches the page", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  const otherUrl = `${provider.origin}/complex-next`;
  const opened = await openExtension();
  try {
    const first = await opened.context.newPage();
    await first.goto(targetUrl);
    const second = await opened.context.newPage();
    await second.goto(otherUrl);
    const tabs = await opened.page.evaluate(async () => await chrome.tabs.query({ currentWindow: true }));
    const urls = tabs.map(tab => tab.url);
    const firstIndex = urls.indexOf(targetUrl);
    const secondIndex = urls.indexOf(otherUrl);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    responses.push(
      commandResponse("execute_program", { code: `return await browser.tabs.select(${tabs[firstIndex]!.id});` }, "call-select-first"),
      commandResponse("inspect_page", {}, "call-snapshot-first"),
      commandResponse("execute_program", { code: `return await browser.tabs.select(${tabs[secondIndex]!.id});` }, "call-select-second"),
      commandResponse("execute_program", { code: `return await (page.evaluate(\`() => {
        const button = document.createElement('button');
        button.textContent = 'CDP target';
        button.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:40px';
        button.onclick = () => { document.documentElement.dataset.cdpClicks = String(Number(document.documentElement.dataset.cdpClicks || 0) + 1); };
        document.body.append(button);
      }\`));` }, "call-create-target"),
      commandResponse("execute_program", { code: `return await page.getByRole('button', { name: 'CDP target' }).click();` }, "call-click-target"),
      commandResponse("execute_program", { code: ` await new Promise((resolve) => setTimeout(resolve, 1200)); return page.url(); ` }, "call-guard-wait"),
      textResponse("MULTI_GUARD_OK"),
      textResponse("页面防护"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await first.bringToFront();
    await opened.page.getByTestId("composer-input").fill("operate on another tab");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(first.locator("#__surf-wax-page-guard")).toBeAttached();
    await expect(second.locator("#__surf-wax-page-guard")).toBeAttached();
    await expect.poll(() => second.evaluate(() => document.documentElement.dataset.cdpClicks)).toBe("1");
    await second.mouse.click(40, 40);
    expect(await second.evaluate(() => document.documentElement.dataset.cdpClicks)).toBe("1");
    await second.goto(otherUrl);
    await expect(second.locator("#__surf-wax-page-guard")).toBeAttached();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MULTI_GUARD_OK");
    await expect(first.locator("#__surf-wax-page-guard")).toHaveCount(0);
    await expect(second.locator("#__surf-wax-page-guard")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows a warning for a Chrome page that cannot be guarded without stopping the agent", async () => {
  const provider = await startProvider([
    toolResponse("return chrome.runtime.getManifest().name;"), textResponse("CHROME_PAGE_OK"), textResponse("防护提示"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const restricted = await opened.context.newPage();
    await restricted.goto("chrome://extensions/");
    await restricted.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect Chrome");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByRole("status").filter({ hasText: "无法启用防点击保护" })).toBeVisible();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHROME_PAGE_OK");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps the composer usable when a long data URL cannot be guarded", async () => {
  const provider = await startProvider([textResponse("DATA_PAGE_OK"), textResponse("数据页")]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const dataPage = await opened.context.newPage();
    await dataPage.goto(`data:text/html,${encodeURIComponent(`<title>学生成绩表示例表格</title><p>${"成绩".repeat(2000)}</p>`)}`);
    await dataPage.bringToFront();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("inspect data page");
    await composer.press("Enter");
    const warning = opened.page.getByRole("status").filter({ hasText: "无法启用防点击保护" });
    await expect(warning).toHaveText(/标签页 \d+ 无法启用防点击保护；智能体仍可继续运行。/);
    expect((await warning.textContent())!.length).toBeLessThan(80);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DATA_PAGE_OK");
    await expect(composer).toBeVisible();
    expect(await composer.evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});



test('closing a native Side Panel aborts its owner and prevents a queued page mutation', async () => {
  const calls = [
    { name: 'execute_program', input: { code: "await page.getByLabel('Never exists').fill('waiting');", timeoutMs: 300_000 } },
    { name: 'execute_program', input: { code: "return await page.evaluate(() => { document.documentElement.dataset.queuedNativeRan = 'yes'; return true; });" } },
  ];
  const provider = await startProvider([assistantResponse({ tool_calls: calls.map((call, index) => ({ id: `native-queue-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) })]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, 'perform two queued actions');
    await expect(native.target.locator('#__surf-wax-page-guard')).toBeAttached();
    await expect.poll(() => native.panel.evaluate<boolean>('document.body.textContent.includes("执行浏览器操作")')).toBe(true);
    await expect.poll(async () => (await readNativeEvents(native.panel)).filter(event => event.type === 'tool.started' && event.toolCallId?.startsWith('native-queue-')).length).toBe(2);
    await native.panel.close();
    expect((await native.browser.send('Target.closeTarget', { targetId: native.targetId })).success).toBe(true);
    await expect(native.target.locator('#__surf-wax-page-guard')).toHaveCount(0);
    await expect.poll(() => native.target.evaluate(() => document.documentElement.dataset.queuedNativeRan)).toBeUndefined();
    const recovery = await opened.context.newPage();
    await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect.poll(async () => (await readEvents(recovery)).filter(event => event.type === 'tool.failed' && event.toolCallId?.startsWith('native-queue-')).length).toBe(2);
    expect(provider.requests).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('a native run stays in its owning window after another window becomes focused', async () => {
  const provider = await startProvider([
    commandResponse("inspect_page", {}, 'native-first-snapshot'),
    delayedResponse(commandResponse('execute_program', { code: "await page.getByLabel('Email').fill('owner@example.com'); await page.getByRole('button',{name:'Sign in'}).click();" }, 'native-owner-act'), 1_000),
    textResponse('OWNER_WINDOW_DONE'), textResponse('窗口绑定'),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/automation`);
    await submitNative(native.panel, 'complete the form in this window');
    await expect.poll(() => provider.requests.length).toBeGreaterThanOrEqual(2);
    const other = await native.panel.evaluate<{ id: number }>(`chrome.windows.create({ url: ${JSON.stringify(`${provider.origin}/automation?other-window`)}, focused: true })`);
    await expect(native.target.locator('output')).toHaveText('Welcome owner@example.com');
    const otherTabs = await native.panel.evaluate<Array<{ id: number }>>(`chrome.tabs.query({ windowId: ${other.id} })`);
    expect(otherTabs).toHaveLength(1);
    await expect.poll(() => native.panel.evaluate<string | null>(`chrome.scripting.executeScript({target:{tabId:${otherTabs[0]!.id}},func:()=>document.querySelector('output')?.textContent ?? null}).then(results=>results[0]?.result ?? null)`)).toBe('');
    await native.panel.evaluate(`chrome.windows.remove(${other.id})`);
    await native.panel.close();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('a recoverable complete-response failure retries without repeating a completed browser effect', async () => {
  const effectId = 'retry-effect-once';
  const provider = await startProvider([
    toolResponse("return await page.evaluate(() => { const root = document.documentElement; root.dataset.retryEffects = String(Number(root.dataset.retryEffects || 0) + 1); return { marker: 'RETRY_EFFECT_ACCEPTED', count: Number(root.dataset.retryEffects) }; });", effectId),
    { status: 503, error: 'temporary full-response failure' },
    textResponse('RETRY_RESPONSE_COMPLETE'), textResponse('恢复请求'),
  ]);
  const opened = await openExtension();
  let native: Awaited<ReturnType<typeof nativePanel>> | undefined;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, 'record one browser effect and retry a temporary full-response failure');
    await expect.poll(() => nativeAssistantText(native!.panel)).toContain('RETRY_RESPONSE_COMPLETE');
    await expect(native.target.locator('html')).toHaveAttribute('data-retry-effects', '1');
    const agentRequests = provider.requests.filter(request => request.tools?.some((tool: any) => tool.function.name === "execute_program"));
    expect(agentRequests).toHaveLength(3);
    expect(agentRequests[2].messages).toEqual(agentRequests[1].messages);
    const resumedContext = JSON.stringify(agentRequests[2].messages);
    expect(resumedContext).toContain('RETRY_EFFECT_ACCEPTED');
    expect(agentRequests[2].messages.filter((message: any) => message.role === 'tool' && message.tool_call_id === effectId)).toHaveLength(1);
    await expect.poll(async () => (await readNativeEvents(native!.panel)).filter(event => event.type === 'conversation.finished').length).toBe(1);
    const events = await readNativeEvents(native.panel);
    const started = events.filter(event => event.type === 'tool.started' && event.toolCallId === effectId);
    const terminal = events.filter(event => ['tool.finished', 'tool.failed'].includes(event.type) && event.toolCallId === effectId);
    expect(started).toHaveLength(1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe('tool.finished');
    expect(events.filter(event => event.type === 'request.retry')).toMatchObject([
      { retry: { attempt: 1, status: 503 } },
    ]);
    expect(JSON.stringify(events.filter(event => event.type === 'conversation.message'))).toContain('RETRY_RESPONSE_COMPLETE');
    expect(events.filter(event => ['conversation.failed', 'conversation.aborted'].includes(event.type))).toHaveLength(0);
  } finally {
    await native?.panel.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test('two native side panels accept only one owner and closing the non-owner preserves the active task', async () => {
  let releaseOwner!: () => void;
  const ownerMayFinish = new Promise<void>((resolveOwner) => { releaseOwner = resolveOwner; });
  const provider = await startProvider([
    toolResponse("return await page.evaluate(() => { const root = document.documentElement; root.dataset.ownerEffects = String(Number(root.dataset.ownerEffects || 0) + 1); return { owner: true, count: Number(root.dataset.ownerEffects) }; });", 'native-owner-effect'),
    delayedResponse(textResponse('OWNER_SURVIVED_NONOWNER_CLOSE'), 0, ownerMayFinish),
    textResponse('多窗口互斥'),
  ]);
  const opened = await openExtension();
  let owner: Awaited<ReturnType<typeof nativePanel>> | undefined;
  let other: Awaited<ReturnType<typeof openNativeSidePanel>> | undefined;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    owner = await nativePanel(opened, `${provider.origin}/automation`);
    await submitNative(owner.panel, 'complete only the owning window task');
    await expect(owner.target.locator('html')).toHaveAttribute('data-owner-effects', '1');
    await expect.poll(() => provider.requests.filter(request => request.tools?.some((tool: any) => tool.function.name === "execute_program")).length).toBe(2);
    const active = await owner.panel.evaluate<{ identity: { runId: string } }>(`chrome.runtime.sendMessage({ type: 'surf-wax:run-status' })`);
    expect(active.identity.runId).toBeTruthy();
    const secondWindow = await owner.panel.evaluate<{ id: number }>(`chrome.windows.create({ url: ${JSON.stringify(`${provider.origin}/target`)}, focused: true })`);
    other = await openNativeSidePanel(opened, `${provider.origin}/target`, { browser: owner.browser, windowId: secondWindow.id });
    await expect.poll(() => other!.panel.evaluate<string>(`document.querySelector('[data-testid="other-run-busy"]')?.textContent || ''`)).toContain('其他窗口已有任务运行');
    await submitNative(other.panel, 'this second task must not replace the owner');
    await expect.poll(() => other!.panel.evaluate<string>(`document.querySelector('[role="alert"]')?.textContent || ''`)).toContain('已有任务运行');
    expect(provider.requests.filter(request => request.tools?.some((tool: any) => tool.function.name === "execute_program"))).toHaveLength(2);
    expect((await readNativeEvents(owner.panel)).filter(event => event.type === 'conversation.submitted')).toHaveLength(1);
    await other.panel.close();
    expect((await owner.browser.send('Target.closeTarget', { targetId: other.targetId })).success).toBe(true);
    await expect.poll(() => owner!.panel.evaluate<string>(`chrome.runtime.sendMessage({ type: 'surf-wax:run-status' }).then(result => result.identity?.runId || '')`)).toBe(active.identity.runId);
    await expect(owner.target.locator('#__surf-wax-page-guard')).toBeAttached();
    expect(provider.stats.abortedResponses).toBe(0);
    // Chrome can suspend animation frames in the unfocused native window.
    // Restore the owner's visible surface before asserting the completed response.
    await owner.panel.evaluate(`chrome.windows.update(${owner.windowId}, { focused: true })`);
    releaseOwner();
    await expect.poll(() => nativeAssistantText(owner!.panel)).toContain('OWNER_SURVIVED_NONOWNER_CLOSE');
    await expect(owner.target.locator('#__surf-wax-page-guard')).toHaveCount(0);
    const events = await readNativeEvents(owner.panel);
    const submitted = events.filter(event => event.type === 'conversation.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].runId).toBe(active.identity.runId);
    expect(events.filter(event => event.runId === active.identity.runId && ['conversation.finished', 'conversation.failed', 'conversation.aborted'].includes(event.type))).toMatchObject([{ type: 'conversation.finished' }]);
    expect(events.filter(event => event.type === 'tool.finished' && event.toolCallId === 'native-owner-effect')).toHaveLength(1);
    await expect(owner.target.locator('html')).toHaveAttribute('data-owner-effects', '1');
  } finally {
    releaseOwner();
    await other?.panel.close();
    await owner?.panel.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
