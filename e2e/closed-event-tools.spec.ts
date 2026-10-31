import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { closedEventFixture, closedEventScore } from "./evaluation/closed-event-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The local provider supplies fixed tool calls; no LLM or external service is used.
test("recovers a paginated audit event stream after its source window closes", async () => {
  test.setTimeout(150_000);
  const fixture = await closedEventFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, sourceId = -1, rootId = -1, subscriptionId = "", cursor = 0, beforeCloseCursor = 0, polls = 0;
  const received: string[] = [];
  const done = () => textResponse("CLOSED_EVENT_TOOLS_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Audit"); }
      try { return handler(JSON.parse(message.content)); } catch (error) { problem = error; return done(); }
    };
    return step;
  };
  const awaitJob = (next: (result: any) => ReturnType<typeof commandResponse>) => {
    let jobId = "";
    const step: MockResponse = after((result) => {
      if (result.accepted && result.complete === false || result.terminal === false) {
        jobId = result.jobId ?? jobId;
        responses.unshift(step);
        return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `event-job-${++polls}`);
      }
      expect(result, `Job ${jobId}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, state: "succeeded" });
      return next(result);
    });
    return step;
  };
  const readPage: MockResponse = after((result) => {
    expect(result).toMatchObject({ subscriptionId, closed: expect.any(String), events: expect.any(Array) });
    expect(result.overflow).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);
    let expectedCursor = cursor;
    for (const event of result.events) {
      expect(event).toMatchObject({ kind: "console", source: { tabId: sourceId } });
      expect(event.cursor).toBe(++expectedCursor);
      expect(event.payloadTruncated).toBeUndefined();
      const text = event.payload?.args?.[0]?.value;
      expect(typeof text).toBe("string");
      if (text.startsWith("AUDIT ")) received.push(text.slice(6));
      else expect(text).toMatch(/^HEARTBEAT /);
    }
    expect(result.nextCursor).toBe(expectedCursor);
    cursor = result.nextCursor;
    if (result.hasMore) {
      responses.unshift(readPage);
      return commandResponse("wait_event", { subscriptionId, after: cursor, limit: 10 }, `event-page-${cursor}`);
    }
    expect(cursor).toBe(189);
    expect(received).toHaveLength(180);
    return commandResponse("execute_program", { timeoutMs: 30_000, code: `
      const destination = (await browser.page(${rootId})).frameLocator('iframe[title="Destination"]');
      await destination.getByLabel('Audit codes').evaluate((input, value) => {
        input.value = value; input.dispatchEvent(new Event('input', {bubbles:true}));
      }, ${JSON.stringify(received.join("\n"))});
      await destination.getByRole('button', {name:'Submit audit'}).click(); return 'done';` }, "event-submit");
  });
  const readBeforeClose: MockResponse = after((result) => {
    expect(result.overflow).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeGreaterThan(beforeCloseCursor);
    beforeCloseCursor = result.nextCursor;
    if (result.events.some((event: any) => event.payload?.args?.[0]?.value === "HEARTBEAT 179")) {
      expect(beforeCloseCursor).toBe(189);
      return commandResponse("execute_program", { timeoutMs: 30_000, code: `
        const source = await browser.page(${sourceId});
        await source.getByRole('button', {name:'Close source'}).evaluate(button => { setTimeout(() => button.click(), 0); });
        for (let index = 0; index < 100; index++) {
          if (!(await browser.tabs.list()).some(tab => tab.id === ${sourceId})) return 'closed';
          await sleep(50);
        }
        throw new Error('Source window did not close');` }, "event-close");
    }
    responses.unshift(readBeforeClose);
    return commandResponse("wait_event", { subscriptionId, after: beforeCloseCursor, limit: 10, waitMs: 10_000 }, `event-ready-${beforeCloseCursor}`);
  });
  const finish: MockResponse = (request) => {
    const message = request.messages.findLast((item: any) => item.role === "tool");
    if (!message) { responses.unshift(finish); return textResponse("Audit"); }
    try { expect(JSON.parse(message.content)).toMatchObject({ subscriptionId, closed: "unsubscribed" }); }
    catch (error) { problem = error; }
    return done();
  };
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(commandResponse("execute_program", { timeoutMs: 30_000, code: `
      const waiting = page.waitForEvent('popup');
      await page.getByRole('button', {name:'Open source'}).click();
      const popup = await waiting; return {sourceId:popup.tabId, rootId:page.tabId};` }, "event-open"),
    awaitJob((result) => {
      sourceId = result.result.sourceId; rootId = result.result.rootId;
      expect(sourceId).toEqual(expect.any(Number)); expect(rootId).toEqual(expect.any(Number));
      return commandResponse("subscribe_event", { tabId: sourceId, kind: "console" }, "event-subscribe");
    }),
    after((result) => {
      subscriptionId = result.subscriptionId; expect(subscriptionId).toEqual(expect.any(String));
      return commandResponse("execute_program", { timeoutMs: 30_000, code: `
        const source = await browser.page(${sourceId});
        await source.getByRole('button', {name:'Generate audit log'}).click();
        await source.locator('#status').filter({hasText:'Ready to close'}).waitFor(); return 'ready';` }, "event-generate");
    }),
    awaitJob(() => { responses.unshift(readBeforeClose); return commandResponse("wait_event", { subscriptionId, after: 0, limit: 10, waitMs: 10_000 }, "event-ready-first"); }),
    awaitJob(() => { responses.unshift(readPage); return commandResponse("wait_event", { subscriptionId, after: 0, limit: 10 }, "event-page-first"); }),
    awaitJob(() => commandResponse("unsubscribe_event", { subscriptionId }, "event-unsubscribe")),
    finish,
    textResponse("Audit"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CLOSED_EVENT_TOOLS_DONE", { timeout: 120_000 });
    if (problem) {
      const progress = (await readEvents(opened.page)).filter((event) => event.type === "browser.job.progress").map((event) => event.content);
      throw new Error(`Event test failed; progress: ${JSON.stringify(progress)}`, { cause: problem });
    }
    await expect.poll(() => closedEventScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
