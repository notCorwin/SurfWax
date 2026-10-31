import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { multitabFixture, multitabScore } from "./evaluation/multitab-fixture";

// The script exercises the extension path; it is not a model benchmark.
test("extension tools transfer between similarly structured popup windows", async () => {
  test.setTimeout(45_000);
  const fixture = await multitabFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let jobId = "", polls = 0, finalResult: any;
    const last = (request: any) => JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
    const poll: MockResponse = (request) => {
      const result = last(request);
      if (result.terminal || result.state === "succeeded") {
        finalResult = result;
        return textResponse("WINDOW_TRANSFER_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `window-poll-${++polls}`);
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 15_000, code: `
      const launcher = page.frameLocator('iframe[title="Window launcher"]');
      const first = page.waitForEvent('popup');
      await launcher.getByRole('button', {name:'Open source window'}).click();
      const source = await first;
      await launcher.getByRole('button', {name:'Open destination window'}).click();
      let tab;
      for (let attempt = 0; attempt < 100; attempt++) {
        tab = (await browser.tabs.list()).find(item => item.url && item.url.includes('/window/destination'));
        if (tab) break;
        await sleep(50);
      }
      if (!tab) throw new Error('Destination window not found');
      const destination = await browser.page(tab.id);
      const value = await source.locator('strong').textContent();
      await destination.getByLabel('Transfer code').fill(value);
      await destination.getByRole('button', {name:'Submit transfer'}).click();
      return 'done';`,
    }, "window-transfer"), (request) => {
      const result = last(request);
      if (result.state === "succeeded" || result.state === "failed") { finalResult = result; return textResponse("WINDOW_TRANSFER_DONE"); }
      if (!result.accepted) { finalResult = result; return textResponse("WINDOW_TRANSFER_DONE"); }
      jobId = result.jobId;
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, waitMs: 10_000 }, "window-job");
    }, textResponse("Transfer"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("WINDOW_TRANSFER_DONE", { timeout: 30_000 });
    const progress = (await readEvents(opened.page)).filter((event) => event.type === "browser.job.progress").map((event) => event.content);
    expect(finalResult, JSON.stringify({ progress, evidence: fixture.evidence() })).toMatchObject({ ok: true, state: "succeeded" });
    await expect.poll(() => multitabScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
