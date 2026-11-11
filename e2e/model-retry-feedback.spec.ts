import { expect } from "@playwright/test";
import { configure, dispose, openExtension, nativePanel, readNativeEvents, submitNative, readEvents, startProvider, test, textResponse } from "./fixtures";

for (const status of [429, 503] as const) {
  test(`HTTP ${status} shows safe decreasing backoff then clears on recovery`, async () => {
    const provider = await startProvider([textResponse("RECOVERED"), textResponse("title")]);
    const opened = await openExtension();
    let requests = 0;
    try {
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await opened.page.route(`${provider.baseURL}/chat/completions`, async route => {
        if (!route.request().postDataJSON()?.tools?.length) { await route.continue(); return; }
        requests++;
        if (requests === 1) await route.fulfill({ status, headers: { "content-type": "application/json", "retry-after": "3" }, body: JSON.stringify({ error: { message: "SECRET https://secret.test/?api_key=secret" } }) });
        else await route.continue();
      });
      await opened.page.getByTestId("composer-input").fill("hello");
      await opened.page.getByTestId("composer-input").press("Enter");
      const retry = opened.page.getByTestId("request-retry");
      await expect(retry).toContainText(status === 429 ? "请求受到限制" : "服务暂时不可用");
      await expect(retry).toContainText("3 秒后重试");
      await expect(retry).toContainText("2 秒后重试");
      expect(await opened.page.locator("body").innerText()).not.toMatch(/SECRET|secret.test|api_key/);
      await expect(opened.page.locator('[data-role="assistant"]')).toContainText("RECOVERED");
      await expect(retry).toHaveCount(0);
      expect(requests).toBe(2);
      const events = await readEvents(opened.page);
      expect(events.filter(event => event.type === "request.retry")).toHaveLength(1);
      expect(events.filter(event => event.type === "model.request.retrying")).toHaveLength(0);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

test("pause during backoff cancels the retry and a new run remains usable", async () => {
  const provider = await startProvider([textResponse("NEW_RUN"), textResponse("title")]);
  const opened = await openExtension();
  let requests = 0;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.route(`${provider.baseURL}/chat/completions`, async route => {
      if (!route.request().postDataJSON()?.tools?.length) { await route.continue(); return; }
      requests++;
      if (requests === 1) await route.fulfill({ status: 429, headers: { "content-type": "application/json", "retry-after": "3" }, body: '{"error":{"message":"busy"}}' });
      else await route.continue();
    });
    await opened.page.getByTestId("composer-input").fill("hello");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.getByTestId("request-retry")).toBeVisible();
    await opened.page.getByRole("button", { name: "停止生成", exact: true }).click();
    await expect(opened.page.getByTestId("request-retry")).toHaveCount(0);
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === "conversation.aborted").length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(requests).toBe(1);
    await opened.page.getByTestId("composer-input").fill("continue");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator('[data-role="assistant"]').last()).toContainText("NEW_RUN");
    expect(requests).toBe(2);
    await expect(opened.page.getByTestId("request-retry")).toHaveCount(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("transport timeouts show classified backoff and clear after the existing retries", async () => {
  const provider = await startProvider([textResponse("TIMEOUT_RECOVERED"), textResponse("title")]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate((baseURL) => {
      const original = window.fetch.bind(window);
      let attempts = 0;
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url === `${baseURL}/chat/completions` && request.method === "POST" && (await request.clone().json()).tools?.length) {
          document.documentElement.dataset.retryRequests = String(++attempts);
          if (attempts <= 5) throw new DOMException("SECRET https://secret.test/?api_key=secret", "TimeoutError");
        }
        return original(request);
      };
    }, provider.baseURL);
    await opened.page.getByTestId("composer-input").fill("hello");
    await opened.page.getByTestId("composer-input").press("Enter");
    const retry = opened.page.getByTestId("request-retry");
    await expect(retry).toContainText("请求超时");
    await expect(retry).toContainText(/第 [45] 次自动重试：[2-5] 秒后重试/);
    const text = await retry.innerText();
    await expect(retry).not.toHaveText(text);
    expect(await opened.page.locator("body").innerText()).not.toMatch(/SECRET|secret.test|api_key/);
    await expect(opened.page.locator('[data-role="assistant"]')).toContainText("TIMEOUT_RECOVERED");
    await expect(retry).toHaveCount(0);
    await expect(opened.page.locator("html")).toHaveAttribute("data-retry-requests", "6");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("closing the native panel during backoff cancels its request and leaves no stale retry on reopen", async () => {
  const provider = await startProvider([{ status: 503, error: "busy", headers: { "retry-after": "3" } }, textResponse("AFTER_CLOSE"), textResponse("title")]);
  const opened = await openExtension();
  const requests = () => provider.requests.filter(request => request.tools?.length).length;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/target`);
    await submitNative(native.panel, "hello");
    await expect.poll(() => native.panel.evaluate<string>('document.querySelector(\'[data-testid="request-retry"]\')?.textContent || ""')).toContain("服务暂时不可用");
    const runId = (await readNativeEvents(native.panel)).reverse().find(event => event.type === "conversation.submitted")!.runId;
    await native.panel.close();
    await native.browser.send("Target.closeTarget", { targetId: native.targetId });
    const recovery = await opened.context.newPage();
    await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await expect.poll(async () => (await readEvents(recovery)).filter(event => event.runId === runId && event.type === "conversation.aborted").length).toBe(1);
    await expect(recovery.getByTestId("request-retry")).toHaveCount(0);
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(requests()).toBe(1);
    await recovery.getByTestId("composer-input").fill("continue");
    await recovery.getByTestId("composer-input").press("Enter");
    await expect(recovery.locator('[data-role="assistant"]').last()).toContainText("AFTER_CLOSE");
    expect(requests()).toBe(2);
    await expect(recovery.getByTestId("request-retry")).toHaveCount(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("permanent authentication failure stays safe and offers retry without automatic requests", async () => {
  const provider = await startProvider([{ status: 401, error: "SECRET https://secret.test/?api_key=secret" }]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.getByTestId("composer-input").fill("hello");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === "conversation.failed").length).toBe(1);
    await expect(opened.page.getByTestId("request-retry")).toHaveCount(0);
    await opened.page.getByText("错误详情", { exact: true }).click();
    await expect(opened.page.locator("body")).toContainText("认证失败，请检查 API 密钥和访问权限。");
    expect(await opened.page.locator("body").innerText()).not.toMatch(/SECRET|secret.test|api_key/);
    await expect(opened.page.getByRole("button", { name: "重新生成回复", exact: true })).toBeEnabled();
    expect(provider.requests.filter(request => request.tools?.length)).toHaveLength(1);
    expect((await readEvents(opened.page)).filter(event => event.type === "request.retry")).toHaveLength(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
