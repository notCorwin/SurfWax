import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

function usageChunk(promptTokens: number, completionTokens: number, cachedTokens = 0): string {
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

function textResponse(text: string, usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  return [chunk({ role: "assistant", content: text }), chunk({}, "stop"),
    ...(usage ? [usageChunk(usage.promptTokens, usage.completionTokens, usage.cachedTokens)] : []), "data: [DONE]\n\n"];
}

function streamingTextResponse(parts: string[], usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  return [
    ...parts.map((content, index) => chunk({ ...(index === 0 ? { role: "assistant" } : {}), content })),
    chunk({}, "stop"),
    ...(usage ? [usageChunk(usage.promptTokens, usage.completionTokens, usage.cachedTokens)] : []),
    "data: [DONE]\n\n",
  ];
}

function toolResponse(code: string | { code: string; tabId?: number; world?: "MAIN" | "USER_SCRIPT"; target?: { kind: string; tabId?: number; world?: string } }, id = "call-chrome-e2e", usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string[] {
  const body = typeof code === "string" ? code : code.code;
  const input = { code: `async page => { ${body} }` };
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

function pageResponse(code: string, tabId: number, id = "call-page-e2e"): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name: "run-code", arguments: JSON.stringify({ code: `async page => { ${code} }` }) } }],
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

function commandResponse(name: string, input: object, id: string): string[] {
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }),
    chunk({}, "tool_calls"), "data: [DONE]\n\n",
  ];
}

function browserResponse(input: object, id: string): string[] {
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "browser", arguments: JSON.stringify(input) } }] }),
    chunk({}, "tool_calls"), "data: [DONE]\n\n",
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
        function: { name: "run-code", arguments: JSON.stringify({ code: `async page => { ${code} }` }) },
      })),
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
}

type MockResponse = string[] | { status: number; error: string } | ((request: any) => string[]);

async function startProvider(responses: MockResponse[], delayMs = 0, summaryText?: string, supportedEfforts = ["minimal", "low", "medium", "high", "xhigh"], summaryDelayMs = 0): Promise<{
  baseURL: string;
  origin: string;
  requests: any[];
  jevRequests: any[];
  server: Server;
  stats: { abortedResponses: number };
}> {
  const requests: any[] = [];
  const jevRequests: any[] = [];
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
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-model", reasoning: { supported_efforts: supportedEfforts } }] }));
      return;
    }
    if (request.method === "GET" && request.url === "/target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Side Agent Target</title><main>ready</main>");
      return;
    }
    if (request.method === "GET" && request.url === "/automation") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Automation Target</title><label>Email <input type="email"></label><button onclick="document.querySelector('output').textContent='Welcome '+document.querySelector('input').value">Sign in</button><output></output>`);
      return;
    }
    if (request.method === "GET" && request.url === "/visual") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Visual Target</title><style>button{position:fixed;left:20px;top:20px;width:100px;height:50px}</style><canvas width=200 height=100></canvas><button aria-hidden=true onclick=\"document.body.dataset.clicked='yes'\">Visual action</button>");
      return;
    }
    if (request.method === "GET" && request.url === "/performance") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Performance Target</title><button onclick=\"document.querySelector('output').value=String(Number(document.querySelector('output').value)+1)\">Increment</button><output>0</output>");
      return;
    }
    if (request.method === "GET" && request.url === "/automation-dynamic") {
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
    if (request.method === "GET" && request.url === "/complex") {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server is not listening");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Before Navigation</title><style>iframe[src*=localhost]{transform:translate(24px,12px) scale(.8);transform-origin:0 0}</style><iframe src="/same-frame"></iframe><iframe src="http://localhost:${address.port}/frame"></iframe>`);
      return;
    }
    if (request.method === "GET" && request.url === "/same-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Same Process Frame</title><main>same origin</main>");
      return;
    }
    if (request.method === "GET" && request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Cross Origin Frame</title><main>frame ready <button onclick=\"document.body.dataset.clicked='yes'\">Frame action</button></main>");
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
    if (request.method === "POST" && request.url === "/v1/systemone") {
      const body: Buffer[] = [];
      request.on("data", (part) => body.push(part));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(body).toString("utf8"));
        jevRequests.push(payload);
        response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
        response.end(JSON.stringify({ model: "jev-test", answers: Object.fromEntries(
          Object.keys(payload.questions).map((key) => [key, { type: "noul", noul: 0.1 }]),
        ), usage: { input_tokens: 100, output_tokens: 1 } }));
      });
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
      const parts = typeof queued === "function" ? queued(requestBody) : queued;
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
  return { baseURL: `${origin}/v1`, origin, requests, jevRequests, server, stats };
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
  const bundledChromium = chromium.executablePath();
  const systemChrome = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome";
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: existsSync(bundledChromium) ? bundledChromium : systemChrome,
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

async function selectProvider(options: Page, query: string, optionName: string | RegExp): Promise<void> {
  const input = options.getByLabel("Provider", { exact: true });
  await input.click();
  await input.fill(query);
  await options.getByRole("option", { name: optionName }).click();
}

async function configure(context: BrowserContext, page: Page, baseURL: string, contextWindow = 1_000_000): Promise<Page> {
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

async function startNewConversation(page: Page): Promise<void> {
  if (await page.locator(".conversation-dialog").isVisible()) await page.keyboard.press("Escape");
  await page.getByTestId("new-conversation").click();
}

async function nameCurrentConversation(page: Page, title: string): Promise<void> {
  await page.getByTestId("conversation-menu").click();
  await page.getByRole("button", { name: /^重命名 / }).first().click();
  await page.getByRole("textbox", { name: "会话名称" }).fill(title);
  await page.getByRole("textbox", { name: "会话名称" }).press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("conversation-menu")).toContainText(title);
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

async function attachTarget(browserSession: CDPSession, targetId: string) {
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

async function warnsOnLeave(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test("shows the configured model at the bottom left of the composer", async () => {
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, "https://example.com/v1");
    await expect(opened.page.getByTestId("composer-model")).toHaveText("Test Model");
    await options.getByLabel("Model ID", { exact: true }).fill("google/gemini-3.8-flash");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(opened.page.getByTestId("composer-model")).toHaveText("Gemini 3.8 Flash");
    await expect(opened.page.getByTestId("composer-model")).toHaveAttribute("title", "google/gemini-3.8-flash");
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("restores independent credentials and models when switching Providers", async () => {
  const opened = await openExtension();
  try {
    await opened.page.evaluate(() => chrome.storage.local.set({ "side-agent:model-catalog": { fetchedAt: Date.now(), catalog: {
      vercel: { name: "Vercel AI Gateway", npm: "@ai-sdk/gateway", models: {
        "openai/gpt-test": { name: "GPT Test", tool_call: true, modalities: { output: ["text"] }, limit: { context: 100_000 } },
      } },
    } } }));
    const [options] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await options.waitForLoadState("domcontentloaded");

    await expect(options.getByText("已载入 1 个内置 Provider；每个 Provider 独立保存配置。")).toBeVisible();
    await options.getByLabel("Provider", { exact: true }).click();
    await expect(options.getByRole("option", { name: /自定义 Endpoint.*custom/ })).toBeVisible();
    await expect(options.getByRole("option", { name: /Vercel AI Gateway.*vercel/ })).toBeVisible();
    await options.getByLabel("Provider", { exact: true }).fill("Gateway");
    await options.getByRole("option", { name: /Vercel AI Gateway.*vercel/ }).click();
    await expect(options.getByLabel("Provider", { exact: true })).toHaveValue("Vercel AI Gateway (vercel)");
    await expect(options.getByText("https://ai-gateway.vercel.sh/v4/ai", { exact: true })).toBeVisible();
    await options.getByLabel("Model ID", { exact: true }).fill("GPT Test");
    await options.getByRole("option", { name: /GPT Test.*openai\/gpt-test/ }).click();
    await options.getByLabel("API Key", { exact: true }).fill("vercel-key");
    await options.getByRole("button", { name: "保存配置" }).click();

    await selectProvider(options, "custom", /自定义 Endpoint.*custom/);
    await options.getByLabel("Base URL", { exact: true }).fill("https://custom.test/v1");
    await options.getByLabel("Model ID", { exact: true }).fill("custom-model");
    await options.getByLabel("API Key", { exact: true }).fill("custom-key");
    await options.getByRole("button", { name: "保存配置" }).click();

    const providerInput = options.getByLabel("Provider", { exact: true });
    await providerInput.click();
    await providerInput.fill("vercel");
    await providerInput.press("ArrowDown");
    await options.getByRole("option", { name: /Vercel AI Gateway.*vercel/ }).press("Enter");
    await expect(options.getByLabel("Model ID", { exact: true })).toHaveValue("openai/gpt-test");
    await expect(options.getByLabel("API Key", { exact: true })).toHaveValue("vercel-key");
    await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"]))
      .toMatchObject({ profiles: {
        vercel: { providerSettings: { apiKey: "vercel-key" }, model: "openai/gpt-test", sdk: "@ai-sdk/gateway" },
        custom: { providerSettings: { apiKey: "custom-key" }, model: "custom-model", baseURL: "https://custom.test/v1", sdk: "@ai-sdk/openai-compatible" },
      } });
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("persists multi-field credentials and interpolates template Endpoints", async () => {
  const opened = await openExtension();
  try {
    await opened.page.evaluate(() => chrome.storage.local.set({ "side-agent:model-catalog": { fetchedAt: Date.now(), catalog: {
      bedrock: { name: "Amazon Bedrock", npm: "@ai-sdk/amazon-bedrock", models: {} },
      template: { name: "Template Provider", npm: "@ai-sdk/openai-compatible", api: "https://api.example/${ACCOUNT}/v1", models: {} },
    } } }));
    const [options] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await options.waitForLoadState("domcontentloaded");

    await selectProvider(options, "bedrock", /Amazon Bedrock.*bedrock/);
    await options.getByLabel("Model ID", { exact: true }).fill("anthropic.test");
    await options.getByLabel("Region", { exact: true }).fill("us-east-1");
    await options.getByLabel("Bearer Token", { exact: true }).fill("bedrock-token");
    await options.getByRole("button", { name: "保存配置" }).click();

    await selectProvider(options, "template", /Template Provider.*template/);
    await options.getByLabel("Model ID", { exact: true }).fill("agent-model");
    await options.getByLabel("API Key", { exact: true }).fill("template-key");
    await options.getByLabel("ACCOUNT", { exact: true }).fill("tenant");
    await expect(options.getByText("https://api.example/tenant/v1", { exact: true })).toBeVisible();
    await options.getByRole("button", { name: "保存配置" }).click();

    await selectProvider(options, "bedrock", /Amazon Bedrock.*bedrock/);
    await expect(options.getByLabel("Region", { exact: true })).toHaveValue("us-east-1");
    await expect(options.getByLabel("Bearer Token", { exact: true })).toHaveValue("bedrock-token");
    await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"]))
      .toMatchObject({ profiles: {
        bedrock: { providerSettings: { region: "us-east-1", apiKey: "bedrock-token" } },
        template: { providerSettings: { apiKey: "template-key", ACCOUNT: "tenant" } },
      } });
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("keeps custom Endpoint available when the Models.dev catalog fails", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route("https://models.dev/api.json", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    const [options] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await options.waitForLoadState("domcontentloaded");
    await expect(options.getByText("Models.dev 暂时不可用；仍可选择 custom 使用自定义 Endpoint。")).toBeVisible();
    await selectProvider(options, "custom", /自定义 Endpoint.*custom/);
    await expect(options.getByLabel("Base URL", { exact: true })).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("saves and disables the optional Jev selector configuration", async () => {
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, "https://provider.test/v1");
    await expect(options.getByRole("group", { name: "上下文窗口" })).toBeVisible();
    await expect(options.getByRole("group", { name: "Jev 消息选择压缩（可选）" })).toBeVisible();
    await options.getByLabel("Jev 平台").focus();
    await options.getByLabel("Jev 平台").press("Enter");
    await options.getByRole("option", { name: "OpenRouter" }).press("Enter");
    await expect(options.getByLabel("Jev Base URL")).toHaveValue("https://openrouter.ai/api");
    await expect(options.getByLabel("Jev Model ID")).toHaveValue("typesafe/jev-1.13");
    await options.getByLabel("Jev Base URL").fill("not-a-url");
    await options.getByLabel("Jev Model ID").fill("jev-test");
    await options.getByLabel("Jev API Key").fill("jev-key");
    await options.getByLabel("最低保留评分").fill("0.81");
    await options.getByText("高级设置", { exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.locator(".advanced-settings")).toHaveAttribute("open", "");
    await expect(options.locator("#jev-base-url-error")).toHaveText("请输入有效的 Jev 网址");
    await expect(options.locator("#jev-base-url")).toBeFocused();
    await options.getByLabel("Jev Base URL").fill("https://jev.example/v1");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get("side-agent:jev-config"))["side-agent:jev-config"])).toEqual({
      provider: "openrouter",
      baseURL: "https://jev.example/v1",
      model: "jev-test",
      apiKey: "jev-key",
      threshold: 0.81,
    });
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();

    await options.getByLabel("Jev API Key").fill("");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get("side-agent:jev-config"))["side-agent:jev-config"])).toEqual({
      provider: "openrouter",
      baseURL: "https://jev.example/v1",
      model: "jev-test",
      apiKey: "",
      threshold: 0.81,
    });
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("shows inline settings errors and returns keyboard focus after closing conversations", async () => {
  const opened = await openExtension();
  try {
    const [options] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click(),
    ]);
    const disclosure = options.locator(".advanced-settings");
    await expect(disclosure.locator("summary")).toBeVisible();
    expect(await options.evaluate(() => {
      const summary = getComputedStyle(document.querySelector(".advanced-settings summary")!);
      const label = getComputedStyle(document.querySelector('[data-slot="field-label"]')!);
      return [summary.color, summary.fontSize, summary.fontWeight, summary.lineHeight].join("|")
        === [label.color, label.fontSize, label.fontWeight, label.lineHeight].join("|");
    })).toBe(true);
    await disclosure.locator("summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.locator("#provider-id-error")).toHaveText("请选择 Provider");
    await selectProvider(options, "custom", /自定义 Endpoint.*custom/);
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.locator("#base-url-error")).toHaveText("请输入 Base URL");
    await expect(options.locator("#base-url")).toBeFocused();
    expect(await options.locator("#base-url").evaluate((input) => getComputedStyle(input).outlineStyle)).toBe("none");
    await expect(options.locator("#base-url")).toHaveAttribute("aria-invalid", "true");
    await options.setViewportSize({ width: 320, height: 720 });
    expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await options.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(await options.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
    await options.getByRole("link", { name: "跳转到配置" }).focus();
    await options.keyboard.press("Enter");
    await expect(options.locator("#options-content")).toBeFocused();
    await options.getByLabel("Base URL", { exact: true }).fill("https://provider.test/v1");
    await options.getByLabel("Model ID", { exact: true }).fill("test-model");
    await options.getByLabel("API Key", { exact: true }).fill("test-key");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(opened.page.getByTestId("conversation-menu")).toBeVisible();
    await expect(opened.page.locator(".app-header").getByTestId("new-conversation")).toBeVisible();
    expect(await warnsOnLeave(options)).toBe(false);
    await options.getByLabel("Model ID", { exact: true }).fill("another-model");
    expect(await warnsOnLeave(options)).toBe(true);
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    expect(await warnsOnLeave(options)).toBe(false);
    await opened.page.setViewportSize({ width: 320, height: 720 });
    expect(await opened.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await opened.page.getByRole("link", { name: "跳转到内容" }).focus();
    await opened.page.keyboard.press("Enter");
    await expect(opened.page.locator("#chat-content")).toBeFocused();
    const trigger = opened.page.getByTestId("conversation-menu");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(opened.page.getByRole("dialog", { name: "对话列表" })).toBeVisible();
    await opened.page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await opened.page.setViewportSize({ width: 1440, height: 900 });
    expect(await opened.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    let leavePrompts = 0;
    options.on("dialog", (dialog) => { leavePrompts += 1; void dialog.dismiss(); });
    await options.reload();
    expect(leavePrompts).toBe(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("selects, locks and restores reasoning effort across conversations", async () => {
  const provider = await startProvider([
    textResponse("FIRST_EFFORT_REPLY"), textResponse("第一档位标题"),
    textResponse("SECOND_EFFORT_REPLY"), textResponse("第二档位标题"),
  ], 40, undefined, ["none", "low", "high"]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const effort = opened.page.getByTestId("reasoning-effort");
    await expect(effort).toHaveText("关闭");
    await effort.click();
    await expect(opened.page.getByRole("option")).toHaveText(["关闭", "低", "高"]);
    await opened.page.getByRole("option", { name: "高" }).click();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first effort");
    await composer.press("Enter");
    await expect(effort).toBeDisabled();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_EFFORT_REPLY");
    await expect(effort).toBeEnabled();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("第一档位标题");
    expect(provider.requests.filter((request) => request.tools)[0].reasoning_effort).toBe("high");

    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await expect(effort).toHaveText("高");
    await effort.click();
    await opened.page.getByRole("option", { name: "低", exact: true }).click();
    await composer.fill("second effort");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_EFFORT_REPLY");
    expect(provider.requests.filter((request) => request.tools)[1].reasoning_effort).toBe("low");
    await opened.page.reload();
    await expect(effort).toHaveText("低");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("ships only the minimal MV3 Harness surface", async () => {
  const opened = await openExtension();
  try {
    const manifest = await opened.page.evaluate(() => chrome.runtime.getManifest());
    expect(manifest).toMatchObject({ name: "Surf Wax", manifest_version: 3, minimum_chrome_version: "138", version: "0.2.0" });
    expect(manifest.permissions).toEqual(expect.arrayContaining(["debugger", "scripting", "userScripts"]));
    await expect(opened.page.locator("h1")).toHaveText("Surf Wax");
    await expect(opened.page.getByTestId("config-required-state")).toBeVisible();

    const options = await configure(opened.context, opened.page, "https://provider.test/v1");
    await expect(options.getByTestId("options-card").locator("input")).toHaveCount(9);
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
    await browserSession.send("Extensions.triggerAction", { id: opened.extensionId, targetId: tab!.targetId });
    await expect.poll(async () => (await browserSession.send("Target.getTargets")).targetInfos
      .some((info) => info.url === `chrome-extension://${opened.extensionId}/sidepanel.html`)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test.skip("uses a large observation from the real side panel before acting on its ref", async () => {
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
      browserResponse({ mode: "observe", tabId: tab.id, detail: "semantic" }, "call-large-observe"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const ref = JSON.parse(message.content).$ref;
        return browserResponse({ mode: "result", id: ref, path: ["snapshot"], offset: 0, limit: 4000 }, "call-read-snapshot");
      },
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const snapshot = message.content;
        const ref = /button "Run exact action" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
        if (!ref) throw new Error("The selected snapshot did not contain the target ref");
        return browserResponse({ mode: "act", tabId: tab.id, steps: [
          { type: "click", target: { ref } },
          { type: "expect", target: { by: "css", value: "body[data-clicked=yes]" }, state: "attached" },
        ] }, "call-act-from-ref");
      },
      textResponse("REAL_SIDE_PANEL_OK"),
      textResponse("真实侧边栏"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.close();

    const browserSession = await opened.context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
    const tabTarget = targetInfos.find((info) => info.type === "tab" && info.url === target.url());
    expect(tabTarget).toBeDefined();
    await browserSession.send("Extensions.triggerAction", { id: opened.extensionId, targetId: tabTarget!.targetId });
    let sidePanelTargetId: string | undefined;
    await expect.poll(async () => {
      const targets = await browserSession.send("Target.getTargets");
      sidePanelTargetId = targets.targetInfos.find((info) => info.url.startsWith(`chrome-extension://${opened.extensionId}/sidepanel.html`))?.targetId;
      return Boolean(sidePanelTargetId);
    }).toBe(true);
    panel = await attachTarget(browserSession, sidePanelTargetId!);
    await expect.poll(() => panel!.evaluate<boolean>('Boolean(document.querySelector("[data-testid=composer-input]"))')).toBe(true);
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
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-read-snapshot")?.output).toContain('button "Run exact action" [ref=');
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-act-from-ref")?.output).toMatchObject({ ok: true });
  } finally {
    await panel?.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test.skip("targets page worlds and selects large tool output without creating another reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/target`);
    expect(tab?.id).toBeDefined();
    responses.push(
      toolResponse({ code: "return document.title", target: { kind: "page", tabId: tab.id, world: "MAIN" } }, "call-main"),
      toolResponse({ code: "return await Promise.resolve(document.title + ' USER')", target: { kind: "page", tabId: tab.id, world: "USER_SCRIPT" } }, "call-user"),
      toolResponse("return { url: 'https://example.com', snapshot: 'LARGE_START' + 'zx'.repeat(6000) }", "call-large"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const ref = JSON.parse(message.content).$ref;
        return browserResponse({ mode: "result", id: ref, path: ["snapshot"], offset: 0, limit: 11 }, "call-select-large");
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
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBeGreaterThanOrEqual(5);
    const requests = provider.requests.filter((request) => request.tools);
    expect(JSON.stringify(requests[1].messages)).toContain("Side Agent Target");
    expect(JSON.stringify(requests[2].messages)).toContain("Side Agent Target USER");
    const fourthPrompt = JSON.stringify(requests[3].messages);
    expect(fourthPrompt).toContain("$ref");
    expect(fourthPrompt).not.toContain("zx".repeat(200));
    expect(JSON.stringify(requests[4].messages)).toContain("LARGE_START");
    const events = await readEvents(opened.page);
    const data = events.find((event) => event.type === "tool.result.data");
    expect(data.output).toEqual({ url: "https://example.com", snapshot: "LARGE_START" + "zx".repeat(6000) });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-large")?.output.$ref).toBe(data.id);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-select-large")?.output).toBe("LARGE_START");
    expect(events.filter((event) => event.type === "tool.result.data")).toHaveLength(1);
    await opened.page.reload();
    await expect.poll(() => opened.page.evaluate(async (id) => {
      const read = (globalThis as any).__surfWaxResult;
      return typeof read === "function" ? (await read(id)).snapshot.slice(0, 11) : null;
    }, data.id)).toBe("LARGE_START");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("uses dedicated snapshot, fill, and click tools", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation`);
    expect(tab?.id).toBeDefined();
    responses.push(
      commandResponse("snapshot", {}, "call-snapshot"),
      commandResponse("fill", { target: { by: "label", value: "Email" }, text: "me@example.com" }, "call-fill"),
      commandResponse("click", { target: "getByRole('button', { name: 'Sign in' })" }, "call-click"),
      commandResponse("snapshot", {}, "call-verify"),
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
    expect(observation).toMatchObject({ snapshot: expect.stringContaining("[ref=e") });
    expect(verified).toMatchObject({ snapshot: expect.stringContaining("Welcome me@example.com") });
    await expect.poll(() => target.locator("output").textContent()).toBe("Welcome me@example.com");
    expect(events.some((event) => event.type === "automation.action.finished" && event.toolCallId === "call-click")).toBe(true);
    expect(provider.requests[0].tools).toHaveLength(80);
    const toolNames = provider.requests[0].tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("browser");
    expect(toolNames.filter((name: string) => ["open", "attach", "close", "detach", "show", "list", "close-all", "kill-all"].includes(name))).toEqual([]);
    expect(await opened.page.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowCount);
    expect(provider.requests.filter((request) => request.tools)).toHaveLength(5);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("injects a screenshot and clicks its observation coordinates", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/visual`);
    responses.push(
      commandResponse("screenshot", { type: "jpeg" }, "call-visual-observe"),
      (request) => {
        const serialized = JSON.stringify(request.messages);
        const marker = serialized.indexOf("observationId");
        const observationId = marker < 0 ? undefined : /[0-9a-f]{8}-[0-9a-f-]{27,}/i.exec(serialized.slice(marker))?.[0];
        if (!observationId) throw new Error("Visual observation id was not returned to the model");
        return commandResponse("click", { target: { point: { observationId, x: 50, y: 40 } } }, "call-visual-act");
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
    const observation = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "call-visual-observe")?.output;
    expect(observation?.screenshot?.mediaType).toBe("image/jpeg");
    expect(observation?.artifact).toMatchObject({ mimeType: "image/jpeg", downloadId: expect.any(Number) });
    expect(JSON.stringify(provider.requests[1])).toContain("image_url");
    expect(observation.observationId).toEqual(expect.any(String));
    await expect.poll(() => target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test.skip("keeps 100 semantic locate-and-action operations at p95 <= 100ms", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/performance`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/performance`);
    responses.push(browserResponse({ mode: "act", tabId: tab.id, steps: Array.from({ length: 100 }, () => ({ type: "click", target: { by: "role", value: "button", name: "Increment" } })) }, "call-performance"), textResponse("PERFORMANCE_OK"), textResponse("性能"));
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    await opened.page.getByTestId("composer-input").fill("benchmark semantic actions"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("100", { timeout: 30_000 });
    const latencies = (await readEvents(opened.page)).filter((event) => event.type === "automation.action.finished" && event.toolCallId === "call-performance").map((event) => event.latencyMs);
    expect(latencies).toHaveLength(100);
    expect(p95(latencies)).toBeLessThanOrEqual(100);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("uses frameLocator inside a cross-origin iframe", async () => {
  const responses: string[][] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
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
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-frame")?.output).toBe("FRAME_OK");
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
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-dynamic")?.output).toEqual({ count: "50", shadow: "yes" });
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
    textResponse("FINAL_AFTER_GROUPS"),
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

test("shows the command count after an interrupted group settles", async () => {
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
    await expect(group.locator(":scope > summary")).toHaveText("2 次命令中有失败");
    await group.locator(":scope > summary").click();
    await expect(group.locator(".activity[data-status]")).toHaveCount(2);
    await expect(group.locator(".activity[data-status=running]")).toHaveCount(0);
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
    await expect(opened.page.getByTestId("process-trace")).toBeVisible();
    await expect(opened.page.getByTestId("process-trace").locator(":scope > summary")).toContainText("正在执行命令");
    await expect(opened.page.getByTestId("work-summary")).toHaveCount(0);
    const work = opened.page.getByTestId("work-summary");
    await expect(work.locator(":scope > summary")).toHaveText(/^工作了 \d+ 秒$/);
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
    await expect(work).toContainText("WORK_RESULT");
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "工作摘要标题" }).locator(".conversation-select").click();
    await expect(opened.page.getByTestId("work-summary")).toHaveCount(1);
    await expect(opened.page.getByTestId("work-summary")).not.toHaveAttribute("open", "");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FINAL_REPLY");
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

test("returns a stable unsupported-in-extension error and lets the agent recover", async () => {
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
      .toContain("unsupported-in-extension");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

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
    expect(provider.requests[0].tools).toHaveLength(80);
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

test("asks after a completed turn and summarizes the complete context on request", async () => {
  const oldReply = "OLD_CONTEXT_MARKER " + "page observation ".repeat(900);
  const provider = await startProvider([
    textResponse(oldReply),
    textResponse("压缩测试"),
    textResponse("COMPACTED_REPLY"),
  ], 0, "The previous page observations have been recorded.");
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 8_000);
    const composer = opened.page.getByTestId("composer-input");
    const contextIndicator = opened.page.getByTestId("context-indicator");
    await expect(contextIndicator).toHaveAttribute("data-state", "ready");
    await expect(contextIndicator).toHaveAttribute("aria-label", /上下文已使用约 \d+% · [\d,]+ \/ 6,400 tokens · 手动设置/);
    await contextIndicator.focus();
    await expect(opened.page.getByRole("tooltip")).toContainText("手动设置");
    await composer.fill("first request");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OLD_CONTEXT_MARKER");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("压缩测试");
    await expect(opened.page.getByTestId("context-choice")).toBeVisible();
    await expect.poll(async () => Number(await contextIndicator.getAttribute("data-used-percent"))).toBeGreaterThanOrEqual(80);
    await expect(contextIndicator).toHaveClass(/text-destructive/);
    await expect(composer).toBeDisabled();

    await options.close();
    await opened.page.getByTestId("context-choice").getByRole("button", { name: "LLM 摘要" }).click();
    await expect(opened.page.getByTestId("context-choice")).toHaveCount(0);
    await expect.poll(async () => Number(await contextIndicator.getAttribute("data-used-percent"))).toBeLessThan(80);
    await expect(contextIndicator).not.toHaveClass(/text-destructive/);
    await composer.fill("continue");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPACTED_REPLY");
    await expect(opened.page.getByTestId("context-status")).toContainText("历史上下文已被压缩成摘要");
    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await expect(opened.page.getByTestId("context-status")).toHaveCount(0);

    const events = await readEvents(opened.page);
    expect(events.some((event) => event.type === "context.compacted")).toBe(true);
    expect(JSON.stringify(events.filter((event) => event.type === "conversation.message"))).toContain("OLD_CONTEXT_MARKER");
    const finalRequest = provider.requests.find((request) => request.stream === true && JSON.stringify(request.messages).includes("continue"));
    expect(JSON.stringify(finalRequest?.messages)).toContain("The previous page observations have been recorded.");
    expect(JSON.stringify(finalRequest?.messages)).not.toContain("OLD_CONTEXT_MARKER");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("updates context usage during a streamed reply and shows structured details", async () => {
  const provider = await startProvider([
    streamingTextResponse(["LIVE_CONTEXT_MARKER " + "page state ".repeat(2_000), " STREAM_COMPLETE"],
      { promptTokens: 2_000, completionTokens: 800, cachedTokens: 500 }),
    textResponse("实时上下文测试"),
  ], 700);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 100_000);
    const indicator = opened.page.getByTestId("context-indicator");
    await expect(indicator).toHaveAttribute("data-state", "ready");
    const initial = Number(await indicator.getAttribute("data-used-percent"));

    await opened.page.setViewportSize({ width: 320, height: 720 });
    await opened.page.emulateMedia({ colorScheme: "dark" });
    await indicator.focus();
    const tooltip = opened.page.getByRole("tooltip");
    await expect(tooltip).toContainText("上下文用量");
    await expect(tooltip).toContainText("输入");
    await expect(tooltip).toContainText("输出");
    await expect(tooltip).toContainText("缓存命中");
    await expect(opened.page.getByTestId("context-detail-progress")).toHaveAttribute("aria-valuenow", String(initial));
    const box = await tooltip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);

    await opened.page.getByTestId("composer-input").fill("stream context now");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LIVE_CONTEXT_MARKER");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await indicator.focus();
    await expect(opened.page.getByTestId("context-input")).toHaveText("0 tokens");
    await expect(opened.page.getByTestId("context-output")).toHaveText("0 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("0 tokens");
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBeGreaterThan(initial);
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_COMPLETE");
    await expect(opened.page.getByTestId("context-token-usage")).toHaveAttribute("data-animating", "true");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await expect(opened.page.getByTestId("context-token-usage")).toHaveAttribute("data-animating", "false");
    await expect(opened.page.getByTestId("context-input")).toHaveText("2,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toHaveText("800 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toHaveText("500 tokens");
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("anchors context usage to provider-reported input tokens", async () => {
  const provider = await startProvider([
    toolResponse("return true", "call-usage-e2e", { promptTokens: 10_000, completionTokens: 5, cachedTokens: 3_000 }),
    textResponse("USAGE_ANCHOR_REPLY", { promptTokens: 30_000, completionTokens: 5, cachedTokens: 12_000 }),
    textResponse("用量测试"),
    textResponse("SECOND_USAGE_REPLY", { promptTokens: 20_000, completionTokens: 5, cachedTokens: 7_000 }),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 100_000);
    const indicator = opened.page.getByTestId("context-indicator");
    await expect(indicator).toHaveAttribute("data-state", "ready");

    await opened.page.getByTestId("composer-input").fill("measure provider usage");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("USAGE_ANCHOR_REPLY");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent")))
      .toBeGreaterThanOrEqual(10);

    await indicator.focus();
    await expect(opened.page.getByTestId("context-input")).toContainText("40,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toContainText("10 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("15,000 tokens");

    await opened.page.getByTestId("composer-input").fill("measure cumulative usage");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_USAGE_REPLY");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await indicator.focus();
    await expect(opened.page.getByTestId("context-input")).toContainText("60,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toContainText("15 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("22,000 tokens");
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("restores a pending context choice after reopening the panel", async () => {
  const provider = await startProvider([
    textResponse("OLD_CONTEXT_MARKER " + "page observation ".repeat(900)),
    textResponse("旧对话标题"),
    textResponse("LATE_COMPACTION_REPLY"),
  ], 0, "Earlier page observations have been recorded.", ["minimal"], 800);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 8_000);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first request");
    await composer.press("Enter");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("旧对话标题");
    await expect(opened.page.getByTestId("context-choice")).toBeVisible();
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "旧对话标题" }).locator(".conversation-select").click();
    await expect(opened.page.getByTestId("context-choice")).toBeVisible();
    await opened.page.getByTestId("context-choice").getByRole("button", { name: "LLM 摘要" }).click();
    await expect(opened.page.getByTestId("context-status")).toContainText("历史上下文已被压缩成摘要");
    await composer.fill("continue");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LATE_COMPACTION_REPLY");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("Jev selection creates a child conversation and keeps the source intact", async () => {
  const provider = await startProvider([
    textResponse("OLD_CONTEXT_MARKER " + "page observation ".repeat(900)),
    textResponse("来源会话标题"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 8_000);
    await options.getByLabel("Jev Base URL").fill(provider.origin);
    await options.getByLabel("Jev Model ID").fill("jev-test");
    await options.getByLabel("Jev API Key").fill("jev-key");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close();
    await opened.page.getByTestId("composer-input").fill("Keep this user request");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("context-choice")).toBeVisible();
    await opened.page.getByTestId("context-choice").getByRole("button", { name: "Jev 重选" }).click();
    await expect(opened.page.getByTestId("context-choice")).toHaveCount(0);
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("· Jev");
    await expect(opened.page.locator('[data-role="user"]')).toContainText("Keep this user request");
    await expect(opened.page.getByText("OLD_CONTEXT_MARKER")).toHaveCount(0);
    expect(provider.jevRequests).toHaveLength(1);
    expect(JSON.stringify(provider.jevRequests[0].state)).toContain("OLD_CONTEXT_MARKER");
    const events = await readEvents(opened.page);
    const child = events.find((event) => event.type === "conversation.created" && event.content?.parentConversationId);
    expect(child).toBeTruthy();
    expect(events.some((event) => event.conversationId === child?.content?.parentConversationId && event.type === "conversation.message"
      && JSON.stringify(event.content).includes("OLD_CONTEXT_MARKER"))).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("offers a choice immediately after the provider rejects an oversized context", async () => {
  const provider = await startProvider([{ status: 400, error: "maximum context length exceeded" }]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 8_000);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("overflow request");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("context-choice")).toBeVisible();
    await expect(opened.page.getByTestId("composer-input")).toBeDisabled();
    expect((await readEvents(opened.page)).some((event) => event.type === "context.choice.required"
      && event.content?.reason === "provider-overflow")).toBe(true);
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

test.skip("keeps legacy raw CDP sessions and result references across calls", async () => {
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
    expect(outputs[3]).toMatchObject({ $ref: expect.any(String), ref: expect.any(String), access: expect.stringContaining("__surfWaxObject") });
    expect(outputs[4]).toMatchObject({ entries: [["answer", 42], ["kind", "inspectable"]], id: outputs[3].$ref });
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
    await composer.fill("initial request");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.getByRole("button", { name: "排队消息" })).toHaveCount(0);
    await nameCurrentConversation(opened.page, "Follow-up FIFO");
    await expect(composer).toBeEnabled();

    await composer.fill("second request");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    await opened.page.getByRole("button", { name: "排队消息" }).click();
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.getByRole("button", { name: "排队消息" })).toHaveCount(0);
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
    textResponse("Follow-up immediate"),
    textResponse("LATER_DONE"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("long running request");
    await composer.press("Enter");
    await expect(opened.page.locator(".process-trace[data-status=running]")).toBeVisible();
    await nameCurrentConversation(opened.page, "Follow-up immediate");
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
    await composer.fill("long request");
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await nameCurrentConversation(opened.page, "Paused follow-up");
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
    await expect(opened.page.getByTestId("edit-message-button")).toHaveCount(0);
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
    expect(restoredInputMs).toBeLessThan(500);
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
    await startNewConversation(opened.page);
    await expect(opened.page.locator(".conversation-notice")).toContainText("当前会话尚未结束");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "第一标题" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".conversation-dialog .conversation-notice")).toContainText("当前会话尚未结束");
    await opened.page.locator(".conversation-item[data-active] .conversation-action").last().click();
    await expect(opened.page.locator(".conversation-dialog .conversation-notice")).toContainText("当前会话尚未结束");
    await opened.page.locator(".conversation-item[data-active] .conversation-delete").click();
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
    await viewport.evaluate((element) => { element.scrollTop = 0; });
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
  const provider = await startProvider([
    textResponse("ORIGINAL_REPLY"),
    textResponse("分支测试"),
    textResponse("REGENERATED_REPLY"),
    textResponse("EDITED_REPLY"),
    textResponse("FOLLOWUP_REPLY"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("original question");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("分支测试");

    await opened.page.getByTestId("replay-message-button").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REGENERATED_REPLY");
    await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await expect(opened.page.getByTestId("work-summary")).toHaveCount(1);
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "conversation.branch.selected")).toBe(true);

    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "分支测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");

    await opened.page.getByTestId("edit-message-button").click();
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
    for (const text of ["original question", "edited question", "ORIGINAL_REPLY", "REGENERATED_REPLY", "EDITED_REPLY", "FOLLOWUP_REPLY"]) {
      expect(recordedMessages).toContain(text);
    }
    expect(provider.requests.at(-1).messages.map((message: any) => message.content)).toEqual(expect.arrayContaining(["edited question", "follow up"]));
    expect(JSON.stringify(provider.requests.at(-1).messages)).not.toContain("original question");

    await opened.page.getByRole("button", { name: "上一个分支" }).first().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "分支测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ORIGINAL_REPLY");
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

test("keeps a running conversation alive when a switch is blocked", async () => {
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
    await startNewConversation(opened.page);
    await expect(opened.page.locator(".conversation-notice")).toContainText("当前会话尚未结束");
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
    const urls = await opened.page.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).map((tab) => tab.url));
    const firstIndex = urls.indexOf(targetUrl);
    const secondIndex = urls.indexOf(otherUrl);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    responses.push(
      commandResponse("tab-select", { index: firstIndex }, "call-select-first"),
      commandResponse("snapshot", {}, "call-snapshot-first"),
      commandResponse("tab-select", { index: secondIndex }, "call-select-second"),
      commandResponse("eval", { func: `() => {
        const button = document.createElement('button');
        button.textContent = 'CDP target';
        button.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:40px';
        button.onclick = () => { document.documentElement.dataset.cdpClicks = String(Number(document.documentElement.dataset.cdpClicks || 0) + 1); };
        document.body.append(button);
      }` }, "call-create-target"),
      commandResponse("click", { target: "getByRole('button', { name: 'CDP target' })" }, "call-click-target"),
      commandResponse("run-code", { code: "async page => { await new Promise((resolve) => setTimeout(resolve, 1200)); return page.url(); }" }, "call-guard-wait"),
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

test("contains long unhandled errors in all three extension views", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    const [scripts] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    for (const page of [opened.page, options, scripts]) {
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
    await expect(scripts.getByTestId("user-scripts-panel")).toBeVisible();
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

test("contains a long user script restore error without hiding the manager", async () => {
  const opened = await openExtension();
  try {
    const [scripts] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await scripts.setViewportSize({ width: 360, height: 700 });
    await scripts.evaluate(() => chrome.storage.local.set({ "side-agent:user-scripts-error": "SCRIPT_ERROR_".repeat(2000) }));
    const notice = scripts.locator(".app-error-notice").filter({ hasText: "用户脚本恢复失败" });
    await expect(notice).toBeVisible();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("SCRIPT_ERROR_");
    expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(scripts.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});

test("manages, edits and deletes scripts in the native Chrome scripts workbench", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId("user-scripts-disabled")).toContainText("Allow User Scripts");
    const [disabledManager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await expect(disabledManager.getByRole("status")).toContainText("Allow User Scripts");
    await disabledManager.close();
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await opened.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(opened.page.getByTestId("user-scripts-disabled")).toHaveCount(0);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const [manager] = await Promise.all([
      opened.context.waitForEvent("page"), opened.page.getByTestId("open-user-scripts").click(),
    ]);
    await manager.waitForLoadState("domcontentloaded");
    await expect(manager.getByTestId("user-scripts-panel")).toBeVisible();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByText("在网页中试运行")).toHaveCount(0);
    const script = { id: "managed", matches: [`${provider.origin}/*`], js: [{ code: "const CSS_TOP='body{color:red}';document.documentElement.dataset.managed = 'first'; 'RUN_OK'" }], world: "USER_SCRIPT" };
    await manager.getByRole("button", { name: "新建脚本" }).click();
    await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-id-error")).toContainText("请输入脚本 ID");
    await expect(manager.locator("#script-matches-error")).toContainText("网站匹配规则");
    await manager.locator("#script-id").fill(script.id);
    await manager.locator("#script-matches").fill(script.matches[0]);
    await manager.locator("#script-code .cm-content").fill(script.js[0].code);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-code .cm-content")).toHaveAttribute("contenteditable", "true");
    await expect(manager.locator("#script-code .cm-content")).toContainText("color: red;");
    await expect(manager.locator("#script-code .cm-content")).toContainText("CSS_TOP = `");
    await expect(manager.locator("#script-code .cm-line span").filter({ hasText: /^body$/ })).toBeVisible();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toBeVisible();
    expect(await warnsOnLeave(manager)).toBe(false);
    const initialScripts = (await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[];
    expect(initialScripts).toHaveLength(1);
    expect(initialScripts[0].js?.[0].code).toContain("\n");
    expect(initialScripts[0].js?.[0].code).toContain("color: red;");
    await manager.getByRole("button", { name: "停用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"]).toHaveLength(1);
    await manager.reload();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.locator("#script-code .cm-content").fill(`${script.js[0].code}\n// edited while disabled`);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByRole("status")).toContainText("脚本已保存");
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).toMatchObject([{ js: [{ code: expect.stringContaining("edited while disabled") }] }]);
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("button", { name: "启用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已注册")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.locator("#script-search").fill("no-match");
    await expect(manager.getByText("没有匹配的脚本")).toBeVisible();
    await manager.locator("#script-search").fill("managed");
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "JSON 高级编辑" }).click();
    const definition = manager.locator("#script-definition");
    await definition.fill(JSON.stringify({ ...script, runAt: "document_start", excludeMatches: ["https://example.org/*"] }));
    await manager.getByRole("button", { name: "返回表单" }).click();
    await manager.locator("#script-code .cm-content").fill("document.documentElement.dataset.managed='updated';'RUN_OK'");
    await manager.getByRole("button", { name: "格式化代码" }).click();
    await expect(manager.locator("#script-code .cm-content")).toContainText("document.documentElement.dataset.managed = \"updated\";");
    expect(await warnsOnLeave(manager)).toBe(true);
    manager.once("dialog", (dialog) => dialog.dismiss());
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    await expect(manager.locator("#script-code .cm-content")).toContainText("updated");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[]).toMatchObject([{ js: [{ code: expect.stringContaining("first") }] }]);
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByRole("status")).toContainText("脚本已保存");
    expect(await warnsOnLeave(manager)).toBe(false);
    const savedScript = ((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[])[0];
    expect(savedScript.runAt).toBe("document_start");
    expect(savedScript.excludeMatches).toEqual(["https://example.org/*"]);
    expect(savedScript.js?.[0].code).toContain("updated");
    await manager.goBack();
    await expect(manager.getByRole("heading", { name: /已保存脚本/ })).toBeVisible();
    await manager.goForward();
    await expect(manager.getByRole("heading", { name: "managed" })).toBeVisible();
    await manager.locator("#script-code .cm-content").fill("// discard this draft");
    manager.once("dialog", (dialog) => dialog.accept());
    await manager.getByRole("button", { name: "返回列表" }).click();
    expect(await warnsOnLeave(manager)).toBe(false);
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await expect(manager.locator("#script-code .cm-content")).toContainText("updated");
    await manager.setViewportSize({ width: 390, height: 800 });
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(manager.getByRole("button", { name: "返回列表" })).toBeVisible();
    }
    await manager.getByRole("button", { name: "返回列表" }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme });
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(manager.getByRole("button", { name: "停用 managed" })).toBeVisible();
    }
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.setViewportSize({ width: 1280, height: 800 });
    const settings = await opened.context.newPage();
    await settings.goto(`chrome://extensions/?id=${opened.extensionId}`);
    const toggle = settings.locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await opened.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(opened.page.getByTestId("user-scripts-disabled")).toBeVisible();
    await manager.reload();
    await expect(manager.getByRole("status")).toContainText("Allow User Scripts");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toHaveLength(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await opened.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(opened.page.getByTestId("user-scripts-disabled")).toHaveCount(0);
    await manager.reload();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已注册")).toBeVisible();
    await settings.close();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.evaluate(async () => chrome.userScripts.unregister({ ids: ["managed"] }));
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["managed"] })).length)).toBe(1);
    await manager.getByRole("button", { name: "停用 managed" }).click();
    await expect(manager.getByLabel("已保存脚本").getByText("已停用")).toBeVisible();
    await manager.getByLabel("已保存脚本").locator(".script-item").click();
    await manager.getByRole("button", { name: "删除" }).click();
    await manager.getByRole("button", { name: "确认删除" }).click();
    await expect(manager.getByLabel("已保存脚本").locator(".script-item")).toHaveCount(0);
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"]).toEqual([]);
    await manager.getByRole("button", { name: "新建脚本" }).click();
    await manager.getByRole("button", { name: "JSON 高级编辑" }).click();
    await manager.locator("#script-definition").fill(JSON.stringify({ ...script, id: "complex", js: [{ code: "1" }, { code: "2" }] }));
    await manager.getByRole("button", { name: "保存" }).click();
    await expect(manager.locator("#script-definition")).toBeVisible();
    await expect(manager.getByRole("button", { name: "返回表单" })).toBeDisabled();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"] as chrome.userScripts.RegisteredUserScript[])[0].js).toHaveLength(2);
    await manager.getByRole("button", { name: "复制为新脚本" }).click();
    await expect(manager.locator("#script-definition")).toContainText('"id": "complex-copy"');
    await manager.getByRole("button", { name: "保存" }).click();
    await manager.getByRole("button", { name: "返回列表" }).click();
    await manager.getByRole("checkbox", { name: "选择当前搜索结果" }).click();
    await manager.getByRole("button", { name: "批量停用" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts()).length)).toBe(0);
    const downloadPromise = manager.waitForEvent("download");
    await manager.getByRole("button", { name: "导出所选" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("surf-wax-user-scripts.json");
    const exported = JSON.parse(await readFile(await download.path(), "utf8")) as chrome.userScripts.RegisteredUserScript[];
    expect(exported.map((item) => item.id).sort()).toEqual(["complex", "complex-copy"]);
    expect(exported.every((item) => !("enabled" in item))).toBe(true);
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([{ ...script, enabled: false }])) });
    await expect(manager.getByRole("alert")).toContainText("原生字段");
    await expect(manager.getByRole("heading", { name: "预览导入" })).toHaveCount(0);
    const imported = [
      { id: "complex", matches: script.matches, js: [{ code: "'imported'" }], runAt: "document_start" },
      { id: "new-one", matches: script.matches, js: [{ code: "'new'" }] },
    ];
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "scripts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(manager.getByRole("heading", { name: "预览导入" })).toBeVisible();
    await manager.getByRole("button", { name: "导入所选" }).click();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).find((item) => item.id === "complex")).toMatchObject({ js: [{ code: "1" }, { code: "2" }] });
    await manager.getByLabel("选择 Chrome 用户脚本 JSON 文件").setInputFiles({ name: "scripts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await manager.getByRole("checkbox", { name: "覆盖 complex" }).click();
    await manager.getByRole("button", { name: "导入所选" }).click();
    expect(((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts-disabled")))["side-agent:user-scripts-disabled"] as chrome.userScripts.RegisteredUserScript[]).find((item) => item.id === "complex")).toMatchObject({ runAt: "document_start", js: [{ code: "'imported'" }] });
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["complex"] })).length)).toBe(0);
    await manager.getByRole("button", { name: "批量启用" }).click();
    await expect.poll(() => manager.evaluate(async () => (await chrome.userScripts.getScripts({ ids: ["complex", "complex-copy"] })).length)).toBe(2);
    await manager.getByRole("button", { name: "批量删除" }).click();
    await manager.getByRole("button", { name: "确认删除" }).click();
    await expect(manager.getByLabel("已保存脚本").getByRole("button", { name: /complex/ })).toHaveCount(0);
    await manager.evaluate(async () => chrome.storage.local.set({ "side-agent:user-scripts": { legacy: "unreadable" } }));
    await manager.getByRole("button", { name: "刷新状态" }).click();
    await expect(manager.getByRole("alert").first()).toContainText("原始数据已保留");
    expect((await manager.evaluate(async () => chrome.storage.local.get("side-agent:user-scripts")))["side-agent:user-scripts"]).toEqual({ legacy: "unreadable" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
