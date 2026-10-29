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
      commandResponse("execute_program", { code: "await emit('partial'); return {token:'unique-terminal-payload',values:[1,2]};" }, "program"),
      (request) => {
        const result = lastTool(request);
        jobId = result.jobId;
        expect(result).toMatchObject({ ok: true, result: { token: "unique-terminal-payload", values: [1, 2] } });
        return commandResponse("get_job", { jobId, limit: 1 }, "first-page");
      },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ terminal: true, result: { token: "unique-terminal-payload" }, hasMore: true, events: [{ state: "queued" }] });
        return commandResponse("get_job", { jobId, after: result.nextCursor, limit: 100 }, "last-page");
      },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ terminal: true, result: { token: "unique-terminal-payload", values: [1, 2] }, hasMore: false });
        expect(result.events.find((event: any) => event.operation === "emit")).toMatchObject({ output: "partial" });
        const terminal = result.events.find((event: any) => event.state === "succeeded");
        expect(terminal).toMatchObject({ outputAt: "result" });
        expect(terminal).not.toHaveProperty("output");
        expect(JSON.stringify(result).split("unique-terminal-payload")).toHaveLength(2);
        return textResponse("JOB_OUTPUT_DEDUP_OK");
      },
      textResponse("任务结果"),
    );
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the job receipts");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("JOB_OUTPUT_DEDUP_OK", { timeout: 60_000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
