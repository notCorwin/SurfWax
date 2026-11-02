import { expect, test, startProvider, textResponse, commandResponse, configure, openExtension, dispose, readEvents } from "./fixtures";

test("a malformed completion review leaves a correlated diagnostic and can be retried", async () => {
  const reviewBody = "not valid JSON: REVIEW_FAULT_MARKER";
  const provider = await startProvider([
    commandResponse("complete_goal", { taskType: "answer", status: "completed", summary: "First answer" }, "first-goal"),
    (request) => {
      const part = request.messages.findLast((message: any) => message.role === "tool");
      const output = JSON.parse(typeof part.content === "string" ? part.content : part.content.find((item: any) => item.type === "text").text);
      expect(output).toMatchObject({ ok: false, error: { code: "goal-review-unavailable" } });
      return commandResponse("complete_goal", { taskType: "answer", status: "completed", summary: "Recovered answer" }, "second-goal");
    },
    textResponse("diagnostic review"),
  ], 0, undefined, undefined, 0, 0, [reviewBody]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, 1_000_000, { goalMode: true })).close();
    await opened.page.getByTestId("composer-input").fill("Answer the question and finish the goal");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".assistant-message").filter({ hasText: "Recovered answer" })).toBeVisible({ timeout: 45_000 });
    const events = await readEvents(opened.page);
    const started = events.find((event) => event.type === "agent.goal.review.started");
    const failure = events.find((event) => event.type === "agent.goal.review.failed");
    const failedTool = events.find((event) => event.type === "tool.failed" && event.toolCallId?.endsWith("first-goal"));
    expect(started?.content?.reviewId).toEqual(expect.any(String));
    expect(failure).toMatchObject({ conversationId: started.conversationId, runId: started.runId,
      content: { reviewId: started.content.reviewId, responseText: reviewBody }, stopReason: "stop" });
    expect(failedTool).toMatchObject({ conversationId: started.conversationId, runId: started.runId,
      output: { error: { code: "goal-review-unavailable" } } });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
