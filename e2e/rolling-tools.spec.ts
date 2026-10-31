import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { rollingFixture, rollingInteractionScore, rollingScore } from "./evaluation/rolling-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// Scripted choices check extension behavior, not model performance.
test("extension re-observes and processes all recycled queue rows", async () => {
  test.setTimeout(120_000);
  const fixture = await rollingFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let result: any;
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Queue"); }
      result = JSON.parse(message.content);
      return textResponse("ROLLING_TOOL_PATH_DONE");
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 90_000, code: `
      const queue = page.frameLocator('iframe[title="Rolling queue"]');
      const progress = queue.locator('#progress');
      await progress.filter({hasText:'Completed 0 of 30'}).waitFor();
      for (let index = 1; index <= 30; index++) {
        await queue.getByRole('row').filter({hasText:'Next'}).getByRole('button', {name:'Process'}).click();
        const text = index === 30 ? 'Queue complete' : 'Completed ' + index + ' of 30';
        await progress.filter({hasText:text}).waitFor();
      }
      return 'done';`,
    }, "rolling-program"), step, textResponse("Queue"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ROLLING_TOOL_PATH_DONE", { timeout: 105_000 });
    const events = await readEvents(opened.page);
    expect(result, JSON.stringify(fixture.evidence().attempts)).toMatchObject({ ok: true, state: "succeeded", result: "done" });
    expect(rollingScore(fixture.evidence())).toBe(true);
    expect(rollingInteractionScore(fixture.evidence())).toBe(true);
    expect(completedProgramOperations(events)["page.frameLocator.getByRole.filter.getByRole.click"]).toBe(30);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
