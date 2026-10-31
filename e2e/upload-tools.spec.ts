import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { uploadFixture, uploadScore } from "./evaluation/upload-fixture";
import { completedProgramOperations } from "./evaluation/tool-lifecycle";

// This scripted execution checks the tool path; it is not a model benchmark.
test("extension tools download and upload the dossier through a chooser", async () => {
  test.setTimeout(120_000);
  const fixture = await uploadFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const sourceOrigin = fixture.origin.replace("127.0.0.1", "localhost");
    let jobId = "", polls = 0;
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const result = last(request);
      if (result.terminal || result.state === "succeeded") {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("UPLOAD_TOOL_PATH_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `upload-poll-${++polls}`);
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 90_000, code: `
      const desk = page.frameLocator('iframe[title="Document desk"]');
      const files = [];
      for (let i = 0; i < 2; i++) {
        const link = desk.getByRole('link').nth(i);
        const name = await link.getAttribute('download');
        const href = await link.getAttribute('href');
        const download = page.waitForEvent('download');
        await link.click();
        await download;
        files.push({name, url: ${JSON.stringify(sourceOrigin)} + href});
      }
      const waiting = page.waitForEvent('filechooser');
      await desk.getByRole('button', {name: 'Choose files'}).click();
      const chooser = await waiting;
      if (!await chooser.isMultiple()) throw new Error('Expected multiple files');
      await chooser.setFiles(files);
      await desk.getByRole('button', {name: 'Submit dossier'}).click();
      return 'done';`,
    }, "upload-program"), (request) => {
      const result = last(request);
      if (result.state === "succeeded") { expect(result).toMatchObject({ ok: true, result: "done" }); return textResponse("UPLOAD_TOOL_PATH_DONE"); }
      expect(result).toMatchObject({ accepted: true });
      jobId = result.jobId;
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, waitMs: 10_000 }, "upload-job");
    }, textResponse("Dossier"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("UPLOAD_TOOL_PATH_DONE", { timeout: 100_000 });
    await expect.poll(() => uploadScore(fixture.evidence())).toBe(true);
    expect(completedProgramOperations(await readEvents(opened.page))["event.setFiles"]).toBe(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
