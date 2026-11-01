import { expect, test, startProvider, textResponse, delayedResponse, assistantResponse, configure, openExtension, dispose, readEvents, startNewConversation, focusPageControl } from './fixtures';

const largeReply = 'OLD_CONTEXT_MARKER ' + 'page observation '.repeat(8_000);
const summary = 'Earlier page observations and the user request have been recorded.';

test('automatically summarizes after a completed turn and preserves the full canonical history', async () => {
  const provider = await startProvider([textResponse(largeReply), textResponse('压缩测试'), textResponse('COMPACTED_REPLY')], 0, summary);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 50_000)).close();
    const composer = opened.page.getByTestId('composer-input');
    await composer.fill('first request'); await composer.press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('OLD_CONTEXT_MARKER');
    await expect(opened.page.getByTestId('context-status')).toContainText('历史上下文已被压缩成摘要');
    await expect(opened.page.getByTestId('context-choice')).toHaveCount(0);
    await expect(composer).toBeEnabled();
    const events = await readEvents(opened.page);
    const checkpoint = events.find(event => event.type === 'context.compacted');
    expect(checkpoint?.content).toEqual(expect.objectContaining({ strategy: 'summary', sourceCount: expect.any(Number), sourceDigest: expect.any(String), summaryDigest: expect.any(String), branchIds: expect.any(Array) }));
    expect(JSON.stringify(events.filter(event => event.type === 'conversation.message'))).toContain('OLD_CONTEXT_MARKER');
    await composer.fill('continue'); await composer.press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('COMPACTED_REPLY');
    const final = [...provider.requests].reverse().find(request => JSON.stringify(request.messages).includes('continue'));
    expect(JSON.stringify(final?.messages)).toContain(summary);
    expect(JSON.stringify(final?.messages)).not.toContain('OLD_CONTEXT_MARKER');
    await opened.page.getByTestId('conversation-menu').click(); await startNewConversation(opened.page);
    await expect(opened.page.getByTestId('context-status')).toHaveCount(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("updates context usage from a completed reply and shows structured details", async () => {
  let releaseReply!: () => void;
  const replyMayFinish = new Promise<void>((resolve) => { releaseReply = resolve; });
  const provider = await startProvider([
    delayedResponse(textResponse("LIVE_CONTEXT_MARKER " + "page state ".repeat(2_000) + " CONTEXT_COMPLETE",
      { promptTokens: 2_000, completionTokens: 800, cachedTokens: 500 }), 0, replyMayFinish),
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
    await focusPageControl(opened.page, indicator);
    const tooltip = opened.page.getByRole("tooltip");
    await expect(tooltip).toContainText("估算输入占用");
    await expect(tooltip).toContainText("系统提示词、工具定义和当前对话");
    await expect(opened.page.getByTestId("context-estimate")).toContainText("/ 100,000 tokens");
    await expect(opened.page.getByTestId("context-input")).toHaveText("暂无调用");
    await expect(tooltip).toContainText("输入");
    await expect(tooltip).toContainText("输出");
    await expect(tooltip).toContainText("缓存命中");
    await expect(opened.page.getByTestId("context-detail-progress")).toHaveAttribute("aria-valuenow", String(initial));
    const box = await tooltip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);

    await opened.page.getByTestId("composer-input").fill("measure context after completion");
    await opened.page.getByTestId("composer-input").press("Enter");
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-token-usage")).toBeVisible();
    releaseReply();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CONTEXT_COMPLETE");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).not.toBe(initial);
    await expect(opened.page.getByTestId("context-input")).toHaveText("2,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toHaveText("800 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toHaveText("500 tokens");
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("distinguishes unreported usage from zero and partial totals", async () => {
  const provider = await startProvider([
    textResponse("NO_USAGE_REPLY"),
    textResponse("用量测试"),
    textResponse("REPORTED_USAGE_REPLY", { promptTokens: 2000, completionTokens: 0, cachedTokens: 0 }),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 100_000)).close();
    const composer = opened.page.getByTestId("composer-input");
    const indicator = opened.page.getByTestId("context-indicator");
    await composer.fill("first");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NO_USAGE_REPLY");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toHaveText("未提供");
    await expect(opened.page.getByTestId("context-output")).toHaveText("未提供");
    await composer.fill("second");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REPORTED_USAGE_REPLY");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toHaveText("至少 2,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toHaveText("至少 0 tokens");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("updates context while a reply is pending and when switching branches", async () => {
  let releaseReply!: () => void;
  const replyMayFinish = new Promise<void>((resolve) => { releaseReply = resolve; });
  const provider = await startProvider([
    delayedResponse(textResponse("LONG_BRANCH " + "page observation ".repeat(2_000)), 0, replyMayFinish),
    textResponse("上下文分支测试"),
    textResponse("SHORT_BRANCH"),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL, 100_000);
    await options.close();
    const indicator = opened.page.getByTestId("context-indicator");
    await expect(indicator).toHaveAttribute("data-state", "ready");
    const initial = Number(await indicator.getAttribute("data-used-percent"));

    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("pending request ".repeat(1_000));
    await composer.press("Enter");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBeGreaterThan(initial);

    releaseReply();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LONG_BRANCH");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("上下文分支测试");
    await expect(opened.page.getByTestId("replay-message-button")).toBeVisible();
    let longPercent = 0;
    await expect.poll(async () => {
      longPercent = Number(await indicator.getAttribute("data-used-percent"));
      return longPercent;
    }).toBeGreaterThan(initial + 5);

    await opened.page.getByTestId("replay-message-button").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SHORT_BRANCH");
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBeLessThan(longPercent);
    await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LONG_BRANCH");
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBe(longPercent);
  } finally {
    releaseReply();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("anchors context usage to provider-reported input tokens", async () => {
  const provider = await startProvider([
    assistantResponse({ tool_calls: [{ id: "call-usage-e2e", type: "function", function: { name: "list_tabs", arguments: "{}" } }] }, { promptTokens: 10_000, completionTokens: 5, cachedTokens: 3_000 }),
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
      .toBeGreaterThanOrEqual(30);

    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toContainText("40,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toContainText("10 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("15,000 tokens");

    await opened.page.getByTestId("composer-input").fill("measure cumulative usage");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_USAGE_REPLY");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toContainText("60,000 tokens");
    await expect(opened.page.getByTestId("context-output")).toContainText("15 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("22,000 tokens");
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test('a summary failure keeps original history and exposes a retry that creates a verified checkpoint', async () => {
  const provider = await startProvider([textResponse(largeReply), textResponse('摘要重试')], 0, summary, ['minimal'], 0, 1);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 75_000)).close();
    await opened.page.getByTestId('composer-input').fill('retain original history on failure'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.getByTestId('context-maintenance-error')).toBeVisible();
    let events = await readEvents(opened.page);
    expect(events.some(event => event.type === 'context.compaction.failed')).toBe(true);
    expect(events.some(event => event.type === 'context.compacted')).toBe(false);
    expect(JSON.stringify(events.filter(event => event.type === 'conversation.message'))).toContain('OLD_CONTEXT_MARKER');
    await expect(opened.page.getByTestId('composer-input')).toBeEnabled();
    await opened.page.getByRole('button', { name: '重试压缩' }).click();
    await expect(opened.page.getByTestId('context-status')).toContainText('历史上下文已被压缩成摘要');
    events = await readEvents(opened.page);
    expect(events.filter(event => event.type === 'context.compacted')).toHaveLength(1);
    expect(provider.stats.summaryCalls).toBeGreaterThanOrEqual(2);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('stopping background summarization leaves the source log intact and no partial checkpoint', async () => {
  const provider = await startProvider([textResponse(largeReply), textResponse('停止摘要')], 0, summary, ['minimal'], 2_000);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 75_000)).close();
    await opened.page.getByTestId('composer-input').fill('test summary cancellation'); await opened.page.getByTestId('composer-input').press('Enter');
    await opened.page.getByRole('button', { name: '停止压缩' }).click();
    await expect(opened.page.getByTestId('context-status')).toContainText('上下文压缩已停止');
    await expect(opened.page.getByTestId('composer-input')).toBeEnabled();
    const events = await readEvents(opened.page);
    expect(events.some(event => event.type === 'context.compaction.aborted')).toBe(true);
    expect(events.some(event => event.type === 'context.compacted')).toBe(false);
    expect(JSON.stringify(events.filter(event => event.type === 'conversation.message'))).toContain('OLD_CONTEXT_MARKER');
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('automatically summarizes and retries the same request after provider context overflow', async () => {
  const provider = await startProvider([{ status: 400, error: 'maximum context length exceeded' }, textResponse('OVERFLOW_RECOVERED'), textResponse('超长恢复')], 0, summary);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 100_000)).close();
    await opened.page.getByTestId('composer-input').fill('overflow request'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('OVERFLOW_RECOVERED');
    await expect(opened.page.getByTestId('context-choice')).toHaveCount(0);
    const events = await readEvents(opened.page);
    expect(events.some(event => event.type === 'context.compacted')).toBe(true);
    expect(events.some(event => event.type === 'context.choice.required')).toBe(false);
    const agentRequests = provider.requests.filter(request => request.tools?.length);
    expect(agentRequests).toHaveLength(2);
    expect(agentRequests[0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['inspect_page', 'get_page_info']));
    expect(agentRequests[1].tools).toEqual(agentRequests[0].tools);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
