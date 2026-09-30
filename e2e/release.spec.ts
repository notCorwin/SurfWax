import { expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openExtension, reloadUpgradedExtension, configure, dispose, startProvider, textResponse, commandResponse, chunk, readEvents, enableUserScripts, startNewConversation } from './fixtures';

test('fresh installation requests only the seven core permissions and leaves downloads ungranted', async () => {
  const opened = await openExtension();
  try {
    const manifest = await opened.page.evaluate(() => chrome.runtime.getManifest());
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    expect(manifest.version).toBe(version);
    expect(manifest.permissions).toEqual(['debugger', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage', 'userScripts']);
    expect(manifest.optional_permissions).toEqual(['downloads']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.devtools_page).toBeUndefined();
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ['downloads'] }))).toBe(false);
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
    expect(provider.requests[0].tools).toHaveLength(49);
  } finally { await dispose(opened.context, profile, provider.server); }
});

test('download denial keeps the artifact and cancellation issues no download', async () => {
  const responses: Parameters<typeof startProvider>[0] = [commandResponse('screenshot', { filename: 'permission.png', save: true }, 'first-save'), textResponse('SAVE_DENIED'), textResponse('下载授权')];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate(() => { chrome.permissions.request = async () => false; });
    await opened.page.getByTestId('composer-input').fill('save the screenshot locally');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.getByTestId('download-permission')).toBeVisible();
    expect((await readEvents(opened.page)).some(event => event.type === 'tool.result.data' && event.content?.filename === 'permission.png')).toBe(true);
    await opened.page.getByTestId('authorize-download').click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('SAVE_DENIED');
    const result = (await readEvents(opened.page)).find(event => event.toolCallId === 'first-save' && event.type === 'tool.failed');
    expect(JSON.stringify(result)).toContain('download-permission-denied');
    expect(await opened.page.evaluate(() => chrome.permissions.contains({ permissions: ['downloads'] }))).toBe(false);
    const artifact = (await readEvents(opened.page)).find(event => event.type === 'tool.result.data' && event.content?.filename === 'permission.png');
    responses.push(commandResponse('artifact-save', { id: artifact.id }, 'retry-save'), textResponse('SAVE_CANCELLED'));
    await opened.page.getByTestId('composer-input').fill('try saving the stored artifact again');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.getByTestId('download-permission')).toBeVisible();
    await opened.page.getByRole('button', { name: '停止生成' }).click();
    await expect(opened.page.getByTestId('download-permission')).toHaveCount(0);
    expect((await readEvents(opened.page)).filter(event => event.type === 'tool.result.data' && event.content?.filename === 'permission.png')).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test('rechecks a revoked download grant before saving an existing artifact', async () => {
  const responses: Parameters<typeof startProvider>[0] = [commandResponse('screenshot', { filename: 'grant.png', save: true }, 'grant-save'), textResponse('FIRST_SAVE_DONE'), textResponse('保存重试')];
  const provider = await startProvider(responses); const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    // Model the optional-permission boundary; the agent and authorization UI run unchanged.
    await opened.page.evaluate(() => {
      const state = { granted: false, downloads: 0, allow: true };
      Object.assign(globalThis, { __downloadTest: state });
      const contains = chrome.permissions.contains.bind(chrome.permissions);
      chrome.permissions.contains = async permissions => permissions.permissions?.includes('downloads') ? state.granted : contains(permissions);
      chrome.permissions.request = async () => { state.granted = state.allow; return state.granted; };
      Object.assign(chrome, { downloads: { download: async () => { if (!state.granted) throw new Error('Download attempted without permission'); state.downloads += 1; return 777; } } });
    });
    await opened.page.getByTestId('composer-input').fill('save the screenshot'); await opened.page.getByTestId('composer-input').press('Enter');
    await opened.page.getByTestId('authorize-download').click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('FIRST_SAVE_DONE');
    expect(await opened.page.evaluate(() => (globalThis as any).__downloadTest.downloads)).toBe(1);
    const artifact = (await readEvents(opened.page)).find(event => event.type === 'tool.result.data' && event.content?.filename === 'grant.png');
    await opened.page.evaluate(() => { Object.assign((globalThis as any).__downloadTest, { granted: false, allow: false }); });
    responses.push(commandResponse('artifact-save', { id: artifact.id }, 'revoked-save'), textResponse('REVOKED_SAVE_DENIED'));
    await opened.page.getByTestId('composer-input').fill('save the same artifact after revocation'); await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.getByTestId('download-permission')).toBeVisible(); await opened.page.getByTestId('authorize-download').click();
    await expect(opened.page.locator('.markdown-body').last()).toContainText('REVOKED_SAVE_DENIED');
    expect(await opened.page.evaluate(() => (globalThis as any).__downloadTest.downloads)).toBe(1);
    expect((await readEvents(opened.page)).filter(event => event.type === 'tool.result.data' && event.content?.filename === 'grant.png')).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
