import { expect, test, startProvider, textResponse, streamingTextResponse, toolResponse, configure, openExtension, dispose, readEvents, startNewConversation, focusPageControl } from './fixtures';

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
    const final = [...provider.requests].reverse().find(request => request.stream === true && JSON.stringify(request.messages).includes('continue'));
    expect(JSON.stringify(final?.messages)).toContain(summary);
    expect(JSON.stringify(final?.messages)).not.toContain('OLD_CONTEXT_MARKER');
    await opened.page.getByTestId('conversation-menu').click(); await startNewConversation(opened.page);
    await expect(opened.page.getByTestId('context-status')).toHaveCount(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
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
    await focusPageControl(opened.page, indicator);
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

    await opened.page.evaluate(() => {
      Object.assign(window, { __tokenAnimationSeen: false });
      new MutationObserver((mutations) => {
        if (mutations.some(({ target }) => target instanceof Element
          && target.getAttribute("data-testid") === "context-token-usage"
          && target.getAttribute("data-animating") === "true")) {
          Object.assign(window, { __tokenAnimationSeen: true });
        }
      }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-animating"] });
    });

    await opened.page.getByTestId("composer-input").fill("stream context now");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LIVE_CONTEXT_MARKER");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toHaveText("0 tokens");
    await expect(opened.page.getByTestId("context-output")).toHaveText("0 tokens");
    await expect(opened.page.getByTestId("context-cache-read")).toContainText("0 tokens");
    await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBeGreaterThan(initial);
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STREAM_COMPLETE");
    await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
    await expect(opened.page.getByTestId("context-token-usage")).toHaveAttribute("data-animating", "false");
    expect(await opened.page.evaluate(() => (window as typeof window & { __tokenAnimationSeen?: boolean }).__tokenAnimationSeen)).toBe(true);
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


test('resolves a persisted legacy context gate automatically when the conversation reopens', async () => {
  const provider = await startProvider([textResponse('LEGACY_CONTEXT_HISTORY'), textResponse('旧对话标题'), textResponse('LATE_COMPACTION_REPLY')], 0, summary);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 100_000)).close();
    await opened.page.getByTestId('composer-input').fill('preserve this old request'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('旧对话标题');
    const events = await readEvents(opened.page);
    const conversationId = events.find(event => event.type === 'conversation.created').conversationId;
    const branchIds = events.filter(event => event.type === 'conversation.message' && event.conversationId === conversationId).map(event => event.content.id);
    await opened.page.evaluate(async ({ conversationId, branchIds }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('side-agent-runtime'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const transaction = db.transaction('events', 'readwrite');
      transaction.objectStore('events').add({ type: 'context.choice.required', timestamp: new Date().toISOString(), conversationId, content: { branchIds, reason: 'pressure' } });
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); db.close();
    }, { conversationId, branchIds });
    await opened.page.reload(); await opened.page.getByTestId('conversation-menu').click();
    await opened.page.locator('.conversation-item', { hasText: '旧对话标题' }).locator('.conversation-select').click();
    await expect(opened.page.getByTestId('context-status')).toContainText('历史上下文已被压缩成摘要');
    await expect(opened.page.getByTestId('context-choice')).toHaveCount(0);
    expect((await readEvents(opened.page)).some(event => event.type === 'context.choice.resolved' && event.content?.automatic === true)).toBe(true);
    await opened.page.getByTestId('composer-input').fill('continue'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('LATE_COMPACTION_REPLY');
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('a summary failure keeps original history and exposes a retry that creates a verified checkpoint', async () => {
  const provider = await startProvider([textResponse(largeReply), textResponse('摘要重试')], 0, summary, ['minimal'], 0, 1);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 50_000)).close();
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
    await (await configure(opened.context, opened.page, provider.baseURL, 50_000)).close();
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
    const agentRequests = provider.requests.filter(request => request.stream === true && request.tools?.length);
    expect(agentRequests).toHaveLength(2);
    expect(agentRequests.map(request => request.tools.length)).toEqual([3, 3]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
