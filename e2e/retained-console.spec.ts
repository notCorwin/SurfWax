import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, openExtension, dispose } from './fixtures';

test('retained console reads owned canonical captures after close and navigation without regenerating source', async () => {
  const prefix = 'ENTRY[.*] ';
  const suffixes = Array.from({ length: 180 }, () => randomBytes(16).toString('hex'));
  suffixes.splice(0, 6, '  \uFEFF雪🌊\t ', '', 'duplicate', 'duplicate', 'CR stays\r', 'é');
  let generations = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/generate') { generations++; res.end('<!doctype html><title>generated</title><p>ready</p>'); }
    else if (req.url === '/delivery') res.end('<!doctype html><title>delivery</title><textarea id="delivery" aria-label="Delivery"></textarea>');
    else if (req.url === '/next') res.end('<!doctype html><title>next</title><button onclick="console.log(\'NEXT\')">Next log</button>');
    else if (req.url === '/noise') res.end('<!doctype html><title>noise</title><button onclick="for(let i=0;i<110;i++)console.log(\'NOISE:\'+i)">Noise</button>');
    else res.end(`<!doctype html><title>source</title><button onclick="generate()">Generate</button><script>async function generate(){await fetch('/generate');const values=${JSON.stringify(suffixes)};for(let i=0;i<values.length;i++)console[['log','info','warn'][i%3]](${JSON.stringify(prefix)}+values[i]);console.log('HEARTBEAT');console.warn('Unrelated message')}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId('open-settings')).toBeVisible();
    const evidence = await opened.page.evaluate(async ({ dev, url, prefix, suffixes }) => {
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
      const retained = (cursor?: string, follow?: boolean) => call('read_console', { mode: 'retained', tabId, limit: 100, ...(cursor ? { cursor } : {}), ...(follow ? { follow } : {}) });
      const collection = async (response: any, key: string) => {
        const inline = response[key] ?? response.result?.[key];
        if (Array.isArray(inline)) return inline;
        let access = response[`${key}Access`] ?? response.access;
        const items: any[] = [];
        while (access) {
          const page = await call('read_artifact', access);
          check(page.ok && Array.isArray(page.result), JSON.stringify(page));
          check(new TextEncoder().encode(JSON.stringify(page)).length <= 8192, 'diagnostic slice wire budget');
          if (key === 'messages') check(page.sourcePagination?.hasMore === response.sourcePagination.hasMore
            && page.sourcePagination.integrity === response.sourcePagination.integrity, 'artifact page keeps parent source status');
          items.push(...page.result);
          if (key === 'messages' && !page.hasMore && response.sourcePagination?.hasMore) check(page.sourcePagination.hasMore === true, 'artifact end is not source end');
          access = page.nextAccess;
        }
        return items;
      };
      const readAll = async (first?: any) => {
        let page = first ?? await retained(); const messages: any[] = [], boundaries: any[] = [], sources: any[] = []; let pages = 0;
        while (true) {
          check(page.ok !== false, JSON.stringify(page));
          const records = await collection(page, 'messages');
          messages.push(...records);
          // Keep original references; transform the stored captures, never a
          // model-transcribed list of messages or reconstructed payload.
          if (records.length) sources.push({ ...(page.$ref ? { artifactId: page.$ref } : { evidenceId: page.evidenceId }), path: [], decode: 'stored-value' });
          boundaries.push(...await collection(page, 'boundaries')); pages++;
          if (!page.hasMore) return { messages, boundaries, page, pages, sources };
          check(page.sourceContinuation.input.cursor === page.nextCursor, 'retained next scan cursor');
          page = await call(page.sourceContinuation.tool, page.sourceContinuation.input);
        }
      };
      try {
        // Another real target fills the first bounded scan window. Empty target
        // matches must still expose a cursor into the remaining owned captures.
        const noise = await chrome.tabs.create({ url: `${url}noise`, active: false });
        const noiseClick = await call('click', { tabId: noise.id, target: { by: 'role', value: 'button', name: 'Noise' } });
        check(noiseClick.ok !== false, JSON.stringify(noiseClick));
        await chrome.tabs.remove(noise.id!);
        const click = await call('click', { tabId, target: { by: 'role', value: 'button', name: 'Generate' } });
        check(click.ok !== false, JSON.stringify(click));
        // The public live reader establishes that console capture happened before close.
        let live: any;
        for (let i = 0; i < 30; i++) { live = await call('read_console', { tabId, limit: 100 }); if (live.sourcePagination?.hasMore) break; await new Promise(r => setTimeout(r, 50)); }
        check(live.$ref && live.sourcePagination.hasMore === true && live.sourcePagination.nextOffset === 100, 'large job result preserves source pagination');
        const liveFirst = await collection(live, 'messages');
        check(liveFirst.length === 100, 'first stored source slice');
        const liveNext = await call(live.sourceContinuation.tool, live.sourceContinuation.input);
        const liveRest = await collection(liveNext, 'messages');
        check([...liveFirst, ...liveRest].filter(m => m.text?.startsWith(prefix)).map(m => m.text).join(',') === suffixes.map(value => prefix + value).join(','), 'source continuation recovers all original live messages');
        check((await logger.result(live.$ref, { path: ['result'] }, conversationId)).messages.length === 100, 'raw job artifact contract unchanged');
        const frozenFirst = await retained();
        check(frozenFirst.messages.length === 0 && frozenFirst.hasMore && !frozenFirst.rangeComplete
          && frozenFirst.integrity === 'unknown' && frozenFirst.sourceContinuation.input.cursor === frozenFirst.nextCursor, 'empty scan remains incomplete with exact continuation');
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
        const audit = initial.messages.filter(m => m.data?.args?.[0]?.value?.startsWith(prefix));
        check(audit.map(m => m.data.args[0].value).join(',') === suffixes.map(value => prefix + value).join(','), 'exact ordered capture after original source close');
        check(initial.messages.some(m => m.data?.args?.[0]?.value === 'HEARTBEAT'), 'heartbeat retained');
        check(new Set(audit.map(m => m.captureEpoch)).size === 1, 'epoch provenance');
        check(new Set(initial.messages.map(m => m.captureEpoch)).size === 2, 'navigation epochs explicit');
        const extracted = await call('extract_json_text', { sources: initial.sources, selectPath: ['messages'], itemPath: ['data', 'args', 0, 'value'], separator: '\n', filename: 'captured-lines.txt' });
        check(extracted.ok !== false && extracted.result.totalItems === initial.messages.length, JSON.stringify(extracted));
        const transformed = await call('extract_prefixed_lines', { artifactId: extracted.result.artifact.id, prefix, separator: '\n', filename: 'selected-lines.txt' });
        const exactText = suffixes.join('\n');
        const exactBytes = new TextEncoder().encode(exactText);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', exactBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        check(transformed.ok !== false && transformed.result.matched === 180
          && transformed.result.inputLineCount === initial.messages.length
          && transformed.result.skipped === initial.messages.length - 180
          && transformed.result.byteLength === exactBytes.length && transformed.result.sha256 === sha256, 'literal prefix extraction preserves exact suffix bytes and counts');
        const destination = await chrome.tabs.create({ url: `${url}delivery`, active: false });
        try {
          const delivered = await call('fill_from_artifact', { tabId: destination.id, ...transformed.result.access, target: { by: 'css', value: '#delivery' } });
          check(delivered.ok !== false, JSON.stringify(delivered));
          const value = await call('read_value', { tabId: destination.id, target: { by: 'css', value: '#delivery' } });
          // HTML textarea values normalize CR to LF; the artifact hash above
          // independently verifies the original CR survived the transform.
          check(value.ok !== false && value.result === exactText.replace(/\r\n?/g, '\n'), 'stored capture transforms fill the actual editable value');
        } finally { await chrome.tabs.remove(destination.id!); }

        const wrongTab = await call('read_console', { mode: 'retained', tabId: tabId + 999, cursor: initial.page.nextCursor });
        check(wrongTab.ok === false, 'cursor tab binding');
        const postCloseSubscribe = await call('subscribe_event', { tabId, kind: 'console' });
        check(postCloseSubscribe.ok === false, 'no post-close subscription replay');
        // A new controller can start a new read from canonical data; old opaque cursors expire.
        const oldCursor = initial.page.nextCursor;
        await executor.endRun(); executor.dispose(); executor = new ChromeExecutor({ logger }); await executor.beginRun();
        tools = createProgramTools(executor, { logger, conversationId, runSignal: lease.signal });
        check((await retained(oldCursor)).ok === false, 'controller cursor expires');
        check((await readAll()).messages.filter(m => m.data?.args?.[0]?.value?.startsWith(prefix)).length === 180, 'canonical recovery');
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
        return { closedLive: closedLive.error?.code, exactAudit: audit.map(m => ({ eventId: m.eventId, epoch: m.captureEpoch, generation: m.consoleGeneration, value: m.data.args[0].value })), pages: initial.pages, preSubscribedUnread: true, controllerRecovery: true, workerRestart: 'not tested', textDataflow: { matched: transformed.result.matched, skipped: transformed.result.skipped, byteLength: transformed.result.byteLength, sha256, originalCarriageReturnPreservedInArtifact: true, textareaNormalizesCarriageReturn: true }, originalModelOutcome: 'unchanged' };
      } finally { await executor.endRun(); executor.dispose(); logger.dispose(); lease.finish(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, url: `http://127.0.0.1:${(server.address() as any).port}/`, prefix, suffixes });
    expect(generations).toBe(1);
    const path = test.info().outputPath('retained-console.json'); await writeFile(path, JSON.stringify({ ...evidence, generations }, null, 2));
    await test.info().attach('retained-console', { path, contentType: 'application/json' });
  } finally { await dispose(opened.context, opened.userDataDirectory, server); }
});
