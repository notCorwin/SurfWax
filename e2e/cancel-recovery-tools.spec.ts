import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { cancelRecoveryFixture, cancelRecoveryScore } from "./evaluation/cancel-recovery-fixture";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The local provider drives actual tools; the server determines whether a write committed.
for (const seed of [17, 72]) test(`checks a committed write after cancelling its waiting job (seed ${seed})`, async () => {
  test.setTimeout(120_000);
  const fixture = await cancelRecoveryFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, jobId = "", polls = 0, cancelled = false;
  const done = () => textResponse("CANCEL_RECOVERY_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Recovery"); }
      try {
        const content = message.content;
        return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content));
      } catch (error) { problem = error; return done(); }
    };
    return step;
  };
  const waitForCommit: MockResponse = after((result) => {
    expect(result).toMatchObject({ terminal: false });
    if (fixture.evidence().committedReference !== null) return commandResponse("cancel_job", { jobId }, "cancel-write");
    responses.unshift(waitForCommit);
    return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 1000 }, `commit-poll-${++polls}`);
  });
  const waitForCancellation: MockResponse = after((result) => {
    if (!result.terminal) {
      responses.unshift(waitForCancellation);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 1000 }, `cancel-poll-${++polls}`);
    }
    expect(result).toMatchObject({ terminal: true, state: "cancelled" });
    cancelled = true;
    return commandResponse("execute_program", { timeoutMs: 30_000, code: `
      const desk = page.frameLocator('iframe[title="Recovery desk"]');
      await desk.getByRole('button', {name:'Check status'}).click();
      await desk.locator('#check-status').filter({hasText:${JSON.stringify(`Completed ${fixture.evidence().expectedReference}`)}}).waitFor();
      return 'verified';` }, "verify-write");
  });
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(commandResponse("execute_program", { background: true, timeoutMs: 60_000, code: `
      const desk = page.frameLocator('iframe[title="Recovery desk"]');
      await desk.getByLabel('Transaction reference').fill(${JSON.stringify(fixture.evidence().expectedReference)});
      await desk.getByRole('button', {name:'Submit transaction'}).click();
      await desk.locator('#submit-status').filter({hasText:'Submitted'}).waitFor();
      return 'unexpected confirmation';` }, "submit-write"),
    after((result) => {
      expect(result).toMatchObject({ accepted: true, complete: false, jobId: expect.any(String) });
      jobId = result.jobId;
      responses.unshift(waitForCommit);
      return commandResponse("get_job", { jobId, waitMs: 1000 }, `commit-poll-${++polls}`);
    }),
    waitForCancellation,
    after((result) => { expect(result).toMatchObject({ ok: true, state: "succeeded", result: "verified" }); return done(); }),
    textResponse("Recovery"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CANCEL_RECOVERY_DONE", { timeout: 100_000 });
    if (problem) throw problem;
    expect(cancelled).toBe(true);
    expect(cancelRecoveryScore(fixture.evidence())).toBe(true);
    fixture.release();
    await expect(target.frameLocator('iframe[title="Recovery desk"]').locator("#submit-status")).toHaveText("Submitted");
    expect(cancelRecoveryScore(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    expect(events.some((event) => event.type === "browser.job.state" && event.content?.jobId === jobId && event.content?.state === "cancelled")).toBe(true);
    expect(browserJobsSettled(events)).toBeNull();
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { fixture.release(); await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
