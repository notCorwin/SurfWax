import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, openExtension, dispose } from './fixtures';

test('browser internal and local file pages report their access boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfwax-boundary-'));
  await writeFile(join(dir, 'page.html'), '<title>Local boundary</title><p>LOCAL-BOUNDARY-CANARY</p>');
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId('open-settings')).toBeVisible();
    const result = await opened.page.evaluate(async ({ dev, fileUrl }) => {
      const [{ EventLogger }, { createMemoryEventStore }, { ChromeExecutor }, { createProgramTools }, { claimConversationRun }] = await Promise.all(
        ['logging.ts', 'memory-event-store.ts', 'chrome/executor.ts', 'chrome/tool.ts', 'agent/coordinator.ts'].map(p => import(`${dev}/src/${p}`)),
      );
      const conversationId = crypto.randomUUID(), lease = await claimConversationRun(conversationId);
      const logger = new EventLogger({ store: createMemoryEventStore([]) });
      logger.beginRun(conversationId, lease.runId);
      const executor = new ChromeExecutor({ logger });
      await executor.beginRun();
      const tools = createProgramTools(executor, { logger, conversationId });
      const call = (name: string, input: any) => tools[name].execute(input, { toolCallId: crypto.randomUUID(), messages: [], abortSignal: lease.signal });
      try {
        const probe = async (url: string) => {
          const opened = await call('open_tab', { url, timeoutMs: 5000 });
          const inspected = await call('inspect_page', { tabId: opened.result.tabId, timeoutMs: 5000 });
          await call('close_tab', { tabId: opened.result.tabId, timeoutMs: 5000 });
          return { opened, inspected };
        };
        return { internal: await probe('chrome://version/'), file: await probe(fileUrl) };
      } finally { await executor.endRun(); executor.dispose(); lease.finish(); await logger.flush(); logger.dispose(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, fileUrl: pathToFileURL(join(dir, 'page.html')).href });
    expect(result.internal.opened.ok).toBe(true);
    expect(result.internal.opened.pageSnapshotStatus.error.code).toBe('restricted-page');
    expect(result.internal.inspected).toMatchObject({ ok: false, error: { code: 'restricted-page', retryable: false } });
    expect(result.internal.inspected.error.message).toContain('普通网页');
    expect(JSON.stringify(result.file.opened.pageSnapshot)).toContain('LOCAL-BOUNDARY-CANARY');
    expect(result.file.inspected.pageSnapshotStatus.state).toBe('captured');
  } finally { await dispose(opened.context, opened.userDataDirectory); await rm(dir, { recursive: true, force: true }); }
});
