import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function chunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-side-agent-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

function codeResponse(): string {
  return [
    chunk("Here is the requested code:\n\n"),
    chunk("```javascript\n"),
    chunk("document.title\n"),
    chunk("```\n", "stop"),
    "data: [DONE]\n\n",
  ].join("");
}

function toolCallResponse(idPrefix = "tool"): string {
  const inputs = [
    { operation: "call", path: "tabs.query", args: [{}] },
    { operation: "call", path: "windows.getCurrent", args: [{}] },
  ];
  const toolCalls = inputs.map((input, index) => ({
    index,
    id: `call-${idPrefix}-${index + 1}`,
    type: "function",
    function: {
      name: "chrome",
      arguments: JSON.stringify(input),
    },
  }));
  return [
    chunk("", null).replace('"delta":{}', `"delta":{"role":"assistant","tool_calls":${JSON.stringify(toolCalls)}}`),
    chunk("", "tool_calls"),
    "data: [DONE]\n\n",
  ].join("");
}

function textResponse(text: string): string {
  return [chunk(text), chunk("", "stop"), "data: [DONE]\n\n"].join("");
}

async function startStreamingProvider(chunks: string[], delayAfterFirstMs = 750): Promise<{
  baseURL: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": "*",
      });
      response.end();
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "access-control-allow-origin": "*" });
      response.end();
      return;
    }

    request.resume();
    request.once("end", () => {
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });

      let index = 0;
      const writeNext = () => {
        if (response.destroyed) return;
        if (index >= chunks.length) {
          response.end();
          return;
        }
        response.write(chunks[index]);
        index += 1;
        setTimeout(writeNext, index === 1 ? delayAfterFirstMs : 0);
      };
      writeNext();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Streaming provider did not receive a TCP address");
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, server };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function openExtension(): Promise<{ context: BrowserContext; page: Page; userDataDirectory: string }> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDirectory = await mkdtemp(resolve(tmpdir(), "side-agent-assistant-ui-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(serviceWorker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { context, page, userDataDirectory };
}

async function configureProvider(
  context: BrowserContext,
  page: Page,
  baseURL = "https://provider.test/v1",
): Promise<void> {
  const [optionsPage] = await Promise.all([
    context.waitForEvent("page"),
    page.getByTestId("open-settings").click(),
  ]);
  await optionsPage.waitForLoadState("domcontentloaded");
  const inputs = optionsPage.getByTestId("options-card").locator("input");
  await inputs.nth(0).fill(baseURL);
  await inputs.nth(1).fill("test-model");
  await inputs.nth(2).fill("test-key");
  await optionsPage.getByRole("button", { name: "保存配置" }).click();
  await expect(optionsPage.locator(".save-message.saved")).toBeVisible();
  await optionsPage.close();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

test("shows three welcome suggestions and sends the selected one", async () => {
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: textResponse("已收到你的任务。"),
      });
    });

    await configureProvider(context, page);
    const welcomeOptions = page.getByTestId("welcome-options");
    await expect(welcomeOptions.getByRole("button")).toHaveCount(3);
    await expect(welcomeOptions).toContainText("移除页面广告");
    await expect(welcomeOptions).toContainText("添加深色模式");
    await expect(welcomeOptions).toContainText("做最酷的事情");
    await welcomeOptions.getByRole("button", { name: "添加深色模式" }).click();
    await expect(page.locator('[data-role="user"]').last()).toContainText("添加深色模式");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("clears the composer after sending a message", async () => {
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: textResponse("已收到你的消息。"),
      });
    });

    await configureProvider(context, page);
    const composer = page.getByTestId("composer-input");
    await composer.fill("发送后应该清空");
    await composer.press("Enter");

    await expect(page.locator('[data-role="user"]').last()).toContainText("发送后应该清空");
    await expect(composer).toHaveValue("");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("rebuilds the chat and context from the canonical event log", async () => {
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: textResponse("本地日志已记录。"),
      });
    });

    await configureProvider(context, page);
    await page.getByTestId("composer-input").fill("记录这次运行");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.locator(".markdown-body").last()).toContainText("本地日志已记录。");

    const [optionsPage] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("open-settings").click(),
    ]);
    await optionsPage.waitForLoadState("domcontentloaded");
    await optionsPage.getByTestId("event-log-refresh").click();
    const eventLog = optionsPage.getByTestId("event-log");
    await expect(eventLog).toContainText("conversation.submitted");
    await expect(eventLog).toContainText("记录这次运行");
    await optionsPage.close();

    await page.reload();
    await expect(page.locator('[data-role="user"]').last()).toContainText("记录这次运行");
    await expect(page.locator(".markdown-body").last()).toContainText("本地日志已记录。");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("keeps the composer draft responsive before any assistant output", async () => {
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await configureProvider(context, page);
    const composer = page.getByTestId("composer-input");
    const longText = "input-without-assistant-output-".repeat(80);
    await composer.evaluate((input) => {
      const metrics = {
        inputEvents: 0,
        lastInputAt: performance.now(),
        maxInputGapMs: 0,
      };
      input.addEventListener("input", () => {
        const now = performance.now();
        metrics.inputEvents += 1;
        metrics.maxInputGapMs = Math.max(metrics.maxInputGapMs, now - metrics.lastInputAt);
        metrics.lastInputAt = now;
      });
      (window as Window & {
        __sideAgentComposerMetrics?: typeof metrics;
      }).__sideAgentComposerMetrics = metrics;
    });
    await composer.pressSequentially(longText);
    await expect(composer).toHaveValue(longText);
    const metrics = await page.evaluate(() => {
      const state = (window as Window & {
        __sideAgentComposerMetrics?: {
          inputEvents: number;
          maxInputGapMs: number;
        };
      }).__sideAgentComposerMetrics;
      return state ? { ...state } : null;
    });
    expect(metrics?.inputEvents).toBe(longText.length);
    expect(metrics?.maxInputGapMs ?? Number.POSITIVE_INFINITY).toBeLessThan(250);

    await composer.press("Control+Enter");
    await expect(composer).toHaveValue(`${longText}\n`);
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("renders Markdown while a response is still streaming", async () => {
  const provider = await startStreamingProvider([
    chunk("# Streaming answer\n\n"),
    chunk("```javascript\n"),
    chunk("document.title\n"),
    chunk("```\n", "stop"),
    "data: [DONE]\n\n",
  ]);
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await configureProvider(context, page, provider.baseURL);
    const composer = page.getByTestId("composer-input");
    await composer.fill("stream markdown");
    await composer.press("Enter");

    const markdown = page.locator(".markdown-body").last();
    await expect(markdown).toBeVisible();
    await expect(markdown).toHaveAttribute("data-status", "running");
    await expect(markdown).toContainText("Streaming answer");
    await expect(page.getByTestId("copy-code-button")).toBeVisible({ timeout: 5_000 });
    await expect(markdown.locator("pre code")).toContainText("document.title");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
    await closeServer(provider.server);
  }
});

test("renders copyable assistant code and supports editing user messages", async () => {
  const { context, page, userDataDirectory } = await openExtension();

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: codeResponse(),
      });
    });

    await configureProvider(context, page);
    const composer = page.getByTestId("composer-input");
    await composer.fill("show me a code block");
    await composer.press("Enter");

    await expect(page.locator(".markdown-code-header")).toBeVisible();
    await expect(page.locator(".markdown-body pre code")).toContainText("document.title");
    const copyButton = page.getByTestId("copy-code-button");
    await expect(copyButton).toHaveAttribute("aria-label", "复制代码");
    await copyButton.click();
    await expect(copyButton).toHaveAttribute("aria-label", "已复制代码");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("document.title\n");

    const userMessage = page.locator('[data-role="user"]').last();
    await userMessage.hover();
    const editButton = userMessage.getByTestId("edit-message-button");
    const bubble = userMessage.locator(".user-message-bubble");
    const [editBox, bubbleBox] = await Promise.all([editButton.boundingBox(), bubble.boundingBox()]);
    expect(editBox).not.toBeNull();
    expect(bubbleBox).not.toBeNull();
    expect(editBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height);
    await editButton.click();
    await expect(page.getByTestId("user-edit-input")).toHaveValue("show me a code block");
    await page.getByTestId("user-edit-input").fill("edited request");
    await page.getByRole("button", { name: "提交编辑" }).click();
    await expect(page.locator('[data-role="user"]').last()).toContainText("edited request");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("renders each Chrome tool path without a generic tool group overlay", async () => {
  const { context, page, userDataDirectory } = await openExtension();
  let requestCount = 0;

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      requestCount += 1;
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: requestCount === 1 ? toolCallResponse() : textResponse("The tab query completed."),
      });
    });

    await configureProvider(context, page);
    await page.getByTestId("composer-input").fill("Inspect the active tabs.");
    await page.getByTestId("composer-input").press("Enter");

    await expect(page.getByTestId("chrome-tool-call")).toHaveCount(2);
    const summaries = page.getByTestId("chrome-tool-call").locator("summary");
    await expect(summaries.nth(0)).toContainText("tabs.query");
    await expect(summaries.nth(1)).toContainText("windows.getCurrent");
    expect((await summaries.allTextContents()).some((text) => text.includes("Tool call"))).toBe(false);
    await expect(page.locator(".tool-group")).toHaveCount(0);
    await expect(page.locator(".markdown-body").last()).toContainText("The tab query completed.");

    const toolBoxes = await page.getByTestId("chrome-tool-call").evaluateAll((items) => items.map((item) => {
      const box = item.getBoundingClientRect();
      const styles = getComputedStyle(item);
      return { top: box.top, bottom: box.bottom, borderWidth: styles.borderWidth };
    }));
    expect(toolBoxes[1].top - toolBoxes[0].bottom).toBeGreaterThanOrEqual(8);
    expect(toolBoxes.every((box) => box.borderWidth === "0px")).toBe(true);

    const layout = await page.evaluate(() => {
      const message = document.querySelector<HTMLElement>('[data-role="assistant"]:last-of-type');
      const footer = document.querySelector<HTMLElement>(".aui-thread-viewport-footer");
      if (!message || !footer) throw new Error("Assistant message layout was not rendered");
      return {
        messageBottom: message.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
      };
    });
    expect(layout.messageBottom).toBeLessThanOrEqual(layout.footerTop + 1);
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("supports a second user message after a tool response", async () => {
  const { context, page, userDataDirectory } = await openExtension();
  let requestCount = 0;
  const requestBodies: unknown[] = [];

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      requestCount += 1;
      requestBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: requestCount === 1 || requestCount === 3
          ? toolCallResponse(requestCount === 1 ? "first" : "second")
          : textResponse(requestCount === 2 ? "The first task completed." : "The second task completed."),
      });
    });

    await configureProvider(context, page);
    const composer = page.getByTestId("composer-input");
    await composer.fill("first task");
    await composer.press("Enter");
    await expect(page.locator(".markdown-body").last()).toContainText("The first task completed.");

    await composer.fill("second task");
    await composer.press("Enter");
    await expect(page.locator("[data-role=\"user\"]").last()).toContainText("second task");
    await expect(page.locator(".markdown-body").last()).toContainText("The second task completed.");
    expect(requestCount).toBe(4);
    expect(JSON.stringify(requestBodies[2])).not.toContain("side-agent-runtime");
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("retries a transient provider error and can send a later message", async () => {
  const { context, page, userDataDirectory } = await openExtension();
  let requestCount = 0;

  try {
    await context.route("https://provider.test/v1/chat/completions", async (route) => {
      requestCount += 1;
      if (requestCount === 2) {
        await route.fulfill({
          status: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "synthetic provider failure" } }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: requestCount === 1
          ? toolCallResponse("transient-error")
          : textResponse(requestCount === 3 ? "The first task recovered." : "The later task completed."),
      });
    });

    await configureProvider(context, page);
    const composer = page.getByTestId("composer-input");
    await composer.fill("first task");
    await composer.press("Enter");
    await expect(page.getByTestId("chrome-tool-call")).toHaveCount(2);
    await expect(page.locator(".markdown-body").last()).toContainText("The first task recovered.");

    await composer.fill("later task");
    await composer.press("Enter");
    await expect(page.locator("[data-role=\"user\"]").last()).toContainText("later task");
    await expect(page.locator(".markdown-body").last()).toContainText("The later task completed.");
    await expect(page.locator(".markdown-body").last()).toContainText("The later task completed.");
    expect(requestCount).toBe(4);
  } finally {
    await context.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
