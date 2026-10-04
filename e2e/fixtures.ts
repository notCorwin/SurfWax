import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";

export const SSE_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-cache",
  "content-type": "text/event-stream",
};

export function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function chunk(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-side-agent-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export function usageChunk(promptTokens: number, completionTokens: number, cachedTokens = 0): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-side-agent-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  })}\n\n`;
}

export function textResponse(text: string, usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  return [chunk({ role: "assistant", content: text }), chunk({}, "stop"),
    ...(usage ? [usageChunk(usage.promptTokens, usage.completionTokens, usage.cachedTokens)] : []), "data: [DONE]\n\n"];
}

export function streamingTextResponse(parts: string[], usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  return [
    ...parts.map((content, index) => chunk({ ...(index === 0 ? { role: "assistant" } : {}), content })),
    chunk({}, "stop"),
    ...(usage ? [usageChunk(usage.promptTokens, usage.completionTokens, usage.cachedTokens)] : []),
    "data: [DONE]\n\n",
  ];
}

export function toolResponse(code: string, id = "call-chrome-e2e", usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  const input = { code: `async page => { ${code} }` };
  return [
    chunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name: "run-code", arguments: JSON.stringify(input) },
      }],
    }),
    chunk({}, "tool_calls"),
    ...(usage ? [usageChunk(usage.promptTokens, usage.completionTokens, usage.cachedTokens)] : []),
    "data: [DONE]\n\n",
  ];
}

export function pageResponse(code: string, tabId: number, id = "call-page-e2e"): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name: "run-code", arguments: JSON.stringify({ code: `async page => { ${code} }` }) } }],
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

export function commandResponse(name: string, input: object, id: string): string[] {
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }),
    chunk({}, "tool_calls"), "data: [DONE]\n\n",
  ];
}

export function browserResponse(input: object, id: string): string[] {
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "browser", arguments: JSON.stringify(input) } }] }),
    chunk({}, "tool_calls"), "data: [DONE]\n\n",
  ];
}

export function queuedToolResponse(firstCode: string, secondCode: string): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [firstCode, secondCode].map((code, index) => ({
        index,
        id: `call-queued-${index}`,
        type: "function",
        function: { name: "run-code", arguments: JSON.stringify({ code: `async page => { ${code} }` }) },
      })),
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

export type MockResponse = string[] | { status: number; error: string } | {
  parts: string[]; delayMs: number; partDelayMs?: number; disconnect?: boolean; startAfter?: Promise<void>;
} | ((request: any) => string[]);

export async function startProvider(responses: MockResponse[], delayMs = 0, summaryText?: string, supportedEfforts = ["minimal", "low", "medium", "high", "xhigh"], summaryDelayMs = 0, summaryFailures = 0): Promise<{
  baseURL: string;
  origin: string;
  requests: any[];
  server: Server;
  stats: { abortedResponses: number; disconnectedResponses: number; summaryCalls: number; summaryFailures: number };
}> {
  const requests: any[] = [];
  const stats = { abortedResponses: 0, disconnectedResponses: 0, summaryCalls: 0, summaryFailures };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": "*",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/v1/models") {
      response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-model", reasoning: { supported_efforts: supportedEfforts } }] }));
      return;
    }
    if (request.method === "GET" && pathname === "/target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Side Agent Target</title><main>ready</main>");
      return;
    }
    if (request.method === "GET" && pathname === "/scroll-target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Scroll Target</title><main style='height:3000px'>ready</main>");
      return;
    }
    if (request.method === "GET" && pathname === "/automation") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Automation Target</title><label>Email <input type="email"></label><button onclick="document.querySelector('output').textContent='Welcome '+document.querySelector('input').value">Sign in</button><output></output>`);
      return;
    }
    if (request.method === "GET" && pathname === "/visual") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Visual Target</title><style>button{position:fixed;left:20px;top:20px;width:100px;height:50px}</style><canvas width=200 height=100></canvas><button aria-hidden=true onclick=\"document.body.dataset.clicked='yes'\">Visual action</button>");
      return;
    }
    if (request.method === "GET" && pathname === "/performance") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Performance Target</title><button onclick=\"document.querySelector('output').value=String(Number(document.querySelector('output').value)+1)\">Increment</button><output>0</output>");
      return;
    }
    if (request.method === "GET" && pathname === "/automation-dynamic") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Dynamic Automation</title>
        <button id="dynamic" disabled onclick="advance(this)">Delayed action</button><output>0</output><shadow-action></shadow-action>
        <script>
          let hits = 0;
          function advance(button) {
            document.querySelector('output').textContent = String(++hits);
            const next = button.cloneNode(true); next.disabled = true; button.replaceWith(next);
            setTimeout(() => { next.disabled = false; }, 1);
          }
          customElements.define('shadow-action', class extends HTMLElement {
            connectedCallback() {
              const root = this.attachShadow({mode:'open'}); const button = document.createElement('button'); button.textContent = 'Shadow action';
              button.onclick = () => { this.dataset.clicked = 'yes'; }; root.append(button);
            }
          });
          setTimeout(() => { document.querySelector('#dynamic').disabled = false; }, 20);
        </script>`);
      return;
    }
    if (request.method === "GET" && pathname === "/complex") {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server is not listening");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Before Navigation</title><style>iframe[src*=localhost]{transform:translate(24px,12px) scale(.8);transform-origin:0 0}</style><iframe src="/same-frame"></iframe><iframe src="http://localhost:${address.port}/frame"></iframe>`);
      return;
    }
    if (request.method === "GET" && pathname === "/same-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Same Process Frame</title><main>same origin</main>");
      return;
    }
    if (request.method === "GET" && pathname === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Cross Origin Frame</title><main>frame ready <button onclick=\"document.body.dataset.clicked='yes'\">Frame action</button></main>");
      return;
    }
    if (request.method === "GET" && pathname === "/worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("self.workerMarker = 'WORKER_READY';");
      return;
    }
    if (request.method === "GET" && pathname === "/complex-next") {
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
      const requestBody = JSON.parse(Buffer.concat(body).toString("utf8"));
      requests.push(requestBody);
      if (summaryText && requestBody.stream !== true) {
        stats.summaryCalls += 1;
        if (stats.summaryFailures > 0) {
          stats.summaryFailures -= 1;
          response.writeHead(400, { "access-control-allow-origin": "*", "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Summary generation rejected for this test" } }));
          return;
        }
        setTimeout(() => {
          response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
          response.end(JSON.stringify({ id: "summary", object: "chat.completion", created: 1, model: "test-model",
            choices: [{ index: 0, message: { role: "assistant", content: summaryText }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
        }, summaryDelayMs);
        return;
      }
      const queued = responses.shift();
      if (!queued) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "No mock response remains" } }));
        return;
      }
      const output = typeof queued === "function" ? queued(requestBody) : queued;
      if (!Array.isArray(output) && !("parts" in output)) {
        response.writeHead(output.status, { "access-control-allow-origin": "*", "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: output.error } }));
        return;
      }
      const parts = Array.isArray(output) ? output : output.parts;
      response.writeHead(200, SSE_HEADERS);
      response.on("close", () => {
        if (!response.writableEnded) stats.abortedResponses += 1;
      });
      let index = 0;
      const write = () => {
        if (response.destroyed || index >= parts.length) {
          if (!response.destroyed) {
            if (!Array.isArray(output) && output.disconnect) {
              stats.disconnectedResponses += 1;
              response.destroy();
            } else response.end();
          }
          return;
        }
        response.write(parts[index]);
        index += 1;
        setTimeout(write, !Array.isArray(output) ? output.partDelayMs ?? delayMs : delayMs);
      };
      if (Array.isArray(output)) write();
      else void (output.startAfter ?? Promise.resolve()).then(() => setTimeout(write, output.delayMs), () => response.destroy());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return { baseURL: `${origin}/v1`, origin, requests, server, stats };
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

const testProfiles = new Map<string, BrowserContext>();

test.afterEach(async ({}, info) => {
  for (const [directory, context] of testProfiles) {
    await context.close().catch(() => undefined);
    const source = resolve(directory, "Default/IndexedDB");
    const destination = resolve(process.env.SURFWAX_EVIDENCE_PATH ?? "../.dev/chromium-profile/Default/IndexedDB", basename(directory));
    if (existsSync(source)) {
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true });
      await writeFile(resolve(destination, "test-evidence.json"), JSON.stringify({ title: info.titlePath, status: info.status, browser: process.env.SURFWAX_CHROME_VERSION ?? context.browser()?.version() ?? "unknown", project: info.project.name, profile: directory }, null, 2));
      await info.attach("canonical-log-location", { body: destination, contentType: "text/plain" });
    }
    if (info.status === info.expectedStatus) await rm(directory, { recursive: true, force: true });
  }
  testProfiles.clear();
});

export async function openExtension(existingDirectory?: string, settings: { extensionPath?: string; executablePath?: string; deviceScaleFactor?: number; args?: string[] } = {}): Promise<{
  context: BrowserContext;
  extensionId: string;
  page: Page;
  userDataDirectory: string;
}> {
  const userDataDirectory = existingDirectory ?? await mkdtemp(resolve(tmpdir(), "side-agent-e2e-"));
  const extensionPath = resolve(settings.extensionPath ?? process.env.SURFWAX_EXTENSION_PATH ?? "dist");
  const bundledChromium = chromium.executablePath();
  const systemChrome = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome";
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: settings.executablePath ?? test.info().project.use.launchOptions?.executablePath ?? process.env.SURFWAX_CHROME_PATH ?? (existsSync(bundledChromium) ? bundledChromium : systemChrome),
    headless: process.env.SURFWAX_E2E_HEADLESS !== "false",
    deviceScaleFactor: settings.deviceScaleFactor,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", ...(settings.args ?? [])],
  });
  testProfiles.set(userDataDirectory, context);
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { context, extensionId, page, userDataDirectory };
}

export async function dispose(context: BrowserContext, directory: string, server?: Server): Promise<void> {
  await context.close();
  if (server) await closeServer(server);
}

/** Reload an unpacked installation after replacing its files, as Chrome's
 * extension Reload action does. Restarting Chrome can reuse the prior SW cache. */
export async function reloadUpgradedExtension(opened: Awaited<ReturnType<typeof openExtension>>): Promise<void> {
  const settings = await opened.context.newPage();
  await settings.goto("chrome://extensions/");
  const developerMode = settings.locator("extensions-toolbar #devMode");
  await expect(developerMode).toBeVisible();
  if (await developerMode.evaluate((element) => element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed")) !== "true") await developerMode.click();
  await settings.close();
  await opened.page.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  if (!opened.page.isClosed()) await opened.page.close().catch(() => undefined);
  opened.page = await opened.context.newPage();
  // Reload briefly unregisters the extension; navigation during that interval
  // is blocked. Opening the panel also starts its lazy MV3 worker.
  await expect(async () => {
    await opened.page.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
  }).toPass({ timeout: 10_000 });
  await expect(opened.page.getByTestId("composer-input")).toBeVisible();
}

export async function selectProvider(options: Page, query: string, optionName: string | RegExp): Promise<void> {
  const input = options.getByLabel("Provider", { exact: true });
  await input.click();
  await input.fill(query);
  await options.getByRole("option", { name: optionName }).click();
}

export async function configure(context: BrowserContext, page: Page, baseURL: string, contextWindow = 1_000_000): Promise<Page> {
  const [options] = await Promise.all([context.waitForEvent("page"), page.getByTestId("open-settings").click()]);
  await options.waitForLoadState("domcontentloaded");
  await selectProvider(options, "custom", /自定义 Endpoint.*custom/);
  await options.getByLabel("Base URL", { exact: true }).fill(baseURL);
  await options.getByLabel("Model ID", { exact: true }).fill("test-model");
  await options.getByLabel("API Key", { exact: true }).fill("test-key");
  await options.getByText("高级设置", { exact: true }).click();
  await options.getByLabel("窗口大小（tokens）").fill(String(contextWindow));
  await options.getByRole("button", { name: "保存配置" }).click();
  await expect(options.getByRole("status")).toContainText("配置已保存");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  return options;
}

/** The settings tab can still own native focus; activate the tested surface first. */
export async function focusPageControl(page: Page, control: Locator): Promise<void> {
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await control.evaluate((element) => (element as HTMLElement).blur());
  await control.focus();
  await expect(control).toBeFocused();
}

export async function themeColors(page: Page, selectors: string[]): Promise<{ colorScheme: string; colors: { background: string; foreground: string }[] }> {
  return page.evaluate((targets) => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    colors: targets.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing theme target: ${selector}`);
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, foreground: style.color };
    }),
  }), selectors);
}

export async function expectThemeButton(locator: Locator, colorScheme: "light" | "dark", variant: "default" | "destructive") {
  const expected = variant === "destructive"
    ? colorScheme === "light" ? { background: "rgb(185, 28, 28)", foreground: "rgb(255, 255, 255)" } : { foreground: "rgb(255, 255, 255)" }
    : colorScheme === "light" ? { background: "rgb(23, 23, 23)", foreground: "rgb(255, 255, 255)" }
      : { background: "rgb(245, 245, 245)", foreground: "rgb(24, 24, 24)" };
  await expect.poll(() => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
  })).toMatchObject({ ...expected, fontSize: "14px", fontWeight: "500" });
}

export async function startNewConversation(page: Page): Promise<void> {
  if (await page.locator(".conversation-dialog").isVisible()) await page.keyboard.press("Escape");
  await page.getByTestId("new-conversation").click();
  await expect(page.getByTestId("conversation-menu")).toContainText("新对话");
  await expect(page.getByTestId("composer-input")).toBeEnabled();
}

/** Seed a named, idle conversation before a run. UI mutation itself is tested separately. */
export async function nameCurrentConversation(page: Page, title: string): Promise<void> {
  const id = await page.evaluate(async (title) => {
    const id = crypto.randomUUID();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("side-agent-runtime");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const timestamp = new Date().toISOString();
    store.add({ type: "conversation.created", conversationId: id, timestamp, content: null });
    store.add({ type: "conversation.title.updated", conversationId: id, timestamp, content: { title, source: "manual" } });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close(); return id;
  }, title);
  await page.reload();
  await page.getByTestId("conversation-menu").click();
  await page.locator(".conversation-item", { hasText: title }).locator(".conversation-select").click();
  await expect(page.getByTestId("conversation-menu")).toContainText(title);
}

export async function enableUserScripts(context: BrowserContext, extensionId: string, extensionPage: Page): Promise<void> {
  if (await extensionPage.evaluate(() => typeof chrome.userScripts === "object")) return;
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${extensionId}`);
  const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
  await expect(toggle).toBeVisible();
  if (await toggle.evaluate((element) => element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect.poll(() => extensionPage.evaluate(() => typeof chrome.userScripts)).toBe("object");
  await settings.close();
}

export async function readEvents(page: Page): Promise<any[]> {
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

export async function attachTarget(browserSession: CDPSession, targetId: string) {
  const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId, flatten: false });
  let requestId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const receive = ({ sessionId: incoming, message }: { sessionId: string; message: string }) => {
    if (incoming !== sessionId) return;
    const response = JSON.parse(message);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  };
  browserSession.on("Target.receivedMessageFromTarget", receive);
  const send = <T = any>(method: string, params: object = {}) => new Promise<T>((resolveSend, rejectSend) => {
    const id = ++requestId;
    pending.set(id, { resolve: resolveSend, reject: rejectSend });
    void browserSession.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(rejectSend);
  });
  return {
    send,
    async evaluate<T>(expression: string): Promise<T> {
      const response = await send<any>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value as T;
    },
    async close() {
      browserSession.off("Target.receivedMessageFromTarget", receive);
      await browserSession.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    },
  };
}

export async function warnsOnLeave(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}


export { expect, test, chromium };

export async function openNativeSidePanel(opened: Awaited<ReturnType<typeof openExtension>>, targetURL: string,
  settings: { browser?: CDPSession; windowId?: number } = {}) {
  const browser = settings.browser ?? await opened.context.browser()!.newBrowserCDPSession();
  const panelURL = `chrome-extension://${opened.extensionId}/sidepanel.html`;
  const isPanel = (info: { type: string; url: string }) => info.type !== 'tab' && info.url.split(/[?#]/, 1)[0] === panelURL;
  const harness = opened.page.isClosed() ? await opened.context.newPage() : opened.page;
  if (harness !== opened.page) await harness.goto(`chrome-extension://${opened.extensionId}/options.html`);
  const chromeTabs = await harness.evaluate(({ url, windowId }) => chrome.tabs.query({ url, ...(windowId !== undefined ? { windowId } : {}) }),
    { url: targetURL, windowId: settings.windowId });
  const chromeTab = chromeTabs[0];
  if (!chromeTab?.id || chromeTab.windowId === undefined) throw new Error('Native panel Chrome tab not found');
  const windowId = chromeTab.windowId;
  const panelsBefore = new Set((await browser.send('Target.getTargets')).targetInfos
    .filter(isPanel).map(info => info.targetId));
  try {
    const tabs = await browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    const tab = tabs.targetInfos.find(item => item.url === targetURL);
    if (!tab) throw new Error('Native panel target tab not found');
    await browser.send('Extensions.triggerAction', { id: opened.extensionId, targetId: tab.targetId });
  } catch (error) {
    if (!/Extensions\.triggerAction.*(?:wasn't found|not found)|method not found/i.test(String(error))) throw error;
    // Chrome 138 does not expose the CDP Extensions domain. A real click on an
    // extension button supplies the user gesture required by SidePanel.open.
    await harness.evaluate((owningWindowId) => {
      const button = document.createElement('button');
      button.id = 'e2e-open-native-panel'; button.textContent = 'Open native panel';
      button.style.cssText = 'position:fixed;inset:8px auto auto 8px;z-index:2147483647;padding:12px';
      button.onclick = () => { void chrome.sidePanel.open({ windowId: owningWindowId }).then(
        () => { button.dataset.result = 'opened'; }, (failure) => { button.dataset.error = String(failure); }); };
      document.body.append(button);
    }, windowId);
    await harness.bringToFront();
    await harness.locator('#e2e-open-native-panel').click();
    await expect(harness.locator('#e2e-open-native-panel')).toHaveAttribute('data-result', 'opened');
  }
  await harness.evaluate(async ({ tabId, windowId }) => {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  }, { tabId: chromeTab.id, windowId });
  let targetId = '';
  await expect.poll(async () => {
    targetId = (await browser.send('Target.getTargets')).targetInfos.find(item => isPanel(item)
      && !panelsBefore.has(item.targetId))?.targetId ?? '';
    return targetId;
  }).not.toBe('');
  const panel = await attachTarget(browser, targetId);
  await expect.poll(() => panel.evaluate<boolean>('Boolean(document.querySelector("[data-testid=composer-input]"))')).toBe(true);
  await harness.close();
  return { browser, panel, targetId, windowId, tabId: chromeTab.id };
}
export async function nativePanel(opened: Awaited<ReturnType<typeof openExtension>>, targetURL: string, settings: { target?: Page } = {}) {
  const target = settings.target ?? await opened.context.newPage();
  if (!settings.target) await target.goto(targetURL);
  return { target, ...await openNativeSidePanel(opened, targetURL) };
}
export async function submitNative(panel: Awaited<ReturnType<typeof attachTarget>>, text: string) {
  await panel.evaluate('document.querySelector("[data-testid=composer-input]").focus()');
  await panel.send('Input.insertText', { text });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
}

export async function readNativeEvents(panel: Awaited<ReturnType<typeof attachTarget>>): Promise<any[]> {
  return panel.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('side-agent-runtime');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const all = db.transaction('events', 'readonly').objectStore('events').getAll();
      all.onerror = () => { db.close(); reject(all.error); };
      all.onsuccess = () => { db.close(); resolve(all.result); };
    };
  })`);
}
