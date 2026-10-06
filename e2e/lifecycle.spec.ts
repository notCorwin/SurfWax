import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, nativePanel, openNativeSidePanel, submitNative, readNativeEvents, type MockResponse } from './fixtures';

function nativeAssistantText(panel: Awaited<ReturnType<typeof attachTarget>>) {
  return panel.evaluate<string>(`Array.from(document.querySelectorAll('[data-role="assistant"]'))
    .filter(element => !element.closest('[data-testid="work-summary"]'))
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
      commandResponse("inspect", { budget: 100000 }, "call-large-observe"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const ref = JSON.parse(message.content).$ref;
        return commandResponse("run", { code: `return await artifacts.read(${JSON.stringify(ref)}, {path:["snapshot"],offset:0,limit:4000});` }, "call-read-snapshot");
      },
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const snapshot = JSON.parse(message.content).result;
        const ref = /button "Run exact action" \[ref=(t\d+d\d+e\d+)\]/.exec(snapshot)?.[1];
        if (!ref) throw new Error("The selected snapshot did not contain the target ref");
        return commandResponse("run", { code: `await page.ref(${JSON.stringify(ref)}).click(); await page.locator('body[data-clicked=yes]').waitFor({state:'attached'});` }, "call-act-from-ref");
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
    await expect.poll(() => panel!.evaluate<string>('Array.from(document.querySelectorAll(".markdown-body")).at(-1)?.textContent || ""')).toContain("REAL_SIDE_PANEL_OK");
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
    expect(data[0].output.snapshot.length).toBeGreaterThan(9_000);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-large-observe")?.output).toMatchObject({ $ref: data[0].id });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-read-snapshot")?.output.result).toContain('button "Run exact action" [ref=');
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-act-from-ref")?.output).toMatchObject({ ok: true });
  } finally {
    await panel?.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("recovers a streamed DSML scrolling program in the side panel", async () => {
  const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="run"><｜DSML｜ parameter name="code" string="true">await page.mouse.wheel(0,600);</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
  const provider = await startProvider([
    streamingTextResponse([dsml.slice(0, 5), dsml.slice(5, 41), dsml.slice(41)]),
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
    expect(events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "run")).toHaveLength(1);
    expect(events.some((event) => event.type === "model.dsml.recovery" && event.content?.recovered === true)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("recovers a streamed DSML page evaluation program in the side panel", async () => {
  const func = "() => { const txt = document.body.innerText.replace(/\\s+/g,' '); const idx = txt.indexOf('知识点掌握度'); return JSON.stringify({around: txt.slice(idx, idx+500)}); }";
  const dsml = `\n\n<｜DSML｜ calls><｜DSML｜ invoke name="run"><｜DSML｜ parameter name="code" string="true">return await page.evaluate(${JSON.stringify(func)});</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`;
  const provider = await startProvider([
    streamingTextResponse([dsml.slice(0, 4), dsml.slice(4, 39), dsml.slice(39)]),
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
    const terminal = events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "run");
    expect(terminal).toHaveLength(1);
    expect(JSON.parse(terminal[0].output.result)).toEqual({ around: "知识点掌握度 72%" });
    expect(events.some((event) => event.type === "model.dsml.recovery" && event.content?.recovered === true)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("blocks page clicks while the agent runs and removes the guard after navigation and panel close", async () => {
  const responses: string[][] = [
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


test("closing the panel restores the interrupted response and continues only on request", async () => {
  const parts = [chunk({ role: "assistant", content: "STREAM_STARTED" }), ...Array.from({ length: 500 }, () => chunk({ content: "." }))];
  const provider = await startProvider([parts, textResponse("CONTINUED"), textResponse("恢复后的标题")], 20);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("keep streaming");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_STARTED");
    await opened.page.close();
    await expect.poll(() => provider.stats.abortedResponses).toBe(1);

    const resumed = await opened.context.newPage();
    await resumed.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect(resumed.getByTestId("conversation-menu")).toContainText("新对话");
    await resumed.getByTestId("conversation-menu").click();
    await resumed.locator(".conversation-item").first().locator(".conversation-select").click();
    await expect(resumed.getByTestId("interrupted-message")).toBeVisible();
    await expect(resumed.getByTestId("work-summary")).toHaveCount(0);
    await expect(resumed.locator(".markdown-body").last()).toContainText("STREAM_STARTED");
    await resumed.getByTestId("continue-interrupted").click();
    await expect(resumed.locator('[data-role="user"]').last()).toContainText("继续上一次被中断的工作");
    await expect(resumed.locator(".markdown-body").last()).toContainText("CONTINUED");
    await expect(resumed.getByTestId("conversation-menu")).toContainText("恢复后的标题");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("closing the panel prevents a queued chrome call from starting", async () => {
  const responses: string[][] = [];
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
    const process = opened.page.getByTestId("process-trace");
    await expect(process).toHaveCount(1);
    await expect(process.locator(".activity[data-status]")).toHaveCount(2);
    await expect(process.locator(":scope > summary")).toContainText("正在执行命令");
    const runningLabel = process.locator(":scope > summary span");
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
  const responses: string[][] = [];
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
      commandResponse("run", { code: `return await browser.tabs.select(${tabs[firstIndex]!.id});` }, "call-select-first"),
      commandResponse("inspect", {}, "call-snapshot-first"),
      commandResponse("run", { code: `return await browser.tabs.select(${tabs[secondIndex]!.id});` }, "call-select-second"),
      commandResponse("run", { code: `return await (page.evaluate(\`() => {
        const button = document.createElement('button');
        button.textContent = 'CDP target';
        button.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:40px';
        button.onclick = () => { document.documentElement.dataset.cdpClicks = String(Number(document.documentElement.dataset.cdpClicks || 0) + 1); };
        document.body.append(button);
      }\`));` }, "call-create-target"),
      commandResponse("run", { code: `return await page.getByRole('button', { name: 'CDP target' }).click();` }, "call-click-target"),
      commandResponse("run", { code: ` await new Promise((resolve) => setTimeout(resolve, 1200)); return page.url(); ` }, "call-guard-wait"),
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
    { name: 'run', input: { code: "await page.getByLabel('Never exists').fill('waiting');", timeoutMs: 300_000 } },
    { name: 'run', input: { code: "return await page.evaluate(() => { document.documentElement.dataset.queuedNativeRan = 'yes'; return true; });" } },
  ];
  const provider = await startProvider([[chunk({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `native-queue-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) }), chunk({}, 'tool_calls'), 'data: [DONE]\n\n']]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, 'perform two queued actions');
    await expect(native.target.locator('#__surf-wax-page-guard')).toBeAttached();
    await expect.poll(() => native.panel.evaluate<boolean>('document.body.textContent.includes("正在执行命令")')).toBe(true);
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
    commandResponse("inspect", {}, 'native-first-snapshot'),
    { parts: commandResponse('run', { code: "await page.getByLabel('Email').fill('owner@example.com'); await page.getByRole('button',{name:'Sign in'}).click();" }, 'native-owner-act'), delayMs: 1_000 },
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

test('a real SSE disconnect preserves text and completed browser effects while continuing automatically', async () => {
  const effectId = 'sse-effect-once';
  const provider = await startProvider([
    toolResponse("return await page.evaluate(() => { const root = document.documentElement; root.dataset.sseEffects = String(Number(root.dataset.sseEffects || 0) + 1); return { marker: 'SSE_EFFECT_ACCEPTED', count: Number(root.dataset.sseEffects) }; });", effectId),
    { parts: [chunk({ role: 'assistant', content: 'SSE_TEXT_PRESERVED ' }), chunk({ content: 'before disconnect ' })],
      delayMs: 0, partDelayMs: 200, disconnect: true },
    textResponse('SSE_AUTOMATIC_CONTINUATION'), textResponse('断线恢复'),
  ]);
  const opened = await openExtension();
  let native: Awaited<ReturnType<typeof nativePanel>> | undefined;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, 'record one browser effect and continue after a disconnected stream');
    await expect.poll(() => nativeAssistantText(native!.panel)).toContain('SSE_AUTOMATIC_CONTINUATION');
    const assistantText = await nativeAssistantText(native.panel);
    expect(assistantText).toContain('SSE_TEXT_PRESERVED');
    expect(assistantText).toContain('before disconnect');
    await expect(native.target.locator('html')).toHaveAttribute('data-sse-effects', '1');
    expect(provider.stats.disconnectedResponses).toBe(1);
    const agentRequests = provider.requests.filter(request => request.stream === true && request.tools?.length === 3);
    expect(agentRequests).toHaveLength(3);
    const resumedContext = JSON.stringify(agentRequests[2].messages);
    expect(resumedContext).toContain('SSE_TEXT_PRESERVED');
    expect(resumedContext).toContain('SSE_EFFECT_ACCEPTED');
    expect(agentRequests[2].messages.filter((message: any) => message.role === 'tool' && message.tool_call_id === effectId)).toHaveLength(1);
    await expect.poll(async () => (await readNativeEvents(native!.panel)).filter(event => event.type === 'conversation.finished').length).toBe(1);
    const events = await readNativeEvents(native.panel);
    const started = events.filter(event => event.type === 'tool.started' && event.toolCallId === effectId);
    const terminal = events.filter(event => ['tool.finished', 'tool.failed'].includes(event.type) && event.toolCallId === effectId);
    expect(started).toHaveLength(1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe('tool.finished');
    expect(events.filter(event => event.type === 'model.stream.retrying')).toMatchObject([{ retry: { attempt: 1, reason: 'stream-disconnected' } }]);
    expect(JSON.stringify(events.filter(event => event.type === 'conversation.message'))).toContain('SSE_TEXT_PRESERVED');
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
    { parts: textResponse('OWNER_SURVIVED_NONOWNER_CLOSE'), delayMs: 0, startAfter: ownerMayFinish },
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
    await expect.poll(() => provider.requests.filter(request => request.stream === true && request.tools?.length === 3).length).toBe(2);
    const active = await owner.panel.evaluate<{ identity: { runId: string } }>(`chrome.runtime.sendMessage({ type: 'surf-wax:run-status' })`);
    expect(active.identity.runId).toBeTruthy();
    const secondWindow = await owner.panel.evaluate<{ id: number }>(`chrome.windows.create({ url: ${JSON.stringify(`${provider.origin}/target`)}, focused: true })`);
    other = await openNativeSidePanel(opened, `${provider.origin}/target`, { browser: owner.browser, windowId: secondWindow.id });
    await expect.poll(() => other!.panel.evaluate<string>(`document.querySelector('[data-testid="other-run-busy"]')?.textContent || ''`)).toContain('其他窗口已有任务运行');
    await submitNative(other.panel, 'this second task must not replace the owner');
    await expect.poll(() => nativeAssistantText(other!.panel)).toContain('已有任务运行');
    expect(provider.requests.filter(request => request.stream === true && request.tools?.length === 3)).toHaveLength(2);
    expect((await readNativeEvents(owner.panel)).filter(event => event.type === 'conversation.submitted')).toHaveLength(1);
    await other.panel.close();
    expect((await owner.browser.send('Target.closeTarget', { targetId: other.targetId })).success).toBe(true);
    await expect.poll(() => owner!.panel.evaluate<string>(`chrome.runtime.sendMessage({ type: 'surf-wax:run-status' }).then(result => result.identity?.runId || '')`)).toBe(active.identity.runId);
    await expect(owner.target.locator('#__surf-wax-page-guard')).toBeAttached();
    expect(provider.stats.abortedResponses).toBe(0);
    // Chrome can suspend animation frames in the unfocused native window.
    // Restore the owner's visible surface before asserting streamed rendering.
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
