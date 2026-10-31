import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "./fixtures";
import { sequenceFixture, sequenceScore } from "./evaluation/sequence-fixture";
import { dispatchFixture, dispatchScore } from "./evaluation/dispatch-fixture";

// A scripted tool execution contract, not a measurement of model performance.
test("extension tools can complete the dispatch capability level", async () => {
  test.setTimeout(120_000);
  const fixture = await sequenceFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    let jobId = "", polls = 0;
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const result = last(request);
      if (result.terminal || result.state === "succeeded") {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("DISPATCH_TOOL_PATH_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `dispatch-poll-${++polls}`);
    };
    responses.push(commandResponse("execute_program", {
      timeoutMs: 90_000,
      code: `
        const editor = page.frameLocator('iframe[title="Dispatch workspace"]').frameLocator('iframe[title="Sequence editor"]');
        const desired = ${JSON.stringify(expected.sequence)};
        const list = editor.getByRole('list', { name: 'Shipment order' });
        for (let i = 0; i < desired.length; i++) {
          let index = -1;
          for (let j = i; j < desired.length; j++) if (await list.getByRole('button').nth(j).textContent() === desired[i]) { index = j; break; }
          if (index < 0) throw new Error('Shipment not found');
          while (index-- > i) await list.getByRole('button', {name: desired[i], exact: true}).press('ArrowUp');
        }
        await editor.getByLabel('Dispatch reference').fill(${JSON.stringify(expected.reference)});
        await editor.getByLabel('Confirm dispatch').check();
        await editor.getByRole('button', {name: 'Send dispatch'}).click();
        return 'done';`,
    }, "dispatch-program"), (request) => {
      const result = last(request);
      if (result.state === "succeeded") { expect(result).toMatchObject({ ok: true, result: "done" }); return textResponse("DISPATCH_TOOL_PATH_DONE"); }
      expect(result).toMatchObject({ accepted: true });
      jobId = result.jobId;
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, waitMs: 10_000 }, "dispatch-job");
    }, textResponse("Dispatch"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DISPATCH_TOOL_PATH_DONE", { timeout: 100_000 });
    await expect.poll(() => sequenceScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});

test.fixme("extension tools can complete the popup and dialog capability level", async () => {
  test.setTimeout(120_000);
  const fixture = await dispatchFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let jobId = "", polls = 0, code = "";
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const result = last(request);
      if (result.terminal || result.state === "succeeded") {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("REVIEW_TOOL_PATH_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `review-poll-${++polls}`);
    };
    responses.push(commandResponse("execute_program", {
      timeoutMs: 90_000,
      code: `
        const popupWait = page.waitForEvent('popup');
        await page.frameLocator('iframe[title="Dispatch desk"]').getByRole('button', {name: 'Open dispatch review'}).click();
        const popup = await popupWait;
        return {tabId: popup.tabId, code: await popup.locator('strong').textContent()};`,
    }, "review-program"), (request) => {
      const result = last(request);
      expect(result).toMatchObject({ ok: true, state: "succeeded", result: { tabId: expect.any(Number), code: expect.any(String) } });
      code = result.result.code;
      return commandResponse("click", { tabId: result.result.tabId, target: { by: "role", value: "button", name: "Confirm dispatch" }, timeoutMs: 30_000 }, "review-click");
    }, (request) => {
      const result = last(request);
      expect(result).toMatchObject({ accepted: true, state: "blocked", blockedBy: { kind: "dialog", type: "prompt" } });
      jobId = result.jobId;
      return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: code }, "review-answer");
    }, (request) => {
      expect(last(request)).toMatchObject({ state: "completed" });
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, waitMs: 10_000 }, "review-job");
    }, textResponse("Dispatch review"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REVIEW_TOOL_PATH_DONE", { timeout: 100_000 });
    await expect.poll(() => dispatchScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
