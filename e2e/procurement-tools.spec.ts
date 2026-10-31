import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { procurementFixture, procurementScore } from "./evaluation/procurement-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The provider is a deterministic controller. This tests the extension's ability
// to execute the task, not an LLM's ability to plan or interpret instructions.
for (const seed of [17, 73]) {
  test(`scripted procurement review across paginated cross-origin invoices (seed ${seed})`, async () => {
    test.setTimeout(300_000);
    const fixture = await procurementFixture(seed), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(fixture.origin);
      let result: any, jobId = "", polls = 0;
      const afterTool: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        // Title generation may arrive while the tool is still running.
        if (!message) { responses.unshift(afterTool); return textResponse("Procurement"); }
        result = JSON.parse(message.content);
        if ((result.accepted && result.complete === false) || result.terminal === false) {
          jobId = result.jobId ?? jobId;
          responses.unshift(afterTool);
          return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `procurement-poll-${++polls}`);
        }
        return textResponse("PROCUREMENT_TOOL_PATH_DONE");
      };
      responses.push(commandResponse("execute_program", { timeoutMs: 240_000, code: `
        const queue = page.frameLocator('iframe[title="Invoice queue"]');
        const progress = queue.locator('#page');
        await progress.filter({hasText:'Page 1 of '}).waitFor();
        const pageCount = Number((await progress.textContent()).match(/Page 1 of (\\d+)/)[1]);
        const reviewed = [];
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
          const rows = queue.locator('tbody tr');
          for (let index = 0; index < await rows.count(); index++) {
            const row = rows.nth(index), cells = row.locator('td');
            const id = (await cells.nth(0).textContent()).trim();
            const region = (await cells.nth(1).textContent()).trim();
            const status = (await cells.nth(2).textContent()).trim();
            if (region !== 'APAC' || status !== 'pending') continue;
            await row.getByRole('button', {name:'Review ' + id, exact:true}).click();
            await queue.locator('#detail-id').filter({hasText:'Invoice: ' + id}).waitFor();
            const amount = Number((await queue.locator('#amount').textContent()).replace('Amount: $', ''));
            const hold = (await queue.locator('#hold').textContent()).trim();
            if (amount <= 500 && hold === 'Hold: No') {
              await queue.getByLabel('Decision').selectOption('Approve');
              await queue.getByLabel('Reason').selectOption('Within policy');
              await queue.getByLabel('Memo').fill('Approved under APAC policy');
              await queue.getByRole('button', {name:'Submit review'}).click();
              await queue.locator('#notice').filter({hasText:'Review submitted for ' + id}).waitFor();
              await cells.nth(2).filter({hasText:'approved'}).waitFor();
              reviewed.push(id);
            } else {
              await queue.getByRole('button', {name:'Close details'}).click();
            }
          }
          if (pageNumber < pageCount) {
            await queue.getByRole('button', {name:'Next page'}).click();
            await progress.filter({hasText:'Page ' + (pageNumber + 1) + ' of ' + pageCount}).waitFor();
          }
        }
        return reviewed;`,
      }, "procurement-program"), afterTool, textResponse("Procurement"));
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill(fixture.prompt);
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("PROCUREMENT_TOOL_PATH_DONE", { timeout: 270_000 });
      const evidence = fixture.evidence();
      expect(result).toMatchObject({ ok: true, state: "succeeded", result: expect.any(Array) });
      expect([...result.result].sort()).toEqual([...evidence.expectedIds].sort());
      expect(evidence.attempts).toHaveLength(evidence.expectedIds.length);
      expect(evidence.expectedIds.length).toBeGreaterThanOrEqual(6);
      expect(procurementScore(evidence), JSON.stringify(evidence)).toBe(true);
      const events = await readEvents(opened.page);
      expect(toolLifecycleEvidence(events).complete).toBe(true);
      const operations = completedProgramOperations(events);
      expect(Object.entries(operations).filter(([name]) => name.endsWith('.click')).reduce((total, [, count]) => total + count, 0)).toBeGreaterThanOrEqual(20);
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
      await closeServer(fixture.server);
    }
  });
}
