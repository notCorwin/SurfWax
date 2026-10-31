import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { artifactHandoffFixture, artifactHandoffScore } from "./evaluation/artifact-handoff-fixture";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// This deterministic provider reconstructs the data exclusively from tool responses.
for (const seed of [17, 72]) test(`recovers a background job result in pages and submits the reconstructed copy (seed ${seed})`, async () => {
  test.setTimeout(180_000);
  const fixture = await artifactHandoffFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, jobId = "", polls = 0, offset = 0, pages = 0, splitSurrogates = 0, value = "";
  let access: { artifactId: number; path?: (string | number)[] };
  const limit = 2800;
  const done = () => textResponse("ARTIFACT_HANDOFF_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Handoff"); }
      try {
        const content = message.content;
        return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content));
      } catch (error) { problem = error; return done(); }
    };
    return step;
  };
  const readPage: MockResponse = after((result) => {
    expect(result).toMatchObject({ ok: true, result: expect.any(String) });
    expect(result.result.length).toBeLessThanOrEqual(limit);
    if (/[\uD800-\uDBFF]$/.test(result.result)) splitSurrogates++;
    value += result.result; offset += result.result.length; pages++;
    if (result.result.length === limit) {
      responses.unshift(readPage);
      return commandResponse("read_artifact", { ...access, offset, limit }, `handoff-page-${pages}`);
    }
    expect(pages).toBeGreaterThan(2);
    expect(splitSurrogates).toBeGreaterThan(0);
    expect(value.length).toBe(fixture.evidence().expectedCodeUnits);
    return commandResponse("execute_program", { timeoutMs: 60_000, code: `
      const desk = page.frameLocator('iframe[title="Handoff desk"]');
      await desk.getByLabel('Complete copy').fill(${JSON.stringify(value)});
      await desk.getByRole('button', {name:'Submit copy'}).click();
      await desk.locator('#status').filter({hasText:'Submitted'}).waitFor();
      return 'submitted';` }, "handoff-submit");
  });
  const wait: MockResponse = after((result) => {
    if (result.terminal === false) {
      responses.unshift(wait);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `handoff-poll-${++polls}`);
    }
    expect(result).toMatchObject({ terminal: true, state: "succeeded", resultAccess: { artifactId: expect.any(Number), path: expect.any(Array) } });
    access = result.resultAccess;
    responses.unshift(readPage);
    return commandResponse("read_artifact", { ...access, offset: 0, limit }, "handoff-page-0");
  });
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(commandResponse("execute_program", { background: true, timeoutMs: 60_000, code: `
      return await page.frameLocator('iframe[title="Handoff desk"]').getByLabel('Source data').inputValue();` }, "handoff-collect"),
    after((result) => {
      expect(result).toMatchObject({ accepted: true, complete: false, jobId: expect.any(String) });
      jobId = result.jobId;
      responses.unshift(wait);
      return commandResponse("get_job", { jobId, waitMs: 10_000 }, `handoff-poll-${++polls}`);
    }),
    after((result) => { expect(result).toMatchObject({ ok: true, state: "succeeded", result: "submitted" }); return done(); }),
    textResponse("Handoff"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_HANDOFF_DONE", { timeout: 160_000 });
    if (problem) throw problem;
    await expect.poll(() => artifactHandoffScore(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    expect(browserJobsSettled(events)).toBe(true);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
