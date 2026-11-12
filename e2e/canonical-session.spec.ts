import { expect, test, configure, delayedResponse, dispose, openExtension, readEvents, startProvider, textResponse } from './fixtures';

test('conversation rename and creation failures stay safe and preserve saved history', async ({}, info) => {
  const provider = await startProvider([textResponse('SAVED_HISTORY'), textResponse('Safety session')]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.getByTestId('composer-input').fill('Keep this conversation');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body')).toContainText('SAVED_HISTORY');
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('Safety session');
    await opened.page.getByTestId('conversation-menu').click();
    await opened.page.locator('.conversation-item').hover();
    await opened.page.getByRole('button', { name: '重命名 Safety session', exact: true }).click();
    const name = opened.page.getByRole('textbox', { name: '会话名称' });
    await name.fill('');
    await opened.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(opened.page.getByRole('alert')).toContainText('请输入会话名称');
    await name.fill('Renamed safely');
    await expect(opened.page.getByRole('alert')).toHaveCount(0);
    const before = await readEvents(opened.page);
    await opened.page.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      document.documentElement.dataset.rejectRunStatus = 'true';
      chrome.runtime.sendMessage = ((...args: any[]) => {
        if (args[0]?.type === 'surf-wax:run-status' && document.documentElement.dataset.rejectRunStatus === 'true') {
          document.documentElement.dataset.rejectedRunStatus = String(Number(document.documentElement.dataset.rejectedRunStatus ?? 0) + 1);
          return Promise.reject(new Error('synthetic-raw stack-marker credential-marker'));
        }
        return (send as any)(...args);
      }) as typeof chrome.runtime.sendMessage;
    });
    await opened.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => opened.page.evaluate(() => Number(document.documentElement.dataset.rejectedRunStatus))).toBeGreaterThan(0);
    await expect(opened.page.getByRole('alert')).toBeVisible();
    const renameText = await opened.page.locator('.conversation-rename').innerText();
    await info.attach('rename-failure-presentation', { body: JSON.stringify({ text: renameText }), contentType: 'application/json' });
    expect.soft(renameText).not.toMatch(/synthetic-raw|stack-marker|credential-marker/);
    expect.soft(renameText).toContain('重命名失败；请重试。');
    expect((await readEvents(opened.page)).filter(e => e.type === 'conversation.title.updated')).toEqual(before.filter(e => e.type === 'conversation.title.updated'));
    await opened.page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(name).toHaveCount(0);
    await expect(opened.page.getByText('重命名失败；请重试。', { exact: true })).toHaveCount(0);
    await opened.page.keyboard.press('Escape');
    const rejectedBefore = await opened.page.evaluate(() => Number(document.documentElement.dataset.rejectedRunStatus));
    await opened.page.getByTestId('new-conversation').click();
    await expect.poll(() => opened.page.evaluate(() => Number(document.documentElement.dataset.rejectedRunStatus))).toBeGreaterThan(rejectedBefore);
    const newText = await opened.page.locator('body').innerText();
    await info.attach('new-conversation-failure-presentation', { body: JSON.stringify({ text: newText }), contentType: 'application/json' });
    expect.soft(newText).not.toMatch(/synthetic-raw|stack-marker|credential-marker/);
    expect.soft(newText).toContain('无法新建会话；请重试。');
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('Safety session');
    await expect(opened.page.locator('.markdown-body')).toContainText('SAVED_HISTORY');
    await expect(opened.page.getByTestId('fatal-log-error')).toHaveCount(0);
    await opened.page.evaluate(() => { document.documentElement.dataset.rejectRunStatus = 'false'; });
    await opened.page.getByTestId('conversation-menu').click();
    await opened.page.locator('.conversation-item').hover();
    await opened.page.getByRole('button', { name: '重命名 Safety session', exact: true }).click();
    await name.fill('Renamed safely');
    await opened.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(name).toHaveCount(0);
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('Renamed safely');
    await opened.page.keyboard.press('Escape');
    await opened.page.getByTestId('new-conversation').click();
    await expect(opened.page.getByTestId('conversation-menu')).toContainText('新对话');
    await expect(opened.page.locator('body')).not.toContainText('无法新建会话');
    await opened.page.getByTestId('conversation-menu').click();
    await opened.page.getByRole('button', { name: 'Renamed safely', exact: true }).click();
    await expect(opened.page.locator('.markdown-body')).toContainText('SAVED_HISTORY');
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

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

// Scripted provider exercises the actual model-facing registry/worker/log chain;
// it makes no claim about a real model's ability to choose these operations.
test('stored HTTP JSON extracts and joins exact text without refetch or model text copying', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { fromLogValue } = await import('../src/logging');
  const { commandResponse } = await import('./fixtures');
  const pages = [
    ['雪', '', '雪', ' leading '],
    Array.from({ length: 173 }, (_, index) => `航-${index}-` + 'é'.repeat(91)).concat(['', 'end\n']),
  ];
  let httpReads = 0, heldRequests = 0, heldClosed = 0;
  let markHeldStarted!: () => void;
  const heldStarted = new Promise<void>(resolve => { markHeldStarted = resolve; });
  const http = createServer((request, response) => {
    if (request.url === '/held') {
      heldRequests++;
      markHeldStarted();
      response.on('close', () => { heldClosed++; });
      return;
    }
    httpReads++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ records: pages[Number(request.url!.slice(1))]!.map(text => ({ text })), ...(request.url === "/1" ? { unselected: "x".repeat(290_000) } : {}) }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const responses: any[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  const outputs: any[] = [];
  const last = (request: any) => {
    const message = request.messages.findLast((item: any) => item.role === 'tool');
    const value = JSON.parse(typeof message.content === 'string' ? message.content : message.content[0].text);
    outputs.push(value);
    return value;
  };
  let first: any, large: any, extracted: any, joined: any, ownInspection: any, backgroundJob: string;
  let cancellationObservations = 0;
  const terminalAfterCancel = (request: any): any => {
    const status = last(request);
    expect(status.pageSnapshot || status.pageSnapshotStatus).toBeTruthy();
    if (!status.terminal) {
      responses.unshift(terminalAfterCancel);
      return commandResponse('get_job', { jobId: backgroundJob, waitMs: 100 }, `observe-cancelled-${++cancellationObservations}`);
    }
    expect(status.pageSnapshotStatus?.state).not.toBe('pending');
    return commandResponse('list_downloads', { limit: 1 }, 'stable-no-page');
  };
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const field = document.createElement('textarea'); field.id = 'delivery'; document.body.append(field);
      for (let index = 0; index < 16; index++) { const button = document.createElement('button'); button.textContent = `Observation ${index}`; document.body.append(button); }
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    responses.push(
      commandResponse('send_extension_request', { url: `http://127.0.0.1:${address.port}/0` }, 'inline-http'),
      (request: any) => {
        first = last(request);
        expect(first.pageSnapshot?.observationId).toEqual(expect.any(String));
        return commandResponse('send_extension_request', { url: `http://127.0.0.1:${address.port}/1` }, 'large-http');
      },
      (request: any) => {
        large = last(request);
        return commandResponse('extract_json_text', {
          sources: [...[first, large].map(value => ({ evidenceId: value.evidenceId, path: ['result', 'body'], decode: 'json-string' })), { artifactId: large.$ref, path: ['result', 'body'], decode: 'json-string' }],
          selectPath: ['records'], itemPath: ['text'], separator: '\n', filename: 'extracted.txt',
        }, 'extract');
      },
      (request: any) => {
        extracted = last(request);
        return commandResponse('extract_json_text', { sources: [{ evidenceId: first.evidenceId, path: ['result', 'body'], decode: 'json-string' }, { evidenceId: large.evidenceId, path: ['result', 'body'], decode: 'json-string' }], selectPath: ['missing'], separator: '', filename: 'must-not-exist.txt' }, 'invalid-extract');
      },
      (request: any) => {
        const failure = last(request);
        expect(failure.ok).toBe(false);
        expect(JSON.stringify(failure)).toContain('source[0]');
        return commandResponse('join_text_artifacts', { artifactIds: [extracted.result.artifact.id, extracted.result.artifact.id], separator: '\n--\n', filename: 'joined.txt' }, 'join');
      },
      (request: any) => {
        joined = last(request);
        return commandResponse('fill_from_artifact', { artifactId: joined.result.artifact.id, target: { by: 'css', value: '#delivery' } }, 'deliver');
      },
      (request: any) => {
        expect(last(request).pageSnapshot?.observationId).toEqual(expect.any(String));
        return commandResponse('inspect_page', { full: true, budget: 600 }, 'own-observation');
      },
      (request: any) => {
        ownInspection = last(request);
        expect(ownInspection.pageSnapshot).toBeUndefined();
        expect(ownInspection.pageSnapshotStatus).toMatchObject({ state: 'captured', freshness: 'at-capture' });
        expect(ownInspection.nextCursor).toEqual(expect.any(String));
        return commandResponse('inspect_page', { cursor: ownInspection.nextCursor, budget: 600 }, 'frozen-observation');
      },
      (request: any) => {
        const continuation = last(request);
        expect(continuation.observationId).toBe(ownInspection.observationId);
        expect(continuation.pageSnapshot).toBeUndefined();
        expect(continuation.pageSnapshotStatus).toMatchObject({ state: 'frozen', freshness: 'frozen' });
        return commandResponse('send_extension_request', { url: `http://127.0.0.1:${address.port}/held`, background: true, timeoutMs: 20_000 }, 'held-background');
      },
      (request: any) => {
        const handedOff = last(request);
        backgroundJob = handedOff.jobId;
        expect(handedOff.pageSnapshot).toBeUndefined();
        expect(handedOff.pageSnapshotStatus).toMatchObject({ state: 'pending', freshness: 'unknown', reason: 'browser-job-unobserved-terminal' });
        return delayedResponse(commandResponse('read_artifact', { artifactId: large.$ref, path: ['result', 'body'], offset: 0, limit: 9 }, 'pending-artifact'), 0, heldStarted);
      },
      (request: any) => {
        const slice = last(request);
        expect(slice.result).toBe(JSON.stringify({ records: pages[1]!.map(text => ({ text })), unselected: 'x'.repeat(290_000) }).slice(0, 9));
        expect(slice.range).toEqual({ start: 0, endExclusive: 9 });
        expect(slice.nextAccess.offset).toBe(9);
        expect(slice.pageSnapshot).toBeUndefined();
        expect(slice.pageSnapshotStatus).toMatchObject({ state: 'pending', freshness: 'unknown' });
        expect(Buffer.byteLength(JSON.stringify(slice))).toBeLessThanOrEqual(8192);
        return commandResponse('read_artifact', { artifactId: large.$ref, path: ['result'] }, 'pending-oversized-artifact');
      },
      (request: any) => {
        const oversized = last(request);
        expect(oversized.ok).toBe(false);
        expect(oversized.error.code).toBe('artifact-selection-too-large');
        expect(oversized.pageSnapshotStatus).toMatchObject({ state: 'unavailable', freshness: 'unknown', reason: 'tool-failed' });
        expect(oversized.result).toBeUndefined();
        expect(oversized.nextAccess).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(8192);
        return commandResponse('list_jobs', { limit: 1 }, 'pending-jobs');
      },
      (request: any) => {
        const jobs = last(request);
        expect(jobs.pageSnapshot).toBeUndefined();
        expect(jobs.pageSnapshotStatus).toMatchObject({ state: 'pending', freshness: 'unknown' });
        expect(heldRequests).toBe(1);
        expect(heldClosed).toBe(0);
        return commandResponse('cancel_job', { jobId: backgroundJob }, 'cancel-held');
      },
      (request: any) => {
        const cancelled = last(request);
        expect(cancelled.pageSnapshot || cancelled.pageSnapshotStatus).toBeTruthy();
        return commandResponse('get_job', { jobId: backgroundJob, waitMs: 100 }, `observe-cancelled-${++cancellationObservations}`);
      },
      terminalAfterCancel,
      (request: any) => {
        const stable = last(request);
        expect(stable.pageSnapshot).toBeUndefined();
        expect(stable.pageSnapshotStatus).toMatchObject({ state: 'not-captured', freshness: 'unknown' });
        return commandResponse('read_artifact', { artifactId: large.$ref, path: ['result'] }, 'oversized-no-page');
      },
      (request: any) => {
        const oversized = last(request);
        expect(oversized.error.code).toBe('artifact-selection-too-large');
        expect(oversized.pageSnapshotStatus).toMatchObject({ state: 'unavailable', freshness: 'unknown', reason: 'tool-failed' });
        expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(8192);
        return commandResponse('read_artifact', { artifactId: large.$ref, path: ['missing-observation-field'] }, 'failed-no-page');
      },
      (request: any) => {
        const failed = last(request);
        expect(failed.ok).toBe(false);
        expect(failed.pageSnapshotStatus).toMatchObject({ state: 'unavailable', freshness: 'unknown', reason: 'tool-failed' });
        return textResponse('TEXT_TRANSFORM_COMPLETE');
      },
    );
    await opened.page.getByTestId('composer-input').fill('Process the stored data into a file and deliver it');
    await opened.page.getByTestId('composer-input').press('Enter');
    await expect(opened.page.locator('.markdown-body').last()).toContainText('TEXT_TRANSFORM_COMPLETE');
    const expected = [...pages.flat(), ...pages[1]!].join('\n');
    const combined = expected + '\n--\n' + expected;
    expect(first.$ref).toBeUndefined();
    expect(large.$ref).toEqual(expect.any(Number));
    expect(extracted.result).toMatchObject({ totalItems: pages.flat().length + pages[1]!.length, byteLength: Buffer.byteLength(expected), sha256: createHash('sha256').update(expected).digest('hex'), sources: [{ evidenceId: first.evidenceId, count: pages[0]!.length }, { evidenceId: large.evidenceId, count: pages[1]!.length }, { artifactId: large.$ref, count: pages[1]!.length }] });
    expect(joined.result).toMatchObject({ totalItems: 2, byteLength: Buffer.byteLength(combined), sha256: createHash('sha256').update(combined).digest('hex') });
    await expect(target.locator('#delivery')).toHaveValue(combined);
    expect(httpReads).toBe(2);
    await test.info().attach('text-transform-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      httpReads, inlineEvidenceId: first.evidenceId, largeEvidenceId: large.evidenceId, rawArtifactId: large.$ref,
      extracted: extracted.result, joined: joined.result,
      deliveredByteLength: Buffer.byteLength(await target.locator('#delivery').inputValue()),
      deliveredSha256: createHash('sha256').update(await target.locator('#delivery').inputValue()).digest('hex'),
      observationDelivery: outputs.map(output => ({ evidenceId: output.evidenceId, pageSnapshotStatus: output.pageSnapshotStatus,
        pageSnapshotId: output.pageSnapshot?.observationId, ownObservationId: output.observationId })),
      heldRequests, heldClosed,
      model: 'scripted fake HTTP only; no real model or user key',
    }, null, 2)) });
    const events = await readEvents(opened.page);
    for (const id of ['pending-artifact', 'pending-oversized-artifact', 'pending-jobs', 'stable-no-page', 'oversized-no-page', 'failed-no-page']) {
      const result = events.find(event => ['tool.finished', 'tool.failed'].includes(event.type) && event.toolCallId === id)!;
      expect((fromLogValue(result.output, result.valueEncoding) as any).pageSnapshotStatus).toMatchObject({ freshness: 'unknown' });
      expect(events.filter(event => event.type === 'automation.action.started' && event.toolCallId === id && (fromLogValue(event.content, event.valueEncoding) as any)?.operation === 'inspect')).toHaveLength(0);
      if (id.startsWith('pending-')) expect(result.latencyMs).toBeLessThan(2000);
    }
    expect(events.find(event => ['tool.finished', 'tool.failed'].includes(event.type) && event.toolCallId === 'cancel-held')!.latencyMs).toBeLessThan(4000);
    for (const id of ['extract', 'join', 'deliver']) {
      expect(events.filter(event => event.type === 'tool.finished' && event.toolCallId === id)).toHaveLength(1);
      expect(events.filter(event => event.type === 'tool.failed' && event.toolCallId === id)).toHaveLength(0);
    }
    expect(events.filter(event => event.type === 'tool.failed' && event.toolCallId === 'invalid-extract')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool.result.data' && (event.content as any)?.filename === 'must-not-exist.txt')).toHaveLength(0);
    const source = events.find(event => event.type === 'tool.finished' && event.toolCallId === first.evidenceId)!;
    const indexedReads = await opened.page.evaluate(async ({ dev, conversationId, runId, ids }) => {
      const { EventLogger, IndexedDbEventStore } = await import(`${dev}/src/logging.ts`);
      const store = new IndexedDbEventStore();
      const read = store.byRunToolTypes.bind(store);
      const queries: any[] = [];
      store.byRunToolTypes = async (...args: any[]) => {
        const rows = await read(...args);
        queries.push({ runId: args[0], toolCallId: args[1], types: args[2], afterId: args[3],
          rows: rows.map((row: any) => ({ id: row.id, runId: row.runId, toolCallId: row.toolCallId, type: row.type })) });
        return rows;
      };
      store.byRunTypes = store.all = async () => { throw new Error('Evidence performed a whole-run or whole-store read'); };
      const logger = new EventLogger({ store });
      try {
        const values = await Promise.all(ids.map((id: string) => logger.evidenceResult(id, conversationId, runId)));
        return { queries, records: values.map((value: any) => JSON.parse(value.result.body).records.map((record: any) => record.text)) };
      } finally { logger.dispose(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, conversationId: source.conversationId!, runId: source.runId!, ids: [first.evidenceId, large.evidenceId] });
    expect(indexedReads.records).toEqual(pages);
    expect(indexedReads.queries).toHaveLength(2);
    for (const query of indexedReads.queries) {
      expect(query.types).toEqual(['tool.started', 'tool.finished', 'tool.failed']);
      expect(query.rows).toHaveLength(2);
      expect(query.rows.map((row: any) => row.type)).toEqual(['tool.started', 'tool.finished']);
      expect(query.rows.every((row: any) => row.runId === source.runId && row.toolCallId === query.toolCallId)).toBe(true);
    }
    await test.info().attach('indexed-evidence-reads', { contentType: 'application/json', body: Buffer.from(JSON.stringify(indexedReads.queries, null, 2)) });
    const requests = provider.requests.filter((request: any) => request.tools?.length);
    const calls = requests.flatMap((request: any) => request.messages.filter((message: any) => message.role === 'assistant').flatMap((message: any) => message.tool_calls ?? []));
    for (const call of calls.filter((call: any) => ['extract_json_text', 'join_text_artifacts', 'fill_from_artifact'].includes(call.function.name)))
      expect(call.function.arguments).not.toContain('航-');
  } finally {
    markHeldStarted();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
