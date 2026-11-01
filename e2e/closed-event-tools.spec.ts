import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { closedEventFixture, closedEventScore } from "./evaluation/closed-event-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The local provider supplies fixed tool calls; no LLM or external service is used.
test("recovers a paginated audit event stream after its source window closes", async () => {
  test.setTimeout(150_000);
  const fixture = await closedEventFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, sourceId = -1, rootId = -1, subscriptionId = "", cursor = 0, beforeCloseCursor = 188, polls = 0;
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
    return commandResponse("fill", { tabId: rootId, target: { by: "label", value: "Audit codes", frame: { by: "css", value: 'iframe[title="Destination"]' } }, value: received.join("\n") }, "event-fill");
  });
  const readBeforeClose: MockResponse = after((result) => {
    expect(result.overflow).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeGreaterThan(beforeCloseCursor);
    beforeCloseCursor = result.nextCursor;
    if (result.events.some((event: any) => event.payload?.args?.[0]?.value === "HEARTBEAT 179")) {
      expect(beforeCloseCursor).toBe(189);
      return commandResponse("click", { tabId: sourceId, target: { by: "role", value: "button", name: "Close source" }, timeoutMs: 30_000 }, "event-close");
    }
    responses.unshift(readBeforeClose);
    return commandResponse("wait_event", { subscriptionId, after: beforeCloseCursor, limit: 10, waitMs: 10_000 }, `event-ready-${beforeCloseCursor}`);
  });
  let closeChecks = 0;
  const awaitClosed: MockResponse = after((result) => {
    expect(result.result, JSON.stringify(result)).toEqual(expect.any(Array));
    if (result.result.some((tab: any) => tab.id === sourceId)) {
      if (++closeChecks > 100) throw new Error("Source window did not close");
      responses.unshift(awaitClosed);
      return commandResponse("list_tabs", {}, `event-close-check-${closeChecks}`);
    }
    responses.unshift(readPage);
    return commandResponse("wait_event", { subscriptionId, after: 0, limit: 10, waitMs: 10_000 }, "event-page-first");
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
    responses.push(commandResponse("list_tabs", {}, "event-root"),
    after((result) => {
      rootId = result.result.find((tab: any) => tab.url === `${fixture.origin}/`)?.id;
      expect(rootId).toEqual(expect.any(Number));
      return commandResponse("click", { tabId: rootId, target: { by: "role", value: "button", name: "Open source" }, timeoutMs: 30_000 }, "event-open");
    }),
    awaitJob(() => commandResponse("list_tabs", {}, "event-find-source")),
    after((result) => {
      sourceId = result.result.find((tab: any) => tab.url?.endsWith("/source"))?.id;
      expect(sourceId).toEqual(expect.any(Number));
      return commandResponse("subscribe_event", { tabId: sourceId, kind: "console" }, "event-subscribe");
    }),
    after((result) => {
      subscriptionId = result.subscriptionId; expect(subscriptionId).toEqual(expect.any(String));
      return commandResponse("click", { tabId: sourceId, target: { by: "role", value: "button", name: "Generate audit log" }, timeoutMs: 30_000 }, "event-generate");
    }),
    awaitJob(() => commandResponse("verify_state", { tabId: sourceId, target: { by: "css", value: "#status" }, textIncludes: "Ready to close", timeoutMs: 10_000 }, "event-ready")),
    after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); responses.unshift(readBeforeClose); return commandResponse("wait_event", { subscriptionId, after: beforeCloseCursor, limit: 1, waitMs: 10_000 }, "event-ready-first"); }),
    awaitJob(() => { responses.unshift(awaitClosed); return commandResponse("list_tabs", {}, "event-close-check"); }),
    awaitJob(() => commandResponse("click", { tabId: rootId, target: { by: "role", value: "button", name: "Submit audit", frame: { by: "css", value: 'iframe[title="Destination"]' } }, timeoutMs: 30_000 }, "event-submit")),
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
