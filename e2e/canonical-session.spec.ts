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

// Scripted provider exercises the actual model-facing registry/worker/log chain;
// it makes no claim about a real model's ability to choose these operations.
test('stored HTTP JSON extracts and joins exact text without refetch or model text copying', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { commandResponse } = await import('./fixtures');
  const pages = [
    ['雪', '', '雪', ' leading '],
    Array.from({ length: 173 }, (_, index) => `航-${index}-` + 'é'.repeat(91)).concat(['', 'end\n']),
  ];
  let httpReads = 0;
  const http = createServer((request, response) => {
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
  let first: any, large: any, extracted: any, joined: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => { const field = document.createElement('textarea'); field.id = 'delivery'; document.body.append(field); });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    responses.push(
      commandResponse('send_extension_request', { url: `http://127.0.0.1:${address.port}/0` }, 'inline-http'),
      (request: any) => {
        first = last(request);
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
      (request: any) => { last(request); return textResponse('TEXT_TRANSFORM_COMPLETE'); },
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
      model: 'scripted fake HTTP only; no real model or user key',
    }, null, 2)) });
    const events = await readEvents(opened.page);
    for (const id of ['extract', 'join', 'deliver']) {
      expect(events.filter(event => event.type === 'tool.finished' && event.toolCallId === id)).toHaveLength(1);
      expect(events.filter(event => event.type === 'tool.failed' && event.toolCallId === id)).toHaveLength(0);
    }
    expect(events.filter(event => event.type === 'tool.failed' && event.toolCallId === 'invalid-extract')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool.result.data' && (event.content as any)?.filename === 'must-not-exist.txt')).toHaveLength(0);
    const requests = provider.requests.filter((request: any) => request.tools?.length);
    const calls = requests.flatMap((request: any) => request.messages.filter((message: any) => message.role === 'assistant').flatMap((message: any) => message.tool_calls ?? []));
    for (const call of calls.filter((call: any) => ['extract_json_text', 'join_text_artifacts', 'fill_from_artifact'].includes(call.function.name)))
      expect(call.function.arguments).not.toContain('航-');
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
