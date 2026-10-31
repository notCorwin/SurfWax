import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { networkContextFixture, networkContextScore } from "./evaluation/network-context-fixture";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// A fixed program uses both network contexts; no external model is involved.
for (const seed of [17, 72]) test(`combines a page session with a cross-origin extension fetch (seed ${seed})`, async () => {
  test.setTimeout(120_000);
  const fixture = await networkContextFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, result: any, jobId = "", polls = 0;
  const afterTool: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterTool); return textResponse("Network desk"); }
    try {
      const content = message.content;
      result = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
      if (result.accepted && result.complete === false || result.terminal === false) {
        jobId = result.jobId ?? jobId;
        responses.unshift(afterTool);
        return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `network-context-poll-${++polls}`);
      }
    } catch (error) { problem = error; }
    return textResponse("NETWORK_CONTEXT_DONE");
  };
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(commandResponse("execute_program", { timeoutMs: 60_000, code: `
      const privateUrl = await page.locator('#private-url').textContent();
      const publicUrl = await page.locator('#public-url').textContent();
      const privateResponse = await net.fetch({context:'page',url:privateUrl});
      const publicResponse = await net.fetch({context:'extension',url:publicUrl});
      if (!privateResponse.ok || !publicResponse.ok) throw new Error('Could not read both codes');
      await page.getByLabel('Private code').fill(JSON.parse(privateResponse.body).code);
      await page.getByLabel('Public code').fill(JSON.parse(publicResponse.body).code);
      await page.getByRole('button', {name:'Submit codes'}).click();
      await page.locator('#status').filter({hasText:'Submitted'}).waitFor();
      return 'submitted';` }, "network-context-program"), afterTool, textResponse("Network desk"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NETWORK_CONTEXT_DONE", { timeout: 100_000 });
    if (problem) throw problem;
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "succeeded", result: "submitted" });
    expect(networkContextScore(fixture.evidence()), JSON.stringify(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    expect(browserJobsSettled(events)).toBe(true);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.privateServer); await closeServer(fixture.publicServer);
  }
});
