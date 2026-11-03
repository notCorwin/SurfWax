import { expect, test, configure, delayedResponse, dispose, openExtension, readEvents, startProvider, textResponse } from './fixtures';

test('canonical session commits synchronize panels and the next request includes remote progress', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = await startProvider([
    textResponse('FIRST_CANONICAL_REPLY'), textResponse('Shared session'),
    delayedResponse(textResponse('REMOTE_CANONICAL_PROGRESS'), 0, gate),
    textResponse('CONTINUED_FROM_REMOTE_PROGRESS'),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const composer = opened.page.getByTestId('composer-input');
    await composer.fill('Start a shared task');
    await composer.press('Enter');
    await expect(opened.page.locator('.markdown-body')).toContainText('FIRST_CANONICAL_REPLY');
    await expect.poll(() => provider.requests.length).toBe(2);
    const other = await opened.context.newPage();
    await other.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    await other.getByTestId('conversation-menu').click();
    await other.getByRole('button', { name: 'Shared session', exact: true }).click();
    await expect(other.locator('.markdown-body')).toContainText('FIRST_CANONICAL_REPLY');
    await other.getByTestId('conversation-menu').click();
    await other.getByRole('button', { name: '搜索会话', exact: true }).click();
    await other.getByRole('searchbox', { name: '搜索会话' }).fill('FIRST_CANONICAL_REPLY');
    await expect(other.locator('.conversation-select')).toHaveCount(1);
    await other.keyboard.press('Escape');
    await composer.fill('Produce the next verified progress');
    await composer.press('Enter');
    await expect(other.getByTestId('other-run-busy')).toBeVisible();
    await expect(other.getByTestId('composer-input')).toBeDisabled();
    await expect.poll(async () => (await readEvents(other)).filter(event => event.type === 'conversation.submitted').length).toBe(2);
    release();
    await expect(other.locator('.markdown-body').last()).toContainText('REMOTE_CANONICAL_PROGRESS');
    await expect(other.getByTestId('composer-input')).toBeEnabled();
    await other.getByTestId('conversation-menu').click();
    await other.getByRole('button', { name: '搜索会话', exact: true }).click();
    await other.getByRole('searchbox', { name: '搜索会话' }).fill('REMOTE_CANONICAL_PROGRESS');
    await expect(other.locator('.conversation-select')).toHaveCount(1);
    await other.keyboard.press('Escape');
    await other.getByTestId('composer-input').fill('Continue using all prior progress');
    await other.getByTestId('composer-input').press('Enter');
    await expect(other.locator('.markdown-body').last()).toContainText('CONTINUED_FROM_REMOTE_PROGRESS');
    const requests = provider.requests.filter(request => request.tools?.length);
    expect(JSON.stringify(requests.at(-1).messages)).toContain('REMOTE_CANONICAL_PROGRESS');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('CONTINUED_FROM_REMOTE_PROGRESS');
  } finally {
    release();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
