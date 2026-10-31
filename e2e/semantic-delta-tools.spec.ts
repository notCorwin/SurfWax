import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { semanticDeltaFixture, semanticDeltaInteractionScore, semanticDeltaScore } from "./evaluation/semantic-delta-fixture";
import { semanticProgram } from "./evaluation/semantic-program";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// A fixed local program exercises the actual extension; it is not a model score.
for (const seed of [17, 72]) test(`reassembles semantic continuations and acts on fresh refs (seed ${seed})`, async () => {
  test.setTimeout(180_000);
  const fixture = await semanticDeltaFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    let result: any, jobId = "", polls = 0;
    const afterTool: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(afterTool); return textResponse("Semantic queue"); }
      result = JSON.parse(message.content);
      if (result.accepted && result.complete === false || result.terminal === false) {
        jobId = result.jobId ?? jobId; responses.unshift(afterTool);
        return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `semantic-job-${++polls}`);
      }
      return textResponse("SEMANTIC_DELTA_TOOLS_DONE");
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 150_000, code: semanticProgram() }, "semantic-delta-program"), afterTool, textResponse("Semantic queue"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SEMANTIC_DELTA_TOOLS_DONE", { timeout: 165_000 });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "succeeded", result: { rounds: 12, freshChecks: 1 } });
    expect(result.result.pageCount).toBeGreaterThan(12);
    expect(result.result.fragmentCount).toBeGreaterThan(1);
    expect(result.result.deltaChanges).toBeGreaterThan(11);
    await expect.poll(() => semanticDeltaScore(fixture.evidence())).toBe(true);
    expect(semanticDeltaInteractionScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
