import { expect } from '@playwright/test';
import { configure, delayedResponse, dispose, openExtension, startProvider, test, textResponse } from './fixtures';

test('queued follow-up sends once after the current run succeeds', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = await startProvider([delayedResponse(textResponse('FIRST_DONE'), 0, gate), textResponse('NEXT_DONE'), textResponse('NEXT_DONE'), textResponse('NEXT_DONE')]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId('composer-input');
    await composer.fill('First request');
    await composer.press('Enter');
    await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
    await composer.fill('Queued request');
    await composer.press('Enter');
    await expect(opened.page.getByTestId('followup-item')).toContainText('Queued request');
    release();
    await expect(opened.page.getByTestId('followup-item')).toHaveCount(0, { timeout: 30000 });
    await expect(opened.page.getByText('Queued request', { exact: true })).toHaveCount(1);
    await expect.poll(() => provider.requests.filter(request => JSON.stringify(request.messages).includes('Queued request')).length, { timeout: 30000 }).toBe(1);
  } finally {
    release();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test('failed queued dispatch stays available for an explicit retry', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = await startProvider([delayedResponse(textResponse('FIRST_DONE'), 0, gate), textResponse('NEXT_DONE')]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId('composer-input');
    await composer.fill('First request');
    await composer.press('Enter');
    await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
    await composer.fill('Queued retry');
    await composer.press('Enter');
    await expect(opened.page.getByTestId('followup-item')).toContainText('Queued retry');
    await opened.page.evaluate(() => {
      const runtime = chrome.runtime;
      const original = runtime.sendMessage.bind(runtime);
      (window as unknown as { restoreRunStatus: () => void }).restoreRunStatus = () => { runtime.sendMessage = original; };
      runtime.sendMessage = ((...args: unknown[]) => {
        const message = args[0] as { type?: string } | undefined;
        if (message?.type === 'surf-wax:run-status') return Promise.reject(new Error('injected owner failure'));
        return (original as (...values: unknown[]) => unknown)(...args);
      }) as typeof runtime.sendMessage;
    });
    release();
    await expect(opened.page.getByText('排队消息未能发送，请重试。')).toBeVisible({ timeout: 30000 });
    const item = opened.page.getByTestId('followup-item');
    await expect(item).toContainText('Queued retry');
    await expect(item.getByRole('button', { name: '立即发送' })).toBeEnabled();
    await expect(item.getByRole('button', { name: '移除排队消息' })).toBeEnabled();
    expect(provider.requests.filter(request => JSON.stringify(request.messages).includes('Queued retry'))).toHaveLength(0);
    await opened.page.evaluate(() => (window as unknown as { restoreRunStatus: () => void }).restoreRunStatus());
    await item.getByRole('button', { name: '立即发送' }).click();
    await expect(item).toHaveCount(0, { timeout: 30000 });
    await expect.poll(() => provider.requests.filter(request => JSON.stringify(request.messages).includes('Queued retry')).length, { timeout: 30000 }).toBe(1);
  } finally {
    release();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
