import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { SSE_HEADERS, p95, chunk, usageChunk, textResponse, streamingTextResponse, toolResponse, pageResponse, commandResponse, browserResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

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
    await opened.context.route("https://models.dev/api.json", (route) => route.fulfill({ json: {
      vercel: { name: "Vercel AI Gateway", npm: "@ai-sdk/gateway", models: {
        "openai/gpt-test": { name: "GPT Test", tool_call: true, modalities: { output: ["text"] }, limit: { context: 100_000 } },
      } },
    } }));
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
    await options.getByLabel("Model ID", { exact: true }).click();
    await options.getByLabel("Model ID", { exact: true }).fill("GPT Test");
    await options.getByLabel("Model ID", { exact: true }).press("ArrowDown");
    await options.getByRole("option", { name: /GPT Test.*openai\/gpt-test/ }).click();
    await options.getByLabel("API Key", { exact: true }).fill("vercel-key");
    await options.getByRole("button", { name: "保存配置" }).click();

    await expect.poll(() => options.evaluate(async () =>
      ((await chrome.storage.local.get("side-agent:model-limit"))["side-agent:model-limit"] as any)?.match?.source)).toBe("models.dev");
    await expect(options.getByTestId("model-limit-match")).toHaveCount(0);

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


test("refreshes Models.dev providers and models on every settings open", async () => {
  const opened = await openExtension();
  try {
    let version = 1;
    let requests = 0;
    await opened.page.evaluate(() => chrome.storage.local.set({ "side-agent:model-catalog": { fetchedAt: Date.now(), catalog: {
      cached: { name: "Cached Provider", npm: "@ai-sdk/openai-compatible", models: {} },
    } } }));
    await opened.context.route("https://models.dev/api.json", (route) => {
      requests += 1;
      const id = version === 1 ? "first" : "second";
      return route.fulfill({ json: { [id]: { name: `${id} Provider`, npm: "@ai-sdk/openai-compatible",
        models: { [`${id}-model`]: { name: `${id} Model`, tool_call: true, modalities: { output: ["text"] } } },
      } } });
    });

    const [first] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await selectProvider(first, "first", /first Provider.*first/);
    await first.getByLabel("Model ID", { exact: true }).click();
    await expect(first.getByRole("option", { name: /first Model.*first-model/ })).toBeVisible();
    await first.close();

    version = 2;
    const [second] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await selectProvider(second, "second", /second Provider.*second/);
    await second.getByLabel("Model ID", { exact: true }).click();
    await expect(second.getByRole("option", { name: /second Model.*second-model/ })).toBeVisible();
    expect(requests).toBe(2);
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});


test("persists multi-field credentials and interpolates template Endpoints", async () => {
  const opened = await openExtension();
  try {
    await opened.context.route("https://models.dev/api.json", (route) => route.fulfill({ json: {
      bedrock: { name: "Amazon Bedrock", npm: "@ai-sdk/amazon-bedrock", models: {} },
      template: { name: "Template Provider", npm: "@ai-sdk/openai-compatible", api: "https://api.example/${ACCOUNT}/v1", models: {} },
    } }));
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


test("labels cached Models.dev providers when refresh fails", async () => {
  const opened = await openExtension();
  try {
    await opened.page.evaluate(() => chrome.storage.local.set({ "side-agent:model-catalog": { fetchedAt: Date.now(), catalog: {
      cached: { name: "Cached Provider", npm: "@ai-sdk/openai-compatible", models: {} },
    } } }));
    await opened.context.route("https://models.dev/api.json", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    const [options] = await Promise.all([opened.context.waitForEvent("page"), opened.page.getByTestId("open-settings").click()]);
    await expect(options.getByText("Models.dev 暂时不可用，正在使用缓存目录（1 个 Provider）。")).toBeVisible();
    await selectProvider(options, "cached", /Cached Provider.*cached/);
  } finally {
    await dispose(opened.context, opened.userDataDirectory);
  }
});


test("uses a global custom system prompt and hides disabled advanced settings", async () => {
  const provider = await startProvider([textResponse("CUSTOM_PROMPT_OK"), textResponse("自定义提示词")]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await expect(options.getByRole("group", { name: "上下文窗口" })).toBeVisible();
    await expect(options.getByTestId("model-limit-match")).toContainText("262,144 tokens");
    await options.getByLabel("自定义系统提示词").fill("You are a custom browser agent.");
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await expect.poll(() => options.evaluate(async () =>
      ((await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"] as any)?.systemPrompt))
      .toBe("You are a custom browser agent.");
    await options.close();

    await opened.page.getByTestId("composer-input").fill("use custom instructions");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CUSTOM_PROMPT_OK");
    const system = provider.requests[0].messages.find((message: any) => message.role === "system");
    const user = provider.requests[0].messages.find((message: any) => message.role === "user");
    expect(system?.content).toBe("You are a custom browser agent.");
    expect(JSON.stringify(user)).toContain("Available tools:");
    expect(JSON.stringify(user)).toContain("- goto: Navigate the current tab to a URL.");
    await expect(opened.page.locator('[data-role="user"]')).not.toContainText("Available tools:");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
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
    await expect(effort).toHaveText("低");
    await effort.click();
    await expect(opened.page.getByRole("option")).toHaveText(["关闭", "低", "高"]);
    await opened.page.getByRole("option", { name: "高" }).click();
    await expect(effort).toHaveText("高");
    await opened.page.keyboard.press("Escape");
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


