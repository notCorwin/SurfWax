import { expect, test, commandResponse, textResponse, startProvider, openExtension, configure, dispose, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("paginates a fixed job snapshot across model calls in Chrome", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const ids: string[] = [];
    let cursor = "";
    responses.push(
      commandResponse("execute_program", { code: "return 1;" }, "job-one"),
      (request) => { ids.push(lastTool(request).jobId); return commandResponse("execute_program", { code: "return 2;" }, "job-two"); },
      (request) => { ids.push(lastTool(request).jobId); return commandResponse("execute_program", { code: "return 3;" }, "job-three"); },
      (request) => { ids.push(lastTool(request).jobId); return commandResponse("list_jobs", { limit: 1 }, "page-one"); },
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ jobs: [{ id: ids[0], state: "succeeded" }], hasMore: true, nextCursor: expect.any(String) });
        cursor = page.nextCursor;
        return commandResponse("execute_program", { code: "return 4;" }, "later-job");
      },
      (request) => { const later = lastTool(request); expect(later.jobId).toEqual(expect.any(String)); expect(ids).not.toContain(later.jobId); return commandResponse("list_jobs", { limit: 1, cursor }, "page-two"); },
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ jobs: [{ id: ids[1], state: "succeeded" }], hasMore: true, nextCursor: expect.any(String) });
        return commandResponse("list_jobs", { limit: 1, cursor: page.nextCursor }, "page-three");
      },
      (request) => {
        expect(lastTool(request)).toEqual({ jobs: [{ id: ids[2], state: "succeeded" }], hasMore: false });
        return textResponse("JOB_PAGINATION_OK");
      },
      textResponse("任务分页"),
    );
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("list jobs across pages");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("JOB_PAGINATION_OK", { timeout: 30_000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
