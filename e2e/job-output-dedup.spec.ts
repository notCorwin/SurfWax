import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, configure, dispose, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("job receipt pages refer to the terminal result without duplicating it", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    let jobId = "";
    responses.push(
      commandResponse("get_page_info", {}, "page-info"),
      (request) => {
        const result = lastTool(request);
        jobId = result.jobId;
        expect(result).toMatchObject({ ok: true, result: { title: "unique-terminal-payload" } });
        return commandResponse("get_job", { jobId, limit: 1 }, "first-page");
      },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ terminal: true, result: { title: "unique-terminal-payload" }, hasMore: true, events: [{ state: "queued" }] });
        return commandResponse("get_job", { jobId, after: result.nextCursor, limit: 100 }, "last-page");
      },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ terminal: true, result: { title: "unique-terminal-payload" }, hasMore: false });
        const terminal = result.events.find((event: any) => event.state === "succeeded");
        expect(terminal).toMatchObject({ outputAt: "result" });
        expect(terminal).not.toHaveProperty("output");
        expect(result.events.filter((event: any) => event.outputAt === "result")).toHaveLength(1);
        return textResponse("JOB_OUTPUT_DEDUP_OK");
      },
      textResponse("任务结果"),
    );
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => { document.title = "unique-terminal-payload"; });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the job receipts");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("JOB_OUTPUT_DEDUP_OK", { timeout: 60_000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
