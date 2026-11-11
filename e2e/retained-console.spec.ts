import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { expect, test, openExtension, dispose } from './fixtures';

test('retained console reads owned canonical captures after close and navigation without regenerating source', async () => {
  let generations = 0;
  const server = createServer((req, res) => {
    if (req.url === '/generate') { generations++; res.end('<!doctype html><title>generated</title><p>ready</p>'); }
    else if (req.url === '/next') res.end('<!doctype html><title>next</title><button onclick="console.log(\'NEXT\')">Next log</button>');
    else res.end('<!doctype html><title>source</title><button onclick="fetch(\'/generate\').then(()=>{for(let i=0;i<7;i++)console.log(\'AUDIT:\'+i);console.log(\'HEARTBEAT\')})">Generate</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId('open-settings')).toBeVisible();
    const evidence = await opened.page.evaluate(async ({ dev, url }) => {
      const { EventLogger, fromLogValue } = await import(`${dev}/src/logging.ts`);
      const { ChromeExecutor } = await import(`${dev}/src/chrome/executor.ts`);
      const { createProgramTools } = await import(`${dev}/src/chrome/tool.ts`);
      const { claimConversationRun, activeRunIdentity } = await import(`${dev}/src/agent/coordinator.ts`);
      const conversationId = crypto.randomUUID(), runId = crypto.randomUUID();
      const lease = await claimConversationRun(conversationId, undefined, runId);
      const logger = new EventLogger(); logger.beginRun(conversationId, runId);
      let executor = new ChromeExecutor({ logger }); await executor.beginRun();
      let tools = createProgramTools(executor, { logger, conversationId, runSignal: lease.signal });
      const call = (name: string, input: any) => tools[name].execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
      const check = (v: any, message: string) => { if (!v) throw new Error(message); };
      const tab = await chrome.tabs.create({ url, active: false });
      const tabId = tab.id!;
      const retained = (cursor?: string, follow?: boolean) => call('read_console', { mode: 'retained', tabId, limit: 3, ...(cursor ? { cursor } : {}), ...(follow ? { follow } : {}) });
      const readAll = async (first?: any) => {
        let page = first ?? await retained(); const messages: any[] = [], boundaries: any[] = []; let pages = 0;
        while (true) { check(page.ok !== false, JSON.stringify(page)); messages.push(...page.messages); boundaries.push(...page.boundaries); pages++; if (!page.hasMore) return { messages, boundaries, page, pages }; page = await retained(page.nextCursor); }
      };
      try {
        const click = await call('click', { tabId, target: { by: 'role', value: 'button', name: 'Generate' } });
        check(click.ok !== false, JSON.stringify(click));
        // The public live reader establishes that console capture happened before close.
        let live: any;
        for (let i = 0; i < 30; i++) { live = await call('read_console', { tabId }); if (JSON.stringify(live).includes('AUDIT:6')) break; await new Promise(r => setTimeout(r, 50)); }
        check(JSON.stringify(live).includes('AUDIT:6'), JSON.stringify(live));
        const frozenFirst = await retained();
        await chrome.tabs.update(tabId, { url: `${url}next` });
        const nextClick = await call('click', { tabId, target: { by: 'role', value: 'button', name: 'Next log' } });
        check(nextClick.ok !== false, JSON.stringify(nextClick));
        const clearContext = { conversationId, toolCallId: 'console-clear', logIdentity: logger.toolIdentity(conversationId, 'console-clear') };
        await executor.runProgram({ code: `return await net.console({clear:true}, ${tabId});` }, undefined, clearContext);
        await chrome.tabs.remove(tabId);
        const closedLive = await call('read_console', { tabId });
        check(closedLive.ok === false, 'original live path must fail after close');
        const frozen = await readAll(frozenFirst);
        check(!JSON.stringify(frozen.messages).includes('NEXT'), 'fixed high-water excludes later capture');
        const followed = await readAll(await retained(frozen.page.nextCursor, true));
        check(JSON.stringify(followed.messages).includes('NEXT'), 'follow includes new capture');
        check(followed.boundaries.some(b => b.method === 'console.clear'), 'clear generation boundary retained');
        const initial = await readAll();
        const audit = initial.messages.filter(m => m.data?.args?.[0]?.value?.startsWith('AUDIT:'));
        check(audit.map(m => m.data.args[0].value).join(',') === Array.from({ length: 7 }, (_, i) => `AUDIT:${i}`).join(','), 'exact ordered capture');
        check(initial.messages.some(m => m.data?.args?.[0]?.value === 'HEARTBEAT'), 'heartbeat retained');
        check(new Set(audit.map(m => m.captureEpoch)).size === 1, 'epoch provenance');
        check(new Set(initial.messages.map(m => m.captureEpoch)).size === 2, 'navigation epochs explicit');
        const wrongTab = await call('read_console', { mode: 'retained', tabId: tabId + 999, cursor: initial.page.nextCursor });
        check(wrongTab.ok === false, 'cursor tab binding');
        const postCloseSubscribe = await call('subscribe_event', { tabId, kind: 'console' });
        check(postCloseSubscribe.ok === false, 'no post-close subscription replay');
        // A new controller can start a new read from canonical data; old opaque cursors expire.
        const oldCursor = initial.page.nextCursor;
        await executor.endRun(); executor.dispose(); executor = new ChromeExecutor({ logger }); await executor.beginRun();
        tools = createProgramTools(executor, { logger, conversationId, runSignal: lease.signal });
        check((await retained(oldCursor)).ok === false, 'controller cursor expires');
        check((await readAll()).messages.filter(m => m.data?.args?.[0]?.value?.startsWith('AUDIT:')).length === 7, 'canonical recovery');
        const raw = await logger.diagnosticEventsSnapshot(conversationId, { runId });
        const foreign = raw.value.find((e: any) => fromLogValue(e.content, e.valueEncoding)?.tabId === tabId)!;
        await logger.append({ type: 'browser.diagnostic', conversationId, runId: 'foreign-run', content: fromLogValue(foreign.content, foreign.valueEncoding), output: { args: [{ value: 'FOREIGN' }] } });
        await logger.append({ type: 'browser.diagnostic', conversationId: 'foreign-conversation', runId, content: fromLogValue(foreign.content, foreign.valueEncoding), output: { args: [{ value: 'FOREIGN' }] } });
        check(!JSON.stringify((await readAll()).messages).includes('FOREIGN'), 'explicit run/conversation filter');
        const subscribedTab = await chrome.tabs.create({ url: `${url}next`, active: false });
        const subscription = await call('subscribe_event', { tabId: subscribedTab.id, kind: 'console' });
        check(subscription.ok !== false, JSON.stringify(subscription));
        await call('click', { tabId: subscribedTab.id, target: { by: 'role', value: 'button', name: 'Next log' } });
        await chrome.tabs.remove(subscribedTab.id!);
        const unread = await call('wait_event', { subscriptionId: subscription.subscriptionId ?? subscription.result?.subscriptionId, after: subscription.cursor ?? subscription.result?.cursor, waitMs: 0 });
        check(JSON.stringify(unread).includes('NEXT'), JSON.stringify(unread));
        // Supply the real run identity even under a forged conversation context.
        const foreignRead = await executor.readRetainedConsole({ tabId }, undefined, { conversationId: 'foreign-conversation', logIdentity: { runId, toolCallId: 'foreign', toolCallIdCanonical: true } }).then(() => false, () => true);
        check(foreignRead, 'real lease conversation binding');
        const beforeClear = await retained();
        await logger.append({ type: 'log.cleared' });
        check((await retained(beforeClear.nextCursor)).ok === false, 'canonical floor invalidates cursor');
        check((await readAll()).page.integrity === 'unknown', 'absent history never complete');
        const ownerCursor = (await retained()).nextCursor;
        lease.finish();
        for (let i = 0; i < 100 && await activeRunIdentity(); i++) await new Promise(resolve => setTimeout(resolve, 20));
        const replacementLease = await claimConversationRun(conversationId, undefined, runId);
        try {
          await executor.beginRun();
          check((await retained(ownerCursor)).ok === false, 'owner generation invalidates cursor');
        } finally { replacementLease.finish(); }
        return { closedLive: closedLive.error?.code, exactAudit: audit.map(m => ({ eventId: m.eventId, epoch: m.captureEpoch, generation: m.consoleGeneration, value: m.data.args[0].value })), pages: initial.pages, preSubscribedUnread: true, controllerRecovery: true, workerRestart: 'not tested', originalModelOutcome: 'unchanged' };
      } finally { await executor.endRun(); executor.dispose(); logger.dispose(); lease.finish(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, url: `http://127.0.0.1:${(server.address() as any).port}/` });
    expect(generations).toBe(1);
    const path = test.info().outputPath('retained-console.json'); await writeFile(path, JSON.stringify({ ...evidence, generations }, null, 2));
    await test.info().attach('retained-console', { path, contentType: 'application/json' });
  } finally { await dispose(opened.context, opened.userDataDirectory, server); }
});
