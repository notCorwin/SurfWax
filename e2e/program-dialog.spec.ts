import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

test("hands off a dialog when a program abandoned its event waiter", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    target.on("dialog", () => {});
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Abandoned waiter prompt";
      button.onclick = () => { document.body.dataset.answer = prompt("Abandoned waiter?") ?? "cancelled"; };
      document.body.append(button);
    });
    let jobId = "", count = 0;
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = last(request);
      if (job.terminal) { expect(job).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("ABANDONED_DIALOG_OK"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `abandoned-poll-${++count}`);
    };
    responses.push(
      commandResponse("execute_program", { code: "await Promise.race([page.waitForEvent('dialog'), sleep(50)]); await page.getByRole('button', {name:'Abandoned waiter prompt'}).click(); return 'done';", timeoutMs: 30_000 }, "abandoned-program"),
      (request) => {
        const result = last(request);
        expect(result).toMatchObject({ state: "blocked", accepted: true, blockedBy: { kind: "dialog", message: "Abandoned waiter?" } });
        jobId = result.jobId;
        return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: "recovered" }, "abandoned-answer");
      },
      (request) => { expect(last(request)).toMatchObject({ state: "completed" }); return commandResponse("get_job", { jobId }, "abandoned-job"); },
      poll, textResponse("处理对话框"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("handle the prompt");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ABANDONED_DIALOG_OK", { timeout: 30_000 });
    expect(await target.locator("body").getAttribute("data-answer")).toBe("recovered");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("a program can handle its own cross-origin frame dialog after handoff", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    target.on("dialog", () => {});
    const frame = target.frames().find((item) => item.url().includes("localhost"))!;
    await frame.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Frame prompt";
      button.onclick = () => { document.body.dataset.answer = prompt("Frame question?") ?? "cancelled"; };
      document.body.append(button);
    });
    let jobId = "", count = 0;
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = last(request);
      if (job.terminal) { expect(job).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("FRAME_DIALOG_OK"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `frame-dialog-poll-${++count}`);
    };
    responses.push(
      commandResponse("execute_program", { code: "const waiting = page.waitForEvent('dialog'); const action = page.frameLocator('iframe[src*=localhost]').getByRole('button', {name:'Frame prompt'}).click(); const dialog = await waiting; await dialog.accept('frame-answer'); await action; return 'done';", timeoutMs: 30_000 }, "frame-dialog-program"),
      (request) => {
        const result = last(request);
        if (result.state === "blocked") {
          expect(result.blockedBy.source.tabId).toEqual(expect.any(Number));
          jobId = result.jobId;
          responses.unshift(poll);
          return commandResponse("get_job", { jobId }, "frame-dialog-job");
        }
        expect(result).toMatchObject({ ok: true, state: "succeeded", result: "done" });
        return textResponse("FRAME_DIALOG_OK");
      },
      textResponse("处理框架对话框"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("handle the frame prompt");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_DIALOG_OK", { timeout: 30_000 });
    expect(await frame.locator("body").getAttribute("data-answer")).toBe("frame-answer");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
