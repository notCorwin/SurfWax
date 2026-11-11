import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { expect, test, openExtension, dispose } from './fixtures';

test('large HTTP payloads and artifact reads preserve exact absolute progress without duplicate storage', async () => {
  const items = Array.from({ length: 1200 }, (_, index) => ({ index, text: `${index}:海🌊${'x'.repeat(160)}` }));
  const body = JSON.stringify({ items, messages: [{ text: 'ordinary HTTP data' }], integrity: 'complete', hasMore: true, nextOffset: 1 });
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId('open-settings')).toBeVisible();
    const result = await opened.page.evaluate(async ({ dev, url, items, body }) => {
      const { EventLogger } = await import(`${dev}/src/logging.ts`);
      const { createMemoryEventStore } = await import(`${dev}/src/memory-event-store.ts`);
      const { ChromeExecutor } = await import(`${dev}/src/chrome/executor.ts`);
      const { createProgramTools } = await import(`${dev}/src/chrome/tool.ts`);
      const events: any[] = [];
      const logger = new EventLogger({ store: createMemoryEventStore(events) });
      const conversationId = crypto.randomUUID();
      logger.beginRun(conversationId, conversationId);
      const executor = new ChromeExecutor({ logger });
      await executor.beginRun();
      const tools = createProgramTools(executor, { logger, conversationId });
      const call = (name: string, input: any) => tools[name].execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
      const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
      try {
        const http = await call('send_extension_request', { url });
        check(JSON.stringify(http.access.path) === '["result","body"]', `HTTP access: ${JSON.stringify(http)}`);
        let access = http.access, text = '', pages = 0;
        const before = events.filter(event => event.type === 'tool.result.data').length;
        while (access) {
          const page = await call('read_artifact', { ...access, limit: 100000 });
          check(page.ok && page.range.start === text.length && page.total === body.length, 'HTTP absolute range');
          check(new TextEncoder().encode(JSON.stringify(page)).length <= 8192, 'wire budget');
          text += page.result;
          check(page.range.endExclusive === text.length && page.hasMore === (text.length < body.length), 'HTTP progress');
          access = page.nextAccess; pages++;
        }
        check(text === body, 'exact HTTP content');
        check(events.filter(event => event.type === 'tool.result.data').length === before, 'HTTP duplicate artifact');
        const stored = await logger.append({ type: 'tool.result.data', conversationId, content: {}, output: { result: items.slice(0, 60) } });
        const id = stored.id;
        let offset = 0; const received: any[] = [];
        const dataBefore = events.filter(event => event.type === 'tool.result.data').length;
        do {
          const page = await call('read_artifact', { artifactId: id, path: ['result'], offset, limit: 100 });
          check(page.ok && page.total === 60 && page.range.start === offset, 'array absolute range');
          check(page.sourceAccess.artifactId === id && !page.$ref, 'stable reference');
          received.push(...page.result); offset = page.range.endExclusive;
          check(!page.hasMore || page.nextAccess.offset === offset, 'next access');
        } while (offset < 60);
        check(JSON.stringify(received) === JSON.stringify(items.slice(0, 60)), 'exact array');
        check(events.filter(event => event.type === 'tool.result.data').length === dataBefore, 'array duplicate artifact');
        const huge = await logger.append({ type: 'tool.result.data', conversationId, content: {}, output: [{ text: '海'.repeat(50000), special: 2n }] });
        const blocked = await call('read_artifact', { artifactId: huge.id, offset: 0, limit: 1 });
        check(!blocked.ok && blocked.error.code === 'artifact-selection-too-large' && blocked.partial && !blocked.nextAccess && blocked.range.endExclusive === 0, 'oversized no-progress status');
        check(JSON.stringify(blocked.access.path) === '[0,"text"]', 'actionable narrower path');
        const special = await call('read_artifact', { artifactId: huge.id, path: [0, 'special'] });
        check(special.ok && special.bigintPaths[0].value === '2', 'partitioned scalar metadata');
        const narrow = await call('read_artifact', blocked.access);
        check(narrow.ok && narrow.result === '海' && narrow.total === 50000, 'narrow read');
        const object = await logger.append({ type: 'tool.result.data', conversationId, content: {}, output: { body: 'z'.repeat(50000), partial: true } });
        const objectPage = await call('read_artifact', { artifactId: object.id });
        check(!objectPage.ok && objectPage.partial && !objectPage.nextAccess && JSON.stringify(objectPage.access.path) === '["body"]', 'oversized object narrower path');
        const stringItem = await logger.append({ type: 'tool.result.data', conversationId, content: {}, output: ['海'.repeat(50000)] });
        const stringBlocked = await call('read_artifact', { artifactId: stringItem.id, limit: 1 });
        check(!stringBlocked.ok && !stringBlocked.nextAccess && JSON.stringify(stringBlocked.access.path) === '[0]', 'oversized string item narrower path');
        check((await call('read_artifact', stringBlocked.access)).result === '海', 'string item progress');
        const typed = await logger.append({ type: 'tool.result.data', conversationId, content: {}, output: [undefined, , NaN, 2n, new Map([['x', 1]])] });
        const typedPage = await call('read_artifact', { artifactId: typed.id, offset: 1, limit: 3 });
        check(JSON.stringify(typedPage.holePaths) === '[[0]]' && typedPage.numberPaths[0].path[0] === 1 && typedPage.bigintPaths[0].path[0] === 2, 'relative typed sidecars');
        check((await logger.result(id, { path: ['result'], offset: 20, limit: 40 }, conversationId)).length === 40, 'raw contract');
        // Use the extension's real indexed Canonical store for provenance checks;
        // the memory store above intentionally has no native run/tool index.
        const canonical = new EventLogger();
        const canonicalConversation = crypto.randomUUID();
        canonical.beginRun(canonicalConversation, crypto.randomUUID());
        const canonicalExecutor = new ChromeExecutor({ logger: canonical });
        const canonicalTools = createProgramTools(canonicalExecutor, { logger: canonical, conversationId: canonicalConversation });
        const storeOwned = async (toolName: string, value: any) => {
          const identity = canonical.toolIdentity(canonicalConversation, crypto.randomUUID());
          await canonical.append({ type: 'tool.started', conversationId: canonicalConversation, ...identity, content: { toolName } });
          return canonical.append({ type: 'tool.result.data', conversationId: canonicalConversation, ...identity, content: {}, output: { result: value } });
        };
        const read = (input: any) => canonicalTools.read_artifact.execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
        try {
          const json = JSON.parse(text);
          const ordinary = await storeOwned('send_extension_request', json);
          const ordinaryPage = await read({ artifactId: ordinary.id, path: ['result', 'messages'] });
          check(!ordinaryPage.sourcePagination && !ordinaryPage.sourcePaginationNote && JSON.stringify(ordinaryPage.result) === JSON.stringify(json.messages), 'HTTP JSON fields are payload, not diagnostic pagination');
          check(JSON.stringify(await canonical.result(ordinary.id, { path: ['result'] }, canonicalConversation)) === text, 'ordinary HTTP JSON raw contract');
          const nestedData = { messages: json.messages, integrity: json.integrity, hasMore: json.hasMore, nextOffset: json.nextOffset };
          const diagnostic = await storeOwned('read_console', { messages: [{ data: { args: [{ value: nestedData }] } }], integrity: 'complete', hasMore: false });
          const top = await read({ artifactId: diagnostic.id, path: ['result', 'messages'] });
          check(top.sourcePagination?.hasMore === false, 'native indexed diagnostic origin is available');
          const nestedPath = ['result', 'messages', 0, 'data', 'args', 0, 'value', 'messages'];
          const nested = await read({ artifactId: diagnostic.id, path: nestedPath });
          check(!nested.sourcePagination && !nested.sourcePaginationNote && JSON.stringify(nested.result) === JSON.stringify(json.messages), 'console argument fields do not become diagnostic pagination');
          check(JSON.stringify(await canonical.result(diagnostic.id, { path: nestedPath }, canonicalConversation)) === JSON.stringify(json.messages), 'nested raw contract');
        } finally { canonicalExecutor.dispose(); canonical.dispose(); }
        return { httpPages: pages, exactHttpBytes: new TextEncoder().encode(text).length, exactItems: received.length, stableArtifact: id, oversizedCode: blocked.error.code, typedSidecars: true, diagnosticProvenanceControls: true };
      } finally { await executor.endRun(); executor.dispose(); logger.dispose(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, url: `http://127.0.0.1:${(server.address() as any).port}/payload`, items, body });
    expect(result.exactItems).toBe(60);
    const evidencePath = test.info().outputPath('artifact-reading.json');
    await writeFile(evidencePath, JSON.stringify(result, null, 2));
    await test.info().attach('artifact-reading-evidence', { path: evidencePath, contentType: 'application/json' });
  } finally { await dispose(opened.context, opened.userDataDirectory, server); }
});
