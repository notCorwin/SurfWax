import { chromium, expect, test as base, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { systemChromePath } from "../scripts/development-extension.mjs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json",
};

type CompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: Record<string, unknown> & { role: "assistant" };
    finish_reason: "stop" | "tool_calls";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
  };
};

function completion(message: Record<string, unknown>, usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): CompletionResponse {
  const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return {
    id: "chatcmpl-side-agent-e2e",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    ...(usage ? { usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
    } } : {}),
  };
}

export function textResponse(text: string, usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): CompletionResponse {
  return completion({ content: text }, usage);
}

export function assistantResponse(message: Record<string, unknown>, usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): CompletionResponse {
  return completion(message, usage);
}

export function commandResponse(name: string, input: object, id: string, content?: string): CompletionResponse {
  return completion({ ...(content ? { content } : {}), tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
}

export type MockResponse = CompletionResponse | { status: number; error: string } | {
  response: CompletionResponse; delayMs?: number; startAfter?: Promise<void>;
} | ((request: any) => CompletionResponse);

export function delayedResponse(response: CompletionResponse, delayMs: number, startAfter?: Promise<void>) {
  return { response, delayMs, ...(startAfter ? { startAfter } : {}) };
}

const providerRequests: any[][] = [];

export async function startProvider(responses: MockResponse[], delayMs = 0, summaryText?: string, supportedEfforts = ["minimal", "low", "medium", "high", "xhigh"], summaryDelayMs = 0, summaryFailures = 0, reviewResponses: string[] = []): Promise<{
  baseURL: string;
  origin: string;
  requests: any[];
  server: Server;
  stats: { abortedResponses: number; summaryCalls: number; summaryFailures: number };
}> {
  const requests: any[] = [];
  providerRequests.push(requests);
  const stats = { abortedResponses: 0, summaryCalls: 0, summaryFailures };
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
    if (request.method === "GET" && pathname === "/automation") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Automation Target</title><label>Email <input type="email"></label><button onclick="document.querySelector('output').textContent='Welcome '+document.querySelector('input').value">Sign in</button><output></output>`);
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
      // Scripted-provider tests exercise browser/evidence plumbing, not an LLM
      // judge. Keep the independent review request out of their action queue.
      // Real-model evaluation forwards this request to the configured model.
      if (requestBody.messages?.some((message: any) => message.role === "system" && String(message.content).startsWith("SURFWAX_GOAL_REVIEW"))) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(textResponse(reviewResponses.shift() ?? JSON.stringify({ accept: true, reason: "Scripted provider acknowledges the supplied goal", remaining: [] }))));
        return;
      }
      const isSummary = summaryText && JSON.stringify(requestBody).includes("Summarize the entire supplied conversation faithfully");
      if (isSummary) {
        stats.summaryCalls += 1;
        if (stats.summaryFailures > 0) {
          stats.summaryFailures -= 1;
          response.writeHead(400, JSON_HEADERS);
          response.end(JSON.stringify({ error: { message: "Summary generation rejected for this test" } }));
          return;
        }
        setTimeout(() => {
          response.writeHead(200, JSON_HEADERS);
          response.end(JSON.stringify(completion({ content: summaryText }, { promptTokens: 100, completionTokens: 20 })));
        }, summaryDelayMs);
        return;
      }
      const queued = responses.shift();
      if (!queued) {
        response.writeHead(500, JSON_HEADERS);
        response.end(JSON.stringify({ error: { message: "No mock response remains" } }));
        return;
      }
      const output = typeof queued === "function" ? queued(requestBody) : queued;
      if ("status" in output) {
        response.writeHead(output.status, JSON_HEADERS);
        response.end(JSON.stringify({ error: { message: output.error } }));
        return;
      }
      const wrapped = "response" in output ? output : undefined;
      const finalResponse = wrapped?.response ?? output as CompletionResponse;
      let timer: ReturnType<typeof setTimeout> | undefined;
      response.on("close", () => {
        if (!response.writableEnded) {
          stats.abortedResponses += 1;
          if (timer !== undefined) clearTimeout(timer);
        }
      });
      void (wrapped?.startAfter ?? Promise.resolve()).then(() => {
        timer = setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, JSON_HEADERS);
          response.end(JSON.stringify(finalResponse));
        }, wrapped?.delayMs ?? delayMs);
      }, () => response.destroy());
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

const testProfiles = new Map<string, { context: BrowserContext; browserVersion: string }>();

export const test = base.extend<{ _profileCleanup: void }>({
  _profileCleanup: [async ({}, use, info) => {
    await use();
    for (const [directory, profile] of testProfiles) {
      const { context, browserVersion } = profile;
      await context.close().catch(() => undefined);
      const source = resolve(directory, "Default/IndexedDB");
      const destination = resolve(process.env.SURFWAX_EVIDENCE_PATH ?? info.outputPath("canonical-logs"), basename(directory));
      if (existsSync(source)) {
        await mkdir(destination, { recursive: true });
        await cp(source, destination, { recursive: true });
        await writeFile(resolve(destination, "test-evidence.json"), JSON.stringify({ title: info.titlePath, status: info.status, browser: browserVersion, project: info.project.name, profile: directory }, null, 2));
        await info.attach("canonical-log-location", { body: destination, contentType: "text/plain" });
      }
      if (info.status === info.expectedStatus) await rm(directory, { recursive: true, force: true });
    }
    testProfiles.clear();
  }, { auto: true }],
});

test.afterEach(() => {
  const requests = providerRequests.splice(0).flat();
  expect(requests.filter((request) => request.stream === true)).toEqual([]);
});

export async function openExtension(existingDirectory?: string, settings: { extensionPath?: string; executablePath?: string; deviceScaleFactor?: number; viewport?: { width: number; height: number } | null; args?: string[] } = {}): Promise<{
  context: BrowserContext;
  extensionId: string;
  page: Page;
  userDataDirectory: string;
}> {
  const extensionPath = resolve(settings.extensionPath ?? process.env.SURFWAX_EXTENSION_PATH ?? "dist");
  const executablePath = systemChromePath({ ...process.env,
    SURFWAX_CHROME_PATH: settings.executablePath ?? test.info().project.use.launchOptions?.executablePath ?? process.env.SURFWAX_CHROME_PATH });
  const userDataDirectory = existingDirectory ?? await mkdtemp(resolve(tmpdir(), "side-agent-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath,
    headless: true,
    chromiumSandbox: true,
    colorScheme: null,
    viewport: settings.viewport === undefined ? { width: 1280, height: 720 } : settings.viewport,
    deviceScaleFactor: settings.deviceScaleFactor,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--hide-crash-restore-bubble", ...(settings.args ?? [])],
  });
  const browserSession = await context.browser()!.newBrowserCDPSession();
  let extensionId: string;
  try {
    ({ id: extensionId } = await browserSession.send("Extensions.loadUnpacked", { path: extensionPath }));
  } catch (error) {
    await context.close();
    throw new Error(`Cannot load the development extension in installed Chrome. Update Google Chrome and check ${extensionPath}/manifest.json.`, { cause: error });
  }
  testProfiles.set(userDataDirectory, {
    context,
    browserVersion: process.env.SURFWAX_CHROME_VERSION ?? context.browser()?.version() ?? "unknown",
  });
  if (!context.serviceWorkers().some(worker => new URL(worker.url()).hostname === extensionId))
    await context.waitForEvent("serviceworker", { predicate: worker => new URL(worker.url()).hostname === extensionId });
  const page = await context.newPage();
  await browserSession.detach();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { context, extensionId, page, userDataDirectory };
}

export async function dispose(context: BrowserContext, directory: string, server?: Server): Promise<void> {
  await context.close();
  if (server) await closeServer(server);
}

export async function selectProvider(options: Page, query: string, optionName: string | RegExp): Promise<void> {
  const input = options.getByLabel("Provider", { exact: true });
  await input.click();
  await input.fill(query);
  await options.getByRole("option", { name: optionName }).click();
}

export async function configure(context: BrowserContext, page: Page, baseURL: string, contextWindow = 1_000_000, settings: { goalMode?: boolean } = { goalMode: false }): Promise<Page> {
  // Development pages can reload while CRXJS initializes. Wait for the app
  // before executing storage operations in its document context.
  await expect(page.getByTestId("open-settings")).toBeVisible();
  if (settings.goalMode !== undefined) await page.evaluate((goalMode) => chrome.storage.local.set({ "side-agent:goal-mode": goalMode }), settings.goalMode);
  const [options] = await Promise.all([context.waitForEvent("page"), page.getByTestId("open-settings").click()]);
  await options.waitForLoadState("domcontentloaded");
  await selectProvider(options, "custom", /自定义 Endpoint.*custom/);
  await options.getByText("高级设置", { exact: true }).click();
  await options.getByLabel("Base URL", { exact: true }).fill(baseURL);
  await options.getByLabel("Model ID", { exact: true }).fill("test-model");
  await options.getByLabel("API Key", { exact: true }).fill("test-key");
  await options.getByLabel("上下文窗口（tokens）").fill(String(contextWindow));
  await options.getByRole("button", { name: "保存配置" }).click();
  // Saving can settle directly into the clean state after storage.onChanged.
  // Verify the durable configuration rather than a transient success message.
  await expect.poll(() => options.evaluate(async () => {
    const stored = (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"] as import("../src/sidepanel/config").PersistedModelConfig | undefined;
    return stored?.profiles?.[stored.selectedProviderId];
  })).toMatchObject({ model: "test-model", contextWindowOverride: contextWindow, providerSettings: { apiKey: "test-key" }, baseURL });
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

export async function startNewConversation(page: Page): Promise<void> {
  if (await page.locator(".conversation-dropdown").isVisible()) await page.keyboard.press("Escape");
  await page.getByTestId("new-conversation").click();
  await expect(page.getByTestId("conversation-menu")).toContainText("新对话");
  await expect(page.getByTestId("composer-input")).toBeEnabled();
}

export async function enableUserScripts(context: BrowserContext, extensionId: string, extensionPage: Page): Promise<void> {
  if (await extensionPage.evaluate(() => typeof chrome.userScripts === "object")) return;
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${extensionId}`);
  const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
  await expect(toggle).toBeVisible();
  if (await toggle.evaluate((element) => element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed")) !== "true") {
    await Promise.all([extensionPage.waitForEvent("load"), toggle.click()]);
  }
  await expect.poll(() => extensionPage.evaluate(() => typeof chrome.userScripts)).toBe("object");
  await settings.close();
}

export async function readEvents(page: Page): Promise<any[]> {
  const events = await page.evaluate<any[]>(() => new Promise((resolveEvents, reject) => {
    const request = indexedDB.open("side-agent-runtime");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("events", "readonly");
      const all = transaction.objectStore("events").getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolveEvents(all.result);
    };
  }));
  expect(events.filter((event) => event.type === "conversation.stream.chunk")).toEqual([]);
  return events;
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


export { expect, chromium };

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
  try { await expect.poll(() => panel.evaluate<boolean>('Boolean(document.querySelector("[data-testid=composer-input]"))')).toBe(true); }
  catch (cause) {
    const body = await panel.evaluate<string>('document.body?.innerText || ""').catch(() => "Native panel renderer is unavailable");
    throw new Error(`Native side panel did not become ready: ${body.slice(0, 2000)}`, { cause });
  }
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
  const events = await panel.evaluate<any[]>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('side-agent-runtime');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const all = db.transaction('events', 'readonly').objectStore('events').getAll();
      all.onerror = () => { db.close(); reject(all.error); };
      all.onsuccess = () => { db.close(); resolve(all.result); };
    };
  })`);
  expect(events.filter((event) => event.type === "conversation.stream.chunk")).toEqual([]);
  return events;
}
