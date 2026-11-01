import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { rollingFixture, rollingInteractionScore, rollingScore } from "./evaluation/rolling-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// Scripted choices check extension behavior, not model performance.
test("extension re-observes and processes all recycled queue rows", async () => {
  test.setTimeout(300_000);
  const fixture = await rollingFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, finalResult: any, stepNumber = 0;
  const frame = { by: "css", value: 'iframe[title="Rolling queue"]' };
  const progress = { by: "css", value: "#progress", frame };
  const nextButton = { by: "css", value: 'tr[data-next="true"] button', frame };
  const next = (name: string, input: object) => commandResponse(name, input, `rolling-step-${++stepNumber}`);
  const afterTool = (advance: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => {
    const receive: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(receive); return textResponse("Queue"); }
      try {
        const result = JSON.parse(message.content);
        if (result.accepted && result.complete === false || result.terminal === false) {
          responses.unshift(receive);
          return next("get_job", { jobId: result.jobId ?? result.id, after: result.nextCursor, waitMs: 10_000 });
        }
        if (result.ok === false || result.result?.verified === false) throw new Error(`Tool failed: ${JSON.stringify(result)}`);
        return advance(result);
      } catch (error) { problem = error; return textResponse("ROLLING_TOOL_PATH_DONE"); }
    };
    return receive;
  };
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(next("verify_state", { target: progress, textIncludes: "Completed 0 of 30", timeoutMs: 10_000 }));
    for (let index = 1; index <= 30; index++) {
      responses.push(afterTool(() => next("click", { target: nextButton, timeoutMs: 20_000 })));
      const text = index === 30 ? "Queue complete" : `Completed ${index} of 30`;
      responses.push(afterTool(() => next("verify_state", { target: progress, textIncludes: text, timeoutMs: 10_000 })));
    }
    responses.push(afterTool((result) => { finalResult = result; return textResponse("ROLLING_TOOL_PATH_DONE"); }), textResponse("Queue"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ROLLING_TOOL_PATH_DONE", { timeout: 280_000 });
    if (problem) throw problem;
    const events = await readEvents(opened.page);
    expect(finalResult).toMatchObject({ ok: true, result: { verified: true } });
    expect(rollingScore(fixture.evidence())).toBe(true);
    expect(rollingInteractionScore(fixture.evidence())).toBe(true);
    expect(events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "click")).toHaveLength(30);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
