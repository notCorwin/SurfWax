import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, nativePanel, submitNative, readNativeEvents, type MockResponse } from './fixtures';

test("selects large tool output without creating another reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    responses.push(
      toolResponse("return { url: 'https://example.com', snapshot: 'LARGE_START' + 'zx'.repeat(6000) }", "call-large"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const ref = JSON.parse(message.content).$ref;
        return commandResponse("run", { code: `return await artifacts.read(${JSON.stringify(ref)}, {path:["result","snapshot"],offset:0,limit:11});` }, "call-select-large");
      },
      textResponse("DONE_COMPACT"),
      textResponse("引用测试"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("inspect page contexts and a large result");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DONE_COMPACT");
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBeGreaterThanOrEqual(3);
    const requests = provider.requests.filter((request) => request.tools);
    const secondPrompt = JSON.stringify(requests[1].messages);
    expect(secondPrompt).toContain("$ref");
    expect(secondPrompt).not.toContain("zx".repeat(2_100));
    expect(JSON.stringify(requests[2].messages)).toContain("LARGE_START");
    const events = await readEvents(opened.page);
    const data = events.find((event) => event.type === "tool.result.data");
    expect(data.output).toMatchObject({ ok: true, state: "succeeded", result: { url: "https://example.com", snapshot: "LARGE_START" + "zx".repeat(6000) } });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-large")?.output.$ref).toBe(data.id);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-select-large")?.output.result).toBe("LARGE_START");
    expect(events.filter((event) => event.type === "tool.result.data")).toHaveLength(1);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", {hasText:"引用测试"}).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DONE_COMPACT");
    await target.bringToFront();
    responses.push(commandResponse("run", { code: `return await artifacts.read(${data.id}, {path:["result","snapshot"],offset:0,limit:11});` }, "read-after-reload"), textResponse("RESTORED_READ"));
    await opened.page.getByTestId("composer-input").fill("read the stored result in this restored conversation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESTORED_READ");
    expect((await readEvents(opened.page)).find(event => event.type === "tool.finished" && event.toolCallId === "read-after-reload")?.output.result).toBe("LARGE_START");
    expect(await opened.page.evaluate(() => typeof (globalThis as any).__surfWaxResult)).toBe("undefined");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("uses inspect plus composable fill and click programs", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation`);
    expect(tab?.id).toBeDefined();
    responses.push(
      commandResponse("inspect", {}, "call-snapshot"),
      commandResponse("run", { code: `return await page.getByLabel(${JSON.stringify("Email")}).fill(${JSON.stringify("me@example.com")});` }, "call-fill"),
      commandResponse("run", { code: `return await page.getByRole('button', { name: 'Sign in' }).click();` }, "call-click"),
      commandResponse("inspect", {}, "call-verify"),
      textResponse("PAGE_AUTOMATION_OK"),
      textResponse("页面自动化"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const windowCount = await opened.page.evaluate(async () => (await chrome.windows.getAll()).length);
    await opened.page.getByTestId("composer-input").fill("use semantic page automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PAGE_AUTOMATION_OK");
    const events = await readEvents(opened.page);
    const observation = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-snapshot")?.output;
    const verified = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-verify")?.output;
    expect(observation).toMatchObject({ snapshot: expect.stringMatching(/\[ref=t\d+d\d+e\d+/) });
    expect(verified).toMatchObject({ snapshot: expect.stringContaining("Welcome me@example.com") });
    await expect.poll(() => target.locator("output").textContent()).toBe("Welcome me@example.com");
    expect(events.some((event) => event.type === "automation.action.finished" && event.toolCallId === "call-click")).toBe(true);
    expect(provider.requests[0].tools).toHaveLength(3);
    const toolNames = provider.requests[0].tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("browser");
    expect(toolNames.filter((name: string) => ["open", "attach", "close", "detach", "show", "list", "close-all", "kill-all"].includes(name))).toEqual([]);
    expect(await opened.page.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowCount);
    expect(provider.requests.filter((request) => request.tools)).toHaveLength(5);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("moves the trusted pointer before a semantic click and dispatches the click once", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    responses.push(commandResponse("run", { code: `
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Pointer target';
        button.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:40px';
        button.onmousemove = event => { if (event.isTrusted) button.dataset.moved = 'yes'; };
        button.onmousedown = () => { button.dataset.movedBeforePress = button.dataset.moved || 'no'; };
        button.onclick = event => {
          button.dataset.clicks = String(Number(button.dataset.clicks || 0) + 1);
          button.dataset.trustedClick = String(event.isTrusted);
        };
        document.body.append(button);
      });
      await page.getByRole('button', {name:'Pointer target'}).click();
      await check(await page.getByRole('button', {name:'Pointer target'}).getAttribute('data-moved-before-press') === 'yes', 'Pointer must move before press');
      return true;
    ` }, "pointer-before-click"), textResponse("POINTER_OK"), textResponse("原生指针"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.mouse.move(220, 220);
    await opened.page.getByTestId("composer-input").fill("click the semantic target with native pointer input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("POINTER_OK");
    const button = target.getByRole("button", {name:"Pointer target"});
    expect(await button.getAttribute("data-moved-before-press")).toBe("yes");
    expect(await button.getAttribute("data-clicks")).toBe("1");
    expect(await button.getAttribute("data-trusted-click")).toBe("true");
    const events = await readEvents(opened.page);
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "pointer-before-click")?.output).toMatchObject({ok:true,state:"succeeded",result:true});
    expect(events.some(event => event.type === "browser.job.progress" && event.toolCallId === "pointer-before-click" && event.content?.state === "verified")).toBe(true);
    expect(events.filter(event => event.type === "automation.action.finished" && event.content?.operation === "click")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

for (const deviceScaleFactor of [1, 2]) test(`injects a screenshot and clicks its observation coordinates at DPR ${deviceScaleFactor}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { deviceScaleFactor });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/visual`);
    responses.push(
      commandResponse("run", { code: `return await page.screenshot(${JSON.stringify({ type: "jpeg", filename: "internal-visual.jpg" })});` }, "call-visual-observe"),
      (request) => {
        const tool = request.messages.findLast((message: any) => message.role === "tool");
        const result = JSON.parse(tool.content).result;
        const observationId = result.observationId;
        if (!observationId) throw new Error("Visual observation id was not returned to the model");
        return commandResponse("run", { code: `return await page.point(${JSON.stringify(observationId)},${JSON.stringify(50 * result.screenshot.scale)},${JSON.stringify(40 * result.screenshot.scale)},'click');` }, "call-visual-act");
      },
      textResponse("VISUAL_OK"), textResponse("视觉自动化"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByLabel("图片输入能力").click();
    await options.getByRole("option", { name: "支持", exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close();
    await opened.page.getByTestId("composer-input").fill("use visual automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => provider.requests.length).toBeGreaterThanOrEqual(2);
    const events = await readEvents(opened.page);
    const observation = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-visual-observe")?.output.result;
    expect(observation?.screenshot?.mediaType).toBe("image/jpeg");
    expect(observation?.viewport.scale).toBe(deviceScaleFactor);
    const artifact = events.find((event) => event.id === observation.artifact.id)?.output;
    const dimensions = await opened.page.evaluate(async (base64) => {
      const image = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${base64}`)).blob());
      const dimensions = { width: image.width, height: image.height }; image.close(); return dimensions;
    }, artifact.base64);
    expect(observation.screenshot).toMatchObject(dimensions);
    expect(observation.screenshot.scale).toBe(dimensions.width / observation.viewport.width);
    expect(observation?.artifact).toMatchObject({ id: expect.any(Number), filename: "internal-visual.jpg", mimeType: "image/jpeg", byteLength: expect.any(Number), saved: false });
    expect(observation?.artifact).not.toHaveProperty("downloadId");
    expect(observation?.screenshot?.artifactId).toBe(observation?.artifact?.id);
    expect(await opened.page.evaluate(async () => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    expect(JSON.stringify(provider.requests[1])).toContain("image_url");
    expect(observation.observationId).toEqual(expect.any(String));
    await expect.poll(() => target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


for (const suspendedFrames of [false, true]) test(`uses frameLocator inside a cross-origin iframe${suspendedFrames ? " with suspended animation frames" : ""}`, async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    if (suspendedFrames) await target.addInitScript(() => {
      if (window !== window.top) {
        // Chrome may suppress callbacks in an occluded child frame. Exercise
        // that condition while still requiring a real native click below.
        window.requestAnimationFrame = () => 1;
        window.cancelAnimationFrame = () => undefined;
      }
    });
    await target.goto(`${provider.origin}/complex`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/complex`);
    responses.push(
      pageResponse("await page.frameLocator('iframe[src*=localhost]').getByRole('button', {name:'Frame action'}).click(); return 'FRAME_OK';", tab.id!, "call-page-frame"),
      textResponse("FRAME_AUTOMATION_OK"),
      textResponse("跨域框架"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("click inside the cross-origin frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_AUTOMATION_OK", { timeout: 10_000 });
    await expect.poll(() => target.frames().find((frame) => frame.url().includes("localhost"))?.locator("body").getAttribute("data-clicked")).toBe("yes");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-frame")?.output.result).toBe("FRAME_OK");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("re-resolves replaced nodes and uses browser semantics through open shadow DOM", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation-dynamic`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation-dynamic`);
    responses.push(
      pageResponse(`
const action = page.getByRole('button', {name:'Delayed action'});
for (let index = 0; index < 50; index += 1) await action.click();
await page.getByText('50', {exact:true}).waitFor({state:'visible'});
await page.getByRole('button', {name:'Shadow action'}).click();
return {count: await page.getByText('50', {exact:true}).innerText(), shadow: await page.locator('shadow-action').getAttribute('data-clicked')};
`, tab.id!, "call-page-dynamic"),
      textResponse("DYNAMIC_AUTOMATION_OK"),
      textResponse("动态页面自动化"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("exercise dynamic semantic automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("50", { timeout: 30_000 });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_AUTOMATION_OK", { timeout: 30_000 });
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-dynamic")?.output.result).toEqual({ count: "50", shadow: "yes" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("returns a tool result for a removed command and lets the agent recover", async () => {
  const provider = await startProvider([
    commandResponse("install", {}, "call-unsupported"),
    textResponse("RECOVERED_AFTER_DEBUGGER_ERROR"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("recover from an unsupported extension command");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RECOVERED_AFTER_DEBUGGER_ERROR");
    const activity = opened.page.getByTestId("process-trace");
    await expect(activity.locator(":scope > summary span")).toHaveText("1 次命令中有失败");
    await expect(activity).toHaveAttribute("data-status", "error");
    await expect(opened.page.locator(".process-trace[data-status=running]")).toHaveCount(0);
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBe(2);
    const events = await readEvents(opened.page);
    expect(JSON.stringify(events.find((event) => event.type === "tool.failed" && event.toolCallId === "call-unsupported")?.error))
      .toContain("install");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("binds each turn to the active tab and supplies all current-window tab metadata", async () => {
  const provider = await startProvider([
    commandResponse("run", { code: `return await (page.evaluate("() => { document.documentElement.dataset.contextTurn = 'first'; return true; }"));` }, "call-context-first"),
    textResponse("FIRST_CONTEXT_DONE"),
    textResponse("标签页上下文"),
    commandResponse("run", { code: `return await (page.evaluate("() => { document.documentElement.dataset.contextTurn = 'second'; return true; }"));` }, "call-context-second"),
    textResponse("SECOND_CONTEXT_DONE"),
  ]);
  const opened = await openExtension();
  try {
    const firstUrl = `${provider.origin}/target`;
    const secondUrl = `${provider.origin}/complex-next`;
    const first = await opened.context.newPage();
    await first.goto(firstUrl);
    const second = await opened.context.newPage();
    await second.goto(secondUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const windowCount = await opened.page.evaluate(async () => (await chrome.windows.getAll()).length);
    const composer = opened.page.getByTestId("composer-input");

    await first.bringToFront();
    await composer.fill("use the first active tab");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_CONTEXT_DONE");
    await expect.poll(() => first.evaluate(() => document.documentElement.dataset.contextTurn)).toBe("first");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("标签页上下文");

    await second.bringToFront();
    await composer.fill("now use the second active tab");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_CONTEXT_DONE");
    await expect.poll(() => second.evaluate(() => document.documentElement.dataset.contextTurn)).toBe("second");

    const agentRequests = provider.requests.filter((request) => request.tools);
    const firstRequest = agentRequests.find((request) => JSON.stringify(request.messages).includes("use the first active tab"));
    const secondRequest = [...agentRequests].reverse().find((request: any) => JSON.stringify(request.messages).includes("now use the second active tab"));
    const firstPrompt = JSON.stringify(firstRequest?.messages);
    const secondPrompt = JSON.stringify(secondRequest?.messages);
    for (const prompt of [firstPrompt, secondPrompt]) {
      expect(prompt).toContain("<browser-context>");
      expect(prompt).toContain(firstUrl);
      expect(prompt).toContain(secondUrl);
      expect(prompt).not.toContain('"type":"file"');
    }
    expect(firstPrompt).toContain('current\\\":true,\\\"title\\\":\\\"Side Agent Target');
    expect(secondPrompt).toContain('current\\\":true,\\\"title\\\":\\\"After Navigation');
    expect(await opened.page.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowCount);

    const events = await readEvents(opened.page);
    const contexts = events.filter((event) => event.type === "browser.context.prepared");
    expect(contexts.some((event) => event.content.stepNumber === 0
      && event.content.tabs.some((tab: any) => tab.current && tab.url === firstUrl))).toBe(true);
    expect(contexts.some((event) => event.content.stepNumber === 0
      && event.content.tabs.some((tab: any) => tab.current && tab.url === secondUrl))).toBe(true);
    expect(JSON.stringify(events.filter((event) => event.type === "conversation.message"))).not.toContain("<browser-context>");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps the default title after an unrecoverable title request failure", async () => {
  const provider = await startProvider([textResponse("BODY_REPLY"), { status: 400, error: "bad title request" }]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("title should fail");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BODY_REPLY");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "model.title.failed")).toBe(true);
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.getByTestId("composer-input")).toBeEnabled();
    const requestCount = provider.requests.length;
    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.locator(".markdown-body")).toHaveCount(0);
    await opened.page.waitForTimeout(200);
    expect(provider.requests).toHaveLength(requestCount);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("contains long unhandled errors in both extension views", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    for (const page of [opened.page, options]) {
      await page.setViewportSize({ width: 360, height: 700 });
      await page.evaluate(() => {
        const error = new Error("LONG_ERROR_".repeat(2000));
        window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
      });
      const notice = page.getByRole("alert").filter({ hasText: "发生未处理的错误" });
      await expect(notice).toBeVisible();
      await expect(notice.getByText("错误详情")).toBeVisible();
      await expect(notice.locator(".app-error-detail")).toBeHidden();
      await notice.getByText("错误详情").click();
      await expect(notice.locator(".app-error-detail")).toContainText("LONG_ERROR_");
      expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await notice.getByRole("button", { name: "关闭错误提示" }).click();
      await expect(notice).toHaveCount(0);
    }
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    await expect(options.getByRole("button", { name: "保存配置" })).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows a compact model request error while keeping its full detail", async () => {
  const detail = "PROVIDER_ERROR_".repeat(1000);
  const provider = await startProvider([{ status: 400, error: detail }]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("request fails");
    await composer.press("Enter");
    const notice = opened.page.locator(".app-error-notice").filter({ hasText: "模型请求失败" });
    await expect(notice).toBeVisible();
    await expect(notice.locator(".app-error-detail")).toBeHidden();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("PROVIDER_ERROR_");
    await expect(composer).toBeVisible();
    const events = await readEvents(opened.page);
    expect(JSON.stringify(events)).toContain("PROVIDER_ERROR_");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows a bounded diagnostic when the canonical event log fails", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        if (names === "events" && mode === "readwrite") throw new Error("LOG_ERROR_".repeat(2000));
        return original.call(this, names, mode, options);
      };
    });
    await opened.page.getByTestId("composer-input").fill("trigger log write");
    await opened.page.getByTestId("composer-input").press("Enter");
    const notice = opened.page.getByTestId("fatal-log-error").locator(".app-error-notice");
    await expect(notice).toContainText("事件日志不可用");
    await expect(opened.page.getByTestId("open-settings")).toBeVisible();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("LOG_ERROR_");
    expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});



test("uploads through a hidden chooser and preserves held input across independent commands", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const upload = document.createElement("input"); upload.type = "file"; upload.multiple = true; upload.hidden = true;
      upload.onchange = () => { document.body.dataset.uploaded = [...(upload.files ?? [])].map((file) => file.name).join(","); };
      document.body.append(upload);
      const other = document.createElement("input"); other.type = "file"; other.hidden = true; document.body.append(other);
      const button = document.createElement("button"); button.id = "chooser"; button.textContent = "Upload hidden files"; button.onclick = () => upload.click(); document.body.append(button);
      const canvas = document.createElement("div"); canvas.style.cssText = "position:fixed;left:20px;top:200px;width:200px;height:40px;background:#eee";
      canvas.onpointerdown = () => { document.body.dataset.dragStarted = "yes"; };
      canvas.onpointermove = (event) => { if (event.buttons & 1) document.body.dataset.dragMoved = `${event.clientX}`; };
      canvas.onpointerup = (event) => { document.body.dataset.dragReleased = `${event.clientX},${event.clientY}`; };
      document.body.append(canvas);
    });
    responses.push(
      commandResponse("run", { code: `return await page.locator(${JSON.stringify("#chooser")}).click();` }, "chooser-open"),
      commandResponse("run", { code: `return await page.upload(${JSON.stringify([{ name: "first.txt", text: "first" }, { name: "second.txt", text: "second" }])});` }, "chooser-upload"),
      commandResponse("run", { code: `return await page.getByLabel(${JSON.stringify("Email")}).fill(${JSON.stringify("")});` }, "focus-email"),
      commandResponse("run", { code: `return await page.keyboard.down(${JSON.stringify("Shift")});` }, "hold-shift"),
      commandResponse("run", { code: `return await page.keyboard.press(${JSON.stringify("a")});` }, "shift-a"),
      commandResponse("run", { code: `return await page.keyboard.up(${JSON.stringify("Shift")});` }, "release-shift"),
      commandResponse("run", { code: `return await page.mouse.move(${JSON.stringify(40)},${JSON.stringify(215)});` }, "move-start"),
      commandResponse("run", { code: `return await page.mouse.down();` }, "drag-start"),
      commandResponse("run", { code: `return await page.mouse.move(${JSON.stringify(160)},${JSON.stringify(215)});` }, "drag-move"),
      commandResponse("run", { code: `return await page.mouse.up();` }, "drag-end"),
      textResponse("CHOOSER_AND_INPUT_OK"), textResponse("上传和输入"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("upload hidden files and use held keyboard and pointer input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_AND_INPUT_OK");
    await expect(target.getByLabel("Email")).toHaveValue("A");
    expect(await target.evaluate(() => ({ ...document.body.dataset }))).toMatchObject({ uploaded: "first.txt,second.txt", dragStarted: "yes", dragMoved: "160", dragReleased: "160,215" });
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.failed")).toEqual([]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("restores completed program receipts after a failed form assertion", async () => {
  const provider = await startProvider([
    commandResponse("run", { code: "await page.getByLabel('Email').fill('saved@example.com'); await check(await page.getByLabel('Email').inputValue() === 'different@example.com', 'expected a different email'); await page.getByRole('button',{name:'Sign in'}).click();" }, "batch-partial"),
    textResponse("PARTIAL_BATCH_REPORTED"), textResponse("批次恢复"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("verify a partial batch preserves its progress");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PARTIAL_BATCH_REPORTED");
    const read = async () => (await readEvents(opened.page)).find((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "batch-partial")?.output;
    const result = await read();
    expect(result).toMatchObject({ ok: false, state: "failed", result: { error: { message: "expected a different email" } } });
    const receipts = (await readEvents(opened.page)).filter(event => event.type === "browser.job.progress" && event.toolCallId === "batch-partial");
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.objectContaining({ operation: "page.getByLabel.fill", state: "completed" }) }), expect.objectContaining({ content: expect.objectContaining({ operation: "check", state: "not-dispatched" }), error: expect.any(Object) })]));
    expect(receipts.some(event => event.content.operation.endsWith("click"))).toBe(false);
    await opened.page.reload();
    expect(await read()).toEqual(result);
    await expect(target.getByLabel("Email")).toHaveValue("saved@example.com");
    await expect(target.locator("output")).toHaveText("");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("preserves program progress when its native Side Panel closes during a later wait", async () => {
  const provider = await startProvider([commandResponse("run", { code: "await page.getByLabel('Email').fill('persisted@example.com'); await page.locator('#never-created').waitFor({state:'visible'}); await page.getByRole('button',{name:'Sign in'}).click();", timeoutMs: 300_000 }, "native-partial-act")]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/automation`);
    await submitNative(native.panel, "complete the first action and wait for the next assertion");
    await expect(native.target.getByLabel("Email")).toHaveValue("persisted@example.com");
    await expect.poll(async () => (await readNativeEvents(native.panel)).filter((event) => event.type === "browser.job.progress" && event.toolCallId === "native-partial-act" && event.content.operation === "page.getByLabel.fill" && event.content.state === "completed").length).toBe(1);
    await expect.poll(async () => (await readNativeEvents(native.panel)).filter((event) => event.type === "automation.action.started" && event.toolCallId === "native-partial-act" && event.content.operation === "waitFor").length).toBe(1);
    await native.panel.close();
    expect((await native.browser.send("Target.closeTarget", { targetId: native.targetId })).success).toBe(true);
    await expect(native.target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    const recovery = await opened.context.newPage(); await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    const results = async () => (await readEvents(recovery)).filter((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "native-partial-act");
    await expect.poll(async () => (await results()).length).toBe(1);
    const result = (await results())[0].output;
    expect(result).toMatchObject({ ok: false, error: { effectUnknown: true } });
    const receipts = (await readEvents(recovery)).filter(event => event.type === "browser.job.progress" && event.toolCallId === "native-partial-act");
    expect(receipts.some(event => event.content.operation === "page.getByLabel.fill" && event.content.state === "completed")).toBe(true);
    expect(receipts.some(event => event.content.operation.endsWith("click"))).toBe(false);
    await recovery.reload();
    expect((await results()).map((event) => event.output)).toEqual([result]);
    await expect(native.target.getByLabel("Email")).toHaveValue("persisted@example.com");
    await expect(native.target.locator("output")).toHaveText("");
    expect(provider.requests).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("uploads multiple hidden files through a cross-origin frame chooser", async () => {
  const provider = await startProvider([
    commandResponse("run", { code: `return await (page.frameLocator('iframe[src*=localhost]').getByRole('button', { name: 'Upload frame files' }).click());` }, "frame-chooser"),
    commandResponse("run", { code: `return await page.upload(${JSON.stringify([{ name: "frame-one.txt", text: "one" }, { name: "frame-two.txt", text: "two" }])});` }, "frame-upload"),
    textResponse("FRAME_UPLOAD_OK"), textResponse("框架上传"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const frame = target.frames().find((frame) => frame.url().includes("localhost"))!;
    await frame.evaluate(() => {
      const input = document.createElement("input"); input.type = "file"; input.hidden = true; input.multiple = true;
      input.onchange = () => { document.body.dataset.files = [...(input.files ?? [])].map((file) => file.name).join(","); };
      document.body.append(input);
      const unrelated = document.createElement("input"); unrelated.type = "file"; unrelated.hidden = true; document.body.append(unrelated);
      const button = document.createElement("button"); button.textContent = "Upload frame files"; button.onclick = () => input.click(); document.body.append(button);
    });
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    await opened.page.getByTestId("composer-input").fill("upload files in the frame chooser");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_UPLOAD_OK");
    await expect(frame.locator("body")).toHaveAttribute("data-files", "frame-one.txt,frame-two.txt");
    expect((await readEvents(opened.page)).filter((event) => event.type === "tool.failed")).toEqual([]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("rejects detached snapshot references and negative locator indexes below the beginning", async () => {
  let ref = "";
  const responses: MockResponse[] = [
    commandResponse("inspect", {}, "original-ref"),
    (request) => {
      const message = request.messages.findLast((message: any) => message.role === "tool");
      ref = /button "Sign in" \[ref=(t\d+d\d+e\d+)\]/.exec(JSON.parse(message.content).snapshot)![1]!;
      return commandResponse("run", { code: `return await (page.getByRole('button', { name: 'Sign in' }).evaluate("button => { const replacement = button.cloneNode(true); replacement.onclick = () => document.body.dataset.replacementClicked = 'yes'; button.replaceWith(replacement); }"));` }, "replace-ref");
    },
    () => commandResponse("run", { code: `return await page.ref(${JSON.stringify(ref)}).click();`, timeoutMs: 1000 }, "detached-ref"),
    commandResponse("run", { code: `return await ({ css: await page.locator('button').nth(-2).count(), text: await page.getByText('Sign in', { exact: true }).nth(-2).count() });` }, "negative-index"),
    textResponse("STALE_AND_INDEX_OK"), textResponse("引用与索引"),
  ];
  const provider = await startProvider(responses); const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    await opened.page.getByTestId("composer-input").fill("verify stale refs and locator indexes");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STALE_AND_INDEX_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.failed" && event.toolCallId === "detached-ref")?.output.error.code).toMatch(/stale|detached/);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "negative-index")?.output.result).toEqual({ css: 0, text: 0 });
    expect(await target.locator("body").getAttribute("data-replacement-clicked")).toBeNull();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("reads cross-frame response bodies and records complete diagnostic events", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    responses.push(
      commandResponse("run", { code: `return await (page.frameLocator('iframe[src*=localhost]').locator('body').evaluate("async () => { console.warn('frame-diagnostic'); return (await fetch('/frame')).status; }"));` }, "frame-fetch"),
      commandResponse("run", { code: `return await net.requests(${JSON.stringify({ filter: "/frame$", limit: 10 })});` }, "frame-requests"),
      (request) => {
        const tool = request.messages.findLast((message: any) => message.role === "tool");
        const requests = JSON.parse(tool.content).result;
        return commandResponse("run", { code: `return await net.responseBody(${JSON.stringify(requests.at(-1).index)});` }, "frame-response-body");
      },
      commandResponse("run", { code: `return await net.console(${JSON.stringify({ minLevel: "warning", limit: 10 })});` }, "frame-console"),
      textResponse("FRAME_DIAGNOSTICS_OK"), textResponse("框架诊断"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("read diagnostics from a cross-origin frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_DIAGNOSTICS_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "frame-response-body")?.output.result).toContain("Cross Origin Frame");
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "frame-console")?.output.result).toEqual(expect.arrayContaining([expect.objectContaining({ text: "frame-diagnostic" })]));
    const raw = events.find((event) => event.type === "browser.diagnostic" && event.content.method === "Network.responseReceived" && event.output.response?.url.endsWith("/frame"));
    expect(raw?.content.source.sessionId).toEqual(expect.any(String));
    expect(raw?.output.response).toMatchObject({ status: 200, headers: expect.any(Object) });
    await expect(target.locator("#__surf-wax-page-guard")).toHaveCount(0);
    const count = (await readEvents(opened.page)).filter((event) => event.type === "browser.diagnostic").length;
    await target.evaluate(async () => { console.warn("after-run"); await fetch("/complex-next"); });
    expect((await readEvents(opened.page)).filter((event) => event.type === "browser.diagnostic")).toHaveLength(count);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const format of ["legacy-user-tools", "system-tools"] as const) test(`continues ${format} history with only three tools and rejects old names without rewriting receipts`, async () => {
  const provider = await startProvider([
    commandResponse("run-code", { code: "async page => { throw new Error('old entry executed'); }" }, "removed-old-entry"),
    commandResponse("run", { code: "const count = await page.evaluate(() => { const n = Number(document.body.dataset.migratedEffects || 0) + 1; document.body.dataset.migratedEffects = String(n); return n; }); await check(count === 1); return count;" }, "current-entry"),
    textResponse("MIGRATED_CURRENT_TOOLS"), textResponse("RETRY_CURRENT_TOOLS"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByLabel("自定义系统提示词").fill("PERSISTED_CUSTOM_GUIDANCE");
    await options.getByRole("button", { name: "保存配置" }).click(); await expect(options.getByRole("status")).toContainText("配置已保存"); await options.close();
    await nameCurrentConversation(opened.page, `History ${format}`);
    const conversationId = (await readEvents(opened.page)).find(event => event.type === "conversation.title.updated" && event.content.title === `History ${format}`).conversationId;
    await opened.page.evaluate(async ({ conversationId, format }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction("events", "readwrite"); const store = tx.objectStore("events"); const timestamp = new Date().toISOString();
      store.add({ type: "context.prompt.updated", conversationId, timestamp, content: { prompt: { version: format === "system-tools" ? 2 : 1, format, catalogVersion: "formal-49-v2", source: "PERSISTED_CUSTOM_GUIDANCE", instructions: "HISTORICAL_PROMPT_ONLY" } } });
      store.add({ type: "conversation.message", conversationId, timestamp, content: { id: "historical-user", role: "user", parts: [{ type: "text", text: "HISTORICAL_USER" }], metadata: { custom: { toolCatalog: { version: "formal-49-v2", context: "Available tools:\n- run-code: historical only" } } } }, parentId: null });
      store.add({ type: "conversation.message", conversationId, timestamp, content: { id: "historical-assistant", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "run-code", toolCallId: "historical-tool", state: "output-available", input: { code: "async page => 7" }, output: { historical: "HISTORICAL_RECEIPT" } }, { type: "text", text: "HISTORICAL_REPLY" }] }, parentId: "historical-user" });
      store.add({ type: "conversation.branch.selected", conversationId, timestamp, content: { headId: "historical-assistant" } });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    }, { conversationId, format });
    const historical = (await readEvents(opened.page)).filter(event => event.conversationId === conversationId);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: `History ${format}` }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORICAL_REPLY"); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("continue the historical task with current tools"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MIGRATED_CURRENT_TOOLS");
    const events = await readEvents(opened.page);
    for (const event of historical) expect(events.find(current => current.id === event.id)).toEqual(event);
    expect(events.filter(event => event.type === "tool.failed" && event.toolCallId === "removed-old-entry")).toHaveLength(1);
    expect(JSON.stringify(events.find(event => event.type === "tool.failed" && event.toolCallId === "removed-old-entry")?.error)).toContain("run-code");
    expect(events.some(event => event.type === "automation.action.started" && event.toolCallId === "removed-old-entry")).toBe(false);
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "current-entry")?.output).toMatchObject({ ok: true, state: "succeeded", result: 1 });
    expect(events.some(event => event.type === "browser.job.progress" && event.toolCallId === "current-entry" && event.content.operation === "check" && event.content.state === "verified")).toBe(true);
    expect(events.filter(event => event.type === "context.prompt.updated").at(-1)?.content).toMatchObject({ migratedFrom: "formal-49-v2", prompt: { catalogVersion: "inspect-run-jobs-v1", format: "system-tools" } });
    const requests = provider.requests.filter(request => request.tools);
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.tools.map((tool: any) => tool.function.name)).toEqual(["inspect", "run", "jobs"]);
    expect(requests[0].messages[0].content).toMatch(/^PERSISTED_CUSTOM_GUIDANCE\n\nAvailable tools:/);
    expect(JSON.stringify(requests[0].messages)).toContain("HISTORICAL_RECEIPT");
    await opened.page.getByTestId("retry-user-message-button").last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RETRY_CURRENT_TOOLS");
    expect(provider.requests.filter(request => request.tools).at(-1).tools.map((tool: any) => tool.function.name)).toEqual(["inspect", "run", "jobs"]);
    await expect(target.locator("body")).toHaveAttribute("data-migrated-effects", "1");
    for (const event of historical) expect((await readEvents(opened.page)).find(current => current.id === event.id)).toEqual(event);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
