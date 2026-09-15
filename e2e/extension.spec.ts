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

function toolResponse(code: string): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: "call-chrome-e2e",
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

async function startProvider(responses: string[][], delayMs = 0): Promise<{
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
    const request = indexedDB.open("side-agent-runtime", 3);
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
    expect(manifest).toMatchObject({ manifest_version: 3, minimum_chrome_version: "138", version: "0.2.0" });
    expect(manifest.permissions).toEqual(expect.arrayContaining(["debugger", "scripting", "userScripts"]));
    await expect(opened.page.locator("h1")).toHaveText("Side Agent Runtime");
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
  responses.push(toolResponse(code), textResponse("META_OK"));
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
    await expect(opened.page.locator(".markdown-body").last()).toContainText("META_OK");
    await opened.page.locator(".activity summary").click();
    await expect(opened.page.locator(".activity")).toContainText("USER_OK");
    await expect(opened.page.locator(".activity")).toContainText("MAIN_OK");
    await expect(opened.page.locator(".activity")).toContainText("Side Agent Target");
    await expect.poll(() => target.evaluate(() => ({ main: document.documentElement.dataset.main, user: document.documentElement.dataset.user })))
      .toEqual({ main: "yes", user: "yes" });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].tools).toHaveLength(1);
    expect(provider.requests[0].tools[0]).toMatchObject({
      type: "function",
      function: { name: "chrome", parameters: { type: "object", required: ["code"], additionalProperties: false } },
    });
    const events = await readEvents(opened.page);
    const tool = events.find((event) => event.type === "tool.finished");
    expect(tool).toMatchObject({ toolCallId: "call-chrome-e2e", input: { code: expect.any(String) }, latencyMs: expect.any(Number) });
    expect(tool.output).toMatchObject({ user: "USER_OK", main: "MAIN_OK", cdp: "Side Agent Target" });
    expect(events.filter((event) => event.type === "conversation.message")).toHaveLength(2);

    await opened.page.reload();
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

test("streams complete Markdown without blocking draft input", async () => {
  const markdown = [
    "# Heading\n\n> quote\n\n- [x] task\n\n~~strike~~ and [link](https://example.com).\n\n",
    "| A | B |\n| - | - |\n| 1 | 2 |\n\nInline $x^2$ and block:\n\n$$y=x+1$$\n\n",
    "```javascript\nconst answer = 42;\n```\n\nFootnote[^1].\n\n[^1]: note\n\nFINAL_MARKER",
  ].join("");
  const parts = [chunk({ role: "assistant", content: "" }), ...[...markdown].map((content) => chunk({ content })), chunk({}, "stop"), "data: [DONE]\n\n"];
  const provider = await startProvider([parts], 2);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("stream markdown");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toHaveAttribute("data-status", "running");

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
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("closing the panel aborts an active model stream", async () => {
  const parts = [chunk({ role: "assistant", content: "STREAM_STARTED" }), ...Array.from({ length: 500 }, () => chunk({ content: "." }))];
  const provider = await startProvider([parts], 20);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("keep streaming");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_STARTED");
    await opened.page.close();
    await expect.poll(() => provider.stats.abortedResponses).toBe(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("closing the panel prevents a queued chrome call from starting", async () => {
  const provider = await startProvider([queuedToolResponse(
    "await new Promise(() => undefined);",
    "await chrome.storage.local.set({ 'e2e-queued-tool-ran': true }); return true;",
  )]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("queue two calls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".activity")).toHaveCount(2);
    await opened.page.close();

    const probe = await opened.context.newPage();
    await probe.goto(`chrome-extension://${opened.extensionId}/options.html`);
    await expect.poll(() => probe.evaluate(async () => (await chrome.storage.local.get("e2e-queued-tool-ran"))["e2e-queued-tool-ran"]))
      .toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
