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
