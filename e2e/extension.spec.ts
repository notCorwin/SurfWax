import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SSE_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-cache",
  "content-type": "text/event-stream",
};

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function chunk(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-side-agent-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function textResponse(text: string): string[] {
  return [chunk({ role: "assistant", content: text }), chunk({}, "stop"), "data: [DONE]\n\n"];
}

function toolResponse(code: string, id = "call-chrome-e2e"): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name: "chrome", arguments: JSON.stringify({ code }) },
      }],
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

function queuedToolResponse(firstCode: string, secondCode: string): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [firstCode, secondCode].map((code, index) => ({
        index,
        id: `call-queued-${index}`,
        type: "function",
        function: { name: "chrome", arguments: JSON.stringify({ code }) },
      })),
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

type MockResponse = string[] | { status: number; error: string };

async function startProvider(responses: MockResponse[], delayMs = 0): Promise<{
  baseURL: string;
  origin: string;
  requests: any[];
  server: Server;
  stats: { abortedResponses: number };
}> {
  const requests: any[] = [];
  const stats = { abortedResponses: 0 };
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": "*",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Side Agent Target</title><main>ready</main>");
      return;
    }
    if (request.method === "GET" && request.url === "/complex") {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server is not listening");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Before Navigation</title><iframe src="/same-frame"></iframe><iframe src="http://localhost:${address.port}/frame"></iframe>`);
      return;
    }
    if (request.method === "GET" && request.url === "/same-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Same Process Frame</title><main>same origin</main>");
      return;
    }
    if (request.method === "GET" && request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Cross Origin Frame</title><main>frame ready</main>");
      return;
    }
    if (request.method === "GET" && request.url === "/worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("self.workerMarker = 'WORKER_READY';");
      return;
    }
    if (request.method === "GET" && request.url === "/complex-next") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>After Navigation</title><main>new document</main>");
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    const body: Buffer[] = [];
    request.on("data", (part) => body.push(part));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(body).toString("utf8")));
      const parts = responses.shift();
      if (!parts) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "No mock response remains" } }));
        return;
      }
      if (!Array.isArray(parts)) {
        response.writeHead(parts.status, { "access-control-allow-origin": "*", "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: parts.error } }));
        return;
      }
      response.writeHead(200, SSE_HEADERS);
      response.on("close", () => {
        if (!response.writableEnded) stats.abortedResponses += 1;
      });
      let index = 0;
      const write = () => {
        if (response.destroyed || index >= parts.length) {
          if (!response.destroyed) response.end();
          return;
        }
        response.write(parts[index]);
        index += 1;
        setTimeout(write, delayMs);
      };
      write();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return { baseURL: `${origin}/v1`, origin, requests, server, stats };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function openExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
  page: Page;
  userDataDirectory: string;
}> {
  const userDataDirectory = await mkdtemp(resolve(tmpdir(), "side-agent-e2e-"));
  const extensionPath = resolve(process.cwd(), "dist");
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { context, extensionId, page, userDataDirectory };
}

async function dispose(context: BrowserContext, directory: string, server?: Server): Promise<void> {
  await context.close();
  await rm(directory, { recursive: true, force: true });
  if (server) await closeServer(server);
}

async function configure(context: BrowserContext, page: Page, baseURL: string): Promise<Page> {
  const [options] = await Promise.all([context.waitForEvent("page"), page.getByTestId("open-settings").click()]);
  await options.waitForLoadState("domcontentloaded");
  const fields = options.getByTestId("options-card").locator("input");
  await fields.nth(0).fill(baseURL);
  await fields.nth(1).fill("test-model");
  await fields.nth(2).fill("test-key");
  await options.getByRole("button", { name: "保存配置" }).click();
  await expect(options.getByRole("status")).toContainText("配置已保存");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  return options;
}

async function enableUserScripts(context: BrowserContext, extensionId: string, extensionPage: Page): Promise<void> {
  if (await extensionPage.evaluate(() => typeof chrome.userScripts === "object")) return;
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${extensionId}`);
  const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect.poll(() => extensionPage.evaluate(() => typeof chrome.userScripts)).toBe("object");
  await settings.close();
}

async function readEvents(page: Page): Promise<any[]> {
  return page.evaluate(() => new Promise((resolveEvents, reject) => {
    const request = indexedDB.open("side-agent-runtime");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("events", "readonly");
      const all = transaction.objectStore("events").getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolveEvents(all.result);
    };
  }));
}

test("ships only the minimal MV3 Harness surface", async () => {
  const opened = await openExtension();
  try {
    const manifest = await opened.page.evaluate(() => chrome.runtime.getManifest());
    expect(manifest).toMatchObject({ name: "Surf Wax", manifest_version: 3, minimum_chrome_version: "138", version: "0.2.0" });
    expect(manifest.permissions).toEqual(expect.arrayContaining(["debugger", "scripting", "userScripts"]));
    await expect(opened.page.locator("h1")).toHaveText("Surf Wax");
    await expect(opened.page.getByTestId("config-required-state")).toBeVisible();

    const options = await configure(opened.context, opened.page, "https://provider.test/v1");
    await expect(options.getByTestId("options-card").locator("input")).toHaveCount(3);
    await expect(options.getByTestId("event-log-clear")).toBeVisible();
    await expect(options.getByTestId("event-log")).toHaveCount(0);
    await expect(options.getByTestId("user-scripts-panel")).toHaveCount(0);
    await expect(opened.page.getByTestId("welcome-options")).toHaveCount(0);
    await expect(opened.page.getByTestId("edit-message-button")).toHaveCount(0);
    await expect(opened.page.getByTestId("model-label")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("executes the one chrome({ code }) tool across extension, MAIN, USER_SCRIPT and CDP, then restores and clears the log", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  const code = `
const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(targetUrl)} });
if (!tab?.id) throw new Error("target tab missing");
await chrome.userScripts.unregister({ ids: ["e2e-script"] }).catch(() => undefined);
await chrome.userScripts.register([{ id: "e2e-script", matches: [${JSON.stringify(`${provider.origin}/*`)}], js: [{ code: "document.documentElement.dataset.registered = 'yes'" }], world: "USER_SCRIPT" }]);
await chrome.userScripts.update([{ id: "e2e-script", js: [{ code: "document.documentElement.dataset.updated = 'yes'" }] }]);
const scripts = await chrome.userScripts.getScripts({ ids: ["e2e-script"] });
const userResult = await chrome.userScripts.execute({ target: { tabId: tab.id }, world: "USER_SCRIPT", js: [{ code: "document.documentElement.dataset.user = 'yes'; 'USER_OK'" }] });
const [mainResult] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => { document.documentElement.dataset.main = "yes"; return "MAIN_OK"; } });
await chrome.debugger.attach({ tabId: tab.id }, "1.3");
let cdp;
try { cdp = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: "document.title", returnByValue: true }); }
finally { await chrome.debugger.detach({ tabId: tab.id }); }
return { extensionTitle: document.title, version: chrome.runtime.getManifest().version, scriptCount: scripts.length, user: userResult[0]?.result, main: mainResult.result, cdp: cdp.result.value };
`;
  responses.push(toolResponse(code), textResponse("META_OK"), textResponse("工具测试"));
  const opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await target.goto(targetUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("exercise every browser context");
    await composer.press("Enter");
    await expect(opened.page.locator(".activity")).toHaveCount(1);
    await expect(opened.page.locator(".activity summary")).toContainText("调用了命令");
    await expect(opened.page.locator(".activity")).not.toHaveAttribute("open", "");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("META_OK");
    await opened.page.locator(".activity summary").click();
    await expect(opened.page.locator(".activity")).toContainText("USER_OK");
    await expect(opened.page.locator(".activity")).toContainText("MAIN_OK");
    await expect(opened.page.locator(".activity")).toContainText("Side Agent Target");
    await expect.poll(() => target.evaluate(() => ({ main: document.documentElement.dataset.main, user: document.documentElement.dataset.user })))
      .toEqual({ main: "yes", user: "yes" });

    await expect.poll(() => provider.requests.length).toBe(3);
    expect(provider.requests[0].reasoning_effort).toBe("minimal");
    expect(provider.requests[0].tools).toHaveLength(1);
    expect(provider.requests[0].tools[0]).toMatchObject({
      type: "function",
      function: { name: "chrome", parameters: { type: "object", required: ["code"], additionalProperties: false } },
    });
    const events = await readEvents(opened.page);
    const tool = events.find((event) => event.type === "tool.finished");
    expect(tool).toMatchObject({ toolCallId: "call-chrome-e2e", input: { code: expect.any(String) }, latencyMs: expect.any(Number) });
    expect(tool.output).toMatchObject({ user: "USER_OK", main: "MAIN_OK", cdp: "Side Agent Target" });
    expect(events.filter((event) => /^(model|request|tool)\./.test(event.type)).every((event) => typeof event.conversationId === "string")).toBe(true);
    expect(events.filter((event) => event.type === "conversation.message")).toHaveLength(2);

    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.locator('[data-role="user"]')).toHaveCount(0);
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "工具测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator('[data-role="user"]')).toContainText("exercise every browser context");
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

test("keeps CDP sessions and events across calls, reaches iframe and worker, navigates, and inspects a result reference", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const origin = provider.origin;
  responses.push(
    toolResponse(`
const target = (await chrome.debugger.getTargets()).find(item => item.url === ${JSON.stringify(`${origin}/complex`)});
if (!target?.tabId) throw new Error('target tab missing');
const debuggee = { tabId: target.tabId };
await chrome.debugger.attach(debuggee, '1.3');
const state = globalThis.__e2eCdp = { debuggee, events: [] };
state.listener = (source, method, params) => {
  if (source.tabId === target.tabId && (method === 'Target.attachedToTarget' || method === 'Runtime.executionContextCreated')) state.events.push({ method, params });
};
chrome.debugger.onEvent.addListener(state.listener);
await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
await chrome.debugger.sendCommand(debuggee, 'Page.enable');
await chrome.debugger.sendCommand(debuggee, 'Target.setAutoAttach', {
  autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }]
});
return { tabId: target.tabId, attached: true };`, "call-cdp-1"),
    toolResponse(`
const state = globalThis.__e2eCdp;
await chrome.debugger.sendCommand(state.debuggee, 'Runtime.evaluate', { expression: "globalThis.worker = new Worker('/worker.js')" });
for (let attempt = 0; attempt < 50 && state.events.filter(event => event.method === 'Target.attachedToTarget').length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
const sessions = state.events.filter(event => event.method === 'Target.attachedToTarget').map(event => event.params);
const frame = sessions.find(event => event.targetInfo.type === 'iframe');
const worker = sessions.find(event => event.targetInfo.type === 'worker');
if (!frame || !worker) throw new Error('Missing iframe or worker flat session: ' + JSON.stringify(sessions.map(item => item.targetInfo.type)));
const frameResult = await chrome.debugger.sendCommand({ ...state.debuggee, sessionId: frame.sessionId }, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
const workerResult = await chrome.debugger.sendCommand({ ...state.debuggee, sessionId: worker.sessionId }, 'Runtime.evaluate', { expression: 'self.workerMarker', returnByValue: true });
const tree = await chrome.debugger.sendCommand(state.debuggee, 'Page.getFrameTree');
const sameFrame = tree.frameTree.childFrames.find(item => item.frame.url.endsWith('/same-frame'));
const sameContext = state.events.find(event => event.method === 'Runtime.executionContextCreated' && event.params.context.auxData?.frameId === sameFrame?.frame.id && event.params.context.auxData?.isDefault);
if (!sameContext) throw new Error('Missing same-process execution context');
const sameResult = await chrome.debugger.sendCommand(state.debuggee, 'Runtime.evaluate', { contextId: sameContext.params.context.id, expression: 'document.title', returnByValue: true });
await chrome.tabs.update(state.debuggee.tabId, { url: ${JSON.stringify(`${origin}/complex-next`)} });
return { frame: frameResult.result.value, sameFrame: sameResult.result.value, worker: workerResult.result.value, events: state.events.length };`, "call-cdp-2"),
    toolResponse(`
const state = globalThis.__e2eCdp;
for (let attempt = 0; attempt < 50; attempt++) {
  const tab = await chrome.tabs.get(state.debuggee.tabId);
  if (tab.status === 'complete' && tab.url === ${JSON.stringify(`${origin}/complex-next`)}) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const result = await chrome.debugger.sendCommand(state.debuggee, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
chrome.debugger.onEvent.removeListener(state.listener);
await chrome.debugger.detach(state.debuggee);
delete globalThis.__e2eCdp;
return { title: result.result.value };`, "call-cdp-3"),
    toolResponse("return new Map([['answer', 42], ['kind', 'inspectable']]);", "call-cdp-4"),
    toolResponse(`
const [id, value] = [...globalThis.__surfWaxResults.entries()].at(-1);
const result = { entries: [...value.entries()], id };
globalThis.__surfWaxResults.delete(id);
return result;`, "call-cdp-5"),
    textResponse("COMPLEX_OK"), textResponse("复杂浏览器任务"),
  );
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${origin}/complex`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("execute a cross-context browser workflow");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPLEX_OK");
    const outputs = (await readEvents(opened.page)).filter((event) => event.type === "tool.finished").map((event) => event.output);
    expect(outputs).toHaveLength(5);
    expect(outputs[1]).toMatchObject({ frame: "Cross Origin Frame", sameFrame: "Same Process Frame", worker: "WORKER_READY" });
    expect(outputs[2]).toMatchObject({ title: "After Navigation" });
    expect(outputs[3]).toMatchObject({ $ref: expect.any(String), access: expect.stringContaining("__surfWaxResults.get") });
    expect(outputs[4]).toMatchObject({ entries: [["answer", 42], ["kind", "inspectable"]], id: outputs[3].$ref });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("streams complete Markdown without blocking draft input", async () => {
  const markdown = [
    "# Heading\n\n> quote\n\n- [x] task\n\n~~strike~~ and [link](https://example.com).\n\n",
    "| A | B |\n| - | - |\n| 1 | 2 |\n\nInline $x^2$ and block:\n\n$$y=x+1$$\n\n",
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
      const root = document.querySelector<HTMLElement>('[data-testid="thread-root"]');
      const flow = element.querySelector<HTMLElement>(".markdown-flow");
      const firstBlock = flow?.firstElementChild;
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

test("stress profile: dense stream and long canonical log stay interactive", async () => {
  const parts = [
    chunk({ role: "assistant", content: "# Stress\n\n" }),
    ...Array.from({ length: 1_500 }, (_, index) => chunk({
      content: index % 25 === 0
        ? `\n\n- row ${index} with **bold** and $x_${index}^2$\n\n`
        : `token-${index} `,
    })),
    chunk({ content: "STREAM_STRESS_DONE" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const provider = await startProvider([parts, textResponse("压力测试")]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 850 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.evaluate(() => {
      const metrics = { frameGaps: [] as number[], longTasks: [] as number[], running: true };
      (globalThis as typeof globalThis & { __stressMetrics?: typeof metrics }).__stressMetrics = metrics;
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        new PerformanceObserver((list) => {
          metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration));
        }).observe({ type: "longtask", buffered: true });
      }
      let previous = performance.now();
      const frame = (now: number) => {
        if (!metrics.running) return;
        metrics.frameGaps.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("stress the streaming renderer");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toHaveAttribute("data-status", "running");
    const inputStarted = Date.now();
    await composer.pressSequentially("responsive-typing-".repeat(12));
    const inputMs = Date.now() - inputStarted;
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_STRESS_DONE");
    const metrics = await opened.page.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __stressMetrics?: { frameGaps: number[]; longTasks: number[]; running: boolean } }).__stressMetrics;
      if (!state) return { frameGaps: [] as number[], maxLongTask: 0, longTaskCount: 0 };
      state.running = false;
      return {
        frameGaps: state.frameGaps,
        maxLongTask: Math.max(0, ...state.longTasks),
        longTaskCount: state.longTasks.length,
      };
    });
    const events = await readEvents(opened.page);
    const conversationId = events.find((event) => event.type === "conversation.created")?.conversationId;
    if (!conversationId) throw new Error("stress conversation was not created");
    const streamEvents = events.filter((event) => event.type === "conversation.stream.chunk").length;

    await opened.page.evaluate(async ({ id }) => {
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        const request = indexedDB.open("side-agent-runtime");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolveDb(request.result);
      });
      const transaction = db.transaction("events", "readwrite");
      const store = transaction.objectStore("events");
      const timestamp = new Date().toISOString();
      for (let index = 0; index < 100_000; index += 1) {
        store.add({
          type: "conversation.stream.chunk",
          timestamp,
          conversationId: id,
          runId: "completed-stress-run",
          content: { type: "text-delta", id: "stress", delta: "x" },
        });
      }
      let parentId: string | null = null;
      for (let index = 0; index < 500; index += 1) {
        const userId = `stress-user-${index}`;
        const assistantId = `stress-assistant-${index}`;
        store.add({
          type: "conversation.message",
          timestamp,
          conversationId: id,
          parentId,
          content: { id: userId, role: "user", parts: [{ type: "text", text: `Question ${index}` }] },
        });
        store.add({
          type: "conversation.message",
          timestamp,
          conversationId: id,
          parentId: userId,
          content: {
            id: assistantId,
            role: "assistant",
            parts: [{ type: "text", text: `## Answer ${index}\n\n${"Paragraph with **formatting** and $x^2$.\n\n".repeat(8)}HISTORY_MARKER_${index}` }],
          },
        });
        parentId = assistantId;
      }
      await new Promise<void>((resolveTransaction, reject) => {
        transaction.oncomplete = () => resolveTransaction();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    }, { id: conversationId });

    const reloadStarted = Date.now();
    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "压力测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORY_MARKER_499");
    const reloadMs = Date.now() - reloadStarted;
    const restoredComposer = opened.page.getByTestId("composer-input");
    const restoredInputStarted = Date.now();
    await restoredComposer.pressSequentially("after-reload");
    const restoredInputMs = Date.now() - restoredInputStarted;
    const dom = await opened.page.evaluate(() => ({
      elements: document.querySelectorAll("*").length,
      messages: document.querySelectorAll('[data-role="user"], [data-role="assistant"]').length,
    }));
    await opened.page.evaluate(() => {
      const state = { gaps: [] as number[], running: true };
      (globalThis as typeof globalThis & { __scrollStress?: typeof state }).__scrollStress = state;
      let previous = performance.now();
      const frame = (now: number) => {
        if (!state.running) return;
        state.gaps.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const viewport = opened.page.getByTestId("thread-viewport");
    const box = await viewport.boundingBox();
    if (!box) throw new Error("stress viewport has no bounding box");
    await opened.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 30; index += 1) {
      await opened.page.mouse.wheel(0, -1_000);
      await opened.page.waitForTimeout(16);
    }
    const scrollFrameGaps = await opened.page.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __scrollStress?: { gaps: number[]; running: boolean } }).__scrollStress;
      if (!state) return [] as number[];
      state.running = false;
      return state.gaps;
    });
    const maxFrameGap = Math.max(0, ...metrics.frameGaps);
    const p95FrameGap = p95(metrics.frameGaps);
    const scrollMaxFrameGap = Math.max(0, ...scrollFrameGaps);
    const scrollP95FrameGap = p95(scrollFrameGaps);
    const jump = opened.page.getByRole("button", { name: "滚动到底部" });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORY_MARKER_499");
    console.log("stress metrics", { inputMs, restoredInputMs, reloadMs, maxFrameGap, p95FrameGap, scrollMaxFrameGap, scrollP95FrameGap, streamEvents, ...dom, maxLongTask: metrics.maxLongTask, longTaskCount: metrics.longTaskCount });

    expect(streamEvents).toBeGreaterThanOrEqual(1_500);
    expect(inputMs).toBeLessThan(500);
    expect(restoredInputMs).toBeLessThan(250);
    expect(reloadMs).toBeLessThan(2_000);
    expect(dom.messages).toBeLessThan(50);
    expect(dom.elements).toBeLessThan(1_000);
    expect(p95FrameGap).toBeLessThan(35);
    expect(scrollP95FrameGap).toBeLessThan(100);
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
    await expect(resumed.locator(".markdown-body").last()).toContainText("STREAM_STARTED");
    await resumed.getByTestId("continue-interrupted").click();
    await expect(resumed.locator('[data-role="user"]').last()).toContainText("继续上一次被中断的工作");
    await expect(resumed.locator(".markdown-body").last()).toContainText("CONTINUED");
    await expect(resumed.getByTestId("conversation-menu")).toContainText("恢复后的标题");
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
    await opened.page.locator(".conversation-new").click();
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

test("keeps a running conversation alive when only switching threads", async () => {
  const slowReply = [
    chunk({ role: "assistant", content: "STREAM_RUNNING" }),
    ...Array.from({ length: 30 }, () => chunk({ content: "." })),
    chunk({ content: "BACKGROUND_DONE" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const provider = await startProvider([slowReply, textResponse("后台标题")], 10);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("keep running in background");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_RUNNING");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-new").click();
    await expect.poll(() => provider.requests.length).toBe(2);
    expect(provider.stats.abortedResponses).toBe(0);

    await opened.page.getByTestId("conversation-menu").click();
    await expect(opened.page.locator(".conversation-item")).toHaveCount(1);
    await opened.page.locator(".conversation-item", { hasText: "后台标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BACKGROUND_DONE");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("closing the panel prevents a queued chrome call from starting", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  responses.push(queuedToolResponse(
    `const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(targetUrl)} }); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); await new Promise(() => undefined);`,
    "await chrome.storage.local.set({ 'e2e-queued-tool-ran': true }); return true;",
  ));
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(targetUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("queue two calls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".activity")).toHaveCount(2);
    await expect(opened.page.locator(".activity").first().locator("summary")).toContainText("运行命令中");
    await expect.poll(() => opened.page.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      try { await chrome.debugger.attach({ tabId: tab.id! }, "1.3"); await chrome.debugger.detach({ tabId: tab.id! }); return false; }
      catch { return true; }
    }, targetUrl)).toBe(true);
    await opened.page.close();

    const probe = await opened.context.newPage();
    await probe.goto(`chrome-extension://${opened.extensionId}/options.html`);
    await expect.poll(() => probe.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      try { await chrome.debugger.attach({ tabId: tab.id! }, "1.3"); await chrome.debugger.detach({ tabId: tab.id! }); return true; }
      catch { return false; }
    }, targetUrl)).toBe(true);
    await expect.poll(() => probe.evaluate(async () => (await chrome.storage.local.get("e2e-queued-tool-ran"))["e2e-queued-tool-ran"]))
      .toBeUndefined();
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
  responses.push(toolResponse(`
const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(otherUrl)} });
await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
  const button = document.createElement('button');
  button.textContent = 'CDP target';
  button.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:40px';
  button.onclick = () => { document.documentElement.dataset.cdpClicks = String(Number(document.documentElement.dataset.cdpClicks || 0) + 1); };
  document.body.append(button);
} });
await chrome.debugger.attach({ tabId: tab.id }, '1.3');
try {
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 40, button: 'left', clickCount: 1 });
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 });
} finally { await chrome.debugger.detach({ tabId: tab.id }); }
await new Promise((resolve) => setTimeout(resolve, 1200));
return true;
`), textResponse("MULTI_GUARD_OK"), textResponse("页面防护"));
  const opened = await openExtension();
  try {
    const first = await opened.context.newPage();
    await first.goto(targetUrl);
    const second = await opened.context.newPage();
    await second.goto(otherUrl);
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
    await expect(opened.page.getByRole("status")).toContainText("无法防止点击");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHROME_PAGE_OK");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("manages, restores, runs and deletes scripts in a separate Chrome tab", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const [disabledManager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await expect(disabledManager.getByRole("status")).toContainText("Allow User Scripts");
    await disabledManager.close();
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const [manager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await manager.waitForLoadState("domcontentloaded");
    await expect(manager.getByTestId("user-scripts-panel")).toBeVisible();
    const definition = manager.locator("#script-definition");
    const script = { id: "managed", matches: [`${provider.origin}/*`], js: [{ code: "document.documentElement.dataset.managed = 'first'; 'RUN_OK'" }], world: "USER_SCRIPT" };
    await definition.fill(JSON.stringify(script));
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByLabel("已保存脚本").getByRole("button", { name: /managed · 已注册/ })).toBeVisible();
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toHaveLength(1);
    await definition.fill(JSON.stringify({ ...script, js: [{ code: "document.documentElement.dataset.managed = 'updated'; 'RUN_OK'" }] }));
    await manager.getByRole("button", { name: "保存" }).click();
    const settings = await opened.context.newPage();
    await settings.goto(`chrome://extensions/?id=${opened.extensionId}`);
    const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await manager.reload();
    await expect(manager.getByRole("status")).toContainText("Allow User Scripts");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toHaveLength(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await manager.reload();
    await expect(manager.getByLabel("已保存脚本").getByRole("button", { name: /managed · 已注册/ })).toBeVisible();
    await settings.close();
    await manager.getByLabel("已保存脚本").getByRole("button", { name: /managed · 已注册/ }).click();
    const targetId = await manager.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${provider.origin}/target`);
    await manager.locator("#script-target").selectOption(String(targetId));
    await manager.getByRole("button", { name: "运行脚本" }).click();
    await expect.poll(() => target.evaluate(() => document.documentElement.dataset.managed)).toBe("updated");
    await manager.evaluate(async () => chrome.userScripts.unregister({ ids: ["managed"] }));
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(1);
    manager.once("dialog", (dialog) => dialog.accept());
    await manager.getByRole("button", { name: "删除" }).click();
    await expect(manager.getByLabel("已保存脚本").getByRole("button", { name: "managed" })).toHaveCount(0);
    await manager.evaluate(async () => chrome.storage.local.set({ "side-agent:user-scripts": { legacy: "unreadable" } }));
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect(manager.getByRole("alert").first()).toContainText("原始数据已保留");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toEqual({ legacy: "unreadable" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
