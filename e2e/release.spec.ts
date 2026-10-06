import { expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openExtension, reloadUpgradedExtension, configure, configureWithImages, dispose, startProvider, textResponse, commandResponse, readEvents, enableUserScripts, startNewConversation } from './fixtures';

test('fresh installation grants all eight required permissions including downloads', async () => {
  const opened = await openExtension();
  try {
    const manifest = await opened.page.evaluate(() => chrome.runtime.getManifest());
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    expect(manifest.version).toBe(version);
    expect(manifest.permissions).toEqual(['debugger', 'downloads', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage', 'userScripts']);
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.devtools_page).toBeUndefined();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ['downloads'] }))).toBe(true);
    await expect(opened.page.getByTestId('config-required-state')).toBeVisible();
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});

test('upgrades a real 0.2.0 profile without changing branches, configuration, log IDs or script enabled state', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'surf-wax-upgrade-'));
  const extension = resolve(profile, 'extension');
  await cp(resolve('.dev/upgrade-v0.2.0/dist'), extension, { recursive: true });
  const responses = [textResponse('PERSISTED_BEFORE_UPGRADE'), textResponse('升级保留'), textResponse('BRANCH_BEFORE_UPGRADE')];
  const provider = await startProvider(responses);
  let opened = await openExtension(profile, { extensionPath: extension });
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await opened.page.evaluate(() => chrome.runtime.sendMessage({ type: 'surf-wax:user-scripts', method: 'create', args: [{ id: 'upgrade-enabled', matches: ['https://example.com/*'], js: [{ code: '1' }] }] }));
    await opened.page.evaluate(() => chrome.runtime.sendMessage({ type: 'surf-wax:user-scripts', method: 'create', args: [{ id: 'upgrade-disabled', matches: ['https://example.com/*'], js: [{ code: '2' }] }] }));
    await opened.page.evaluate(() => chrome.runtime.sendMessage({ type: 'surf-wax:user-scripts', method: 'setEnabled', args: [{ id: 'upgrade-disabled', enabled: false }] }));
    await opened.page.getByTestId('composer-input').fill('persist before upgrade');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('PERSISTED_BEFORE_UPGRADE');
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('升级保留');
    const originalReply = (await readEvents(opened.page)).find(event => event.type === 'conversation.message'
      && event.content?.parts?.some((part: any) => part.type === 'text' && part.text === 'PERSISTED_BEFORE_UPGRADE'))?.content.id;
    expect(originalReply).toBeTruthy();
    await opened.page.getByTestId('replay-message-button').click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('BRANCH_BEFORE_UPGRADE');
    await opened.page.getByRole('button', { name: '上一个分支' }).last().click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('PERSISTED_BEFORE_UPGRADE');
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === 'conversation.branch.selected').at(-1)?.content?.headId).toBe(originalReply);
    const previous = await readEvents(opened.page);
    const config = await opened.page.evaluate(() => chrome.storage.local.get('side-agent:model-config'));
    const id = opened.extensionId;
    await opened.context.close();
    await cp(resolve(process.env.SURFWAX_EXTENSION_PATH ?? 'dist'), extension, { recursive: true });
    opened = await openExtension(profile, { extensionPath: extension });
    await reloadUpgradedExtension(opened);
    expect(opened.extensionId).toBe(id);
    expect(await opened.page.evaluate(() => chrome.runtime.getManifest().version)).toBe(JSON.parse(await readFile('package.json', 'utf8')).version);
    expect(await opened.page.evaluate(() => chrome.storage.local.get('side-agent:model-config'))).toEqual(config);
    const restored = await readEvents(opened.page);
    for (const event of previous) expect(restored.find(item => item.id === event.id)).toEqual(event);
    await opened.page.getByTestId('conversation-menu').click();
    await opened.page.locator('.conversation-item', { hasText: '升级保留' }).locator('.conversation-select').click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('PERSISTED_BEFORE_UPGRADE');
    await opened.page.getByRole('button', { name: '下一个分支' }).last().click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('BRANCH_BEFORE_UPGRADE');
    await opened.page.getByRole('button', { name: '上一个分支' }).last().click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('PERSISTED_BEFORE_UPGRADE');
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    await expect.poll(() => opened.page.evaluate(async () => (await chrome.userScripts.getScripts()).map(script => script.id))).toContain('upgrade-enabled');
    expect(await opened.page.evaluate(async () => (await chrome.userScripts.getScripts()).map(script => script.id))).not.toContain('upgrade-disabled');
    const scripts = await opened.page.evaluate(() => chrome.runtime.sendMessage({ type: 'surf-wax:user-scripts', method: 'list', args: [] }));
    expect(scripts.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'upgrade-disabled', enabled: false })]));
    // Validate the upgraded runtime as well as preserving its data. Replacing
    // unpacked files without reloading can leave Chrome's old worker cached.
    await startNewConversation(opened.page);
    provider.requests.length = 0;
    responses.push(textResponse('UPGRADED_RUNTIME_READY'), textResponse('升级验证'));
    await opened.page.getByTestId('composer-input').fill('verify the upgraded runtime');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('UPGRADED_RUNTIME_READY');
    expect(provider.requests[0].tools).toHaveLength(3);
  } finally { await dispose(opened.context, profile, provider.server); }
});

test('download failure retains the artifact and a retry saves it without requesting permission or recapturing', async () => {
  const responses: Parameters<typeof startProvider>[0] = [commandResponse("run", { code: `return await page.screenshot(${JSON.stringify({ filename: 'retained.png', save: true })});` }, 'failed-save'), textResponse('SAVE_FAILED'), textResponse('保存重试')];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate(() => {
      const state = { attempts: 0, fail: true, permissionRequests: 0 };
      Object.assign(globalThis, { __downloadTest: state });
      chrome.permissions.request = async () => { state.permissionRequests += 1; throw new Error('Unexpected runtime permission request'); };
      chrome.downloads.download = async () => { state.attempts += 1; if (state.fail) throw new Error('Download failed'); return 777; };
    });
    await opened.page.getByTestId('composer-input').fill('save the screenshot locally');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('SAVE_FAILED');
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('保存重试');
    await expect(opened.page.getByTestId('download-permission')).toHaveCount(0);
    const events = await readEvents(opened.page);
    const artifact = events.find(event => event.type === 'tool.result.data' && event.content?.filename === 'retained.png');
    expect(artifact).toBeTruthy();
    expect(events.find(event => event.toolCallId === 'failed-save' && event.type === 'tool.failed')?.output)
      .toMatchObject({ artifact: { id: artifact.id, filename: 'retained.png', saved: false } });
    await opened.page.evaluate(() => { (globalThis as any).__downloadTest.fail = false; });
    responses.push(commandResponse("run", { code: `return await artifacts.save(${JSON.stringify(artifact.id)},${JSON.stringify(undefined)});` }, 'retry-save'), textResponse('SAVE_RETRIED'));
    await opened.page.getByTestId('composer-input').fill('save the stored artifact again');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('SAVE_RETRIED');
    expect(await opened.page.evaluate(() => (globalThis as any).__downloadTest)).toMatchObject({ attempts: 2, permissionRequests: 0 });
    expect((await readEvents(opened.page)).filter(event => event.type === 'tool.result.data' && event.content?.filename === 'retained.png')).toHaveLength(1);
    expect((await readEvents(opened.page)).find(event => event.type === 'tool.finished' && event.toolCallId === 'retry-save')?.output.result)
      .toMatchObject({ artifact: { id: artifact.id, saved: true, downloadId: 777 } });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('stopping a pending download retains its artifact and closes the tool once', async () => {
  const provider = await startProvider([commandResponse("run", { code: `return await page.screenshot(${JSON.stringify({ filename: 'pending.png', save: true })});` }, 'pending-save')]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate(() => {
      chrome.downloads.download = () => new Promise<number>(resolveDownload => {
        Object.assign(globalThis, { __finishDownload: () => resolveDownload(777) });
      });
    });
    await opened.page.getByTestId('composer-input').fill('save the screenshot'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => opened.page.evaluate(() => typeof (globalThis as any).__finishDownload)).toBe('function');
    await opened.page.getByRole('button', { name: '停止生成' }).click();
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === 'tool.failed' && event.toolCallId === 'pending-save').length).toBe(1);
    await opened.page.evaluate(() => (globalThis as any).__finishDownload());
    await expect(opened.page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    const events = await readEvents(opened.page);
    expect(events.filter(event => event.type === 'tool.result.data' && event.content?.filename === 'pending.png')).toHaveLength(1);
    const terminal = events.filter(event => ['tool.failed', 'tool.finished'].includes(event.type) && event.toolCallId === 'pending-save');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      content: { status: 'interrupted', effectUnknown: true },
      output: { error: { code: 'aborted', retryable: false, effectUnknown: true }, artifact: { filename: 'pending.png' } },
      abort: { reason: { $type: 'error', name: 'AbortError' } },
    });
    await expect.poll(async () => (await readEvents(opened.page)).reverse().find(event => event.type === 'browser.job.state' && event.toolCallId === 'pending-save')?.content.state).toBe('cancelled');
    await expect(opened.page.getByTestId('download-permission')).toHaveCount(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
