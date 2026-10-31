import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { claimsFixture, claimsScore } from "./evaluation/claims-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// A local scripted provider exercises actual extension tools, not model understanding.
for (const { seed, duplicate } of [{ seed: 17, duplicate: false }, { seed: 72, duplicate: false }, { seed: 17, duplicate: true }]) {
  test(`extension reviews the paginated claims queue (seed ${seed}, stale retry ${duplicate})`, async () => {
    test.setTimeout(120_000);
    const fixture = await claimsFixture(seed), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(fixture.origin);
      let result: any, jobId = "", polls = 0;
      const afterTool: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(afterTool); return textResponse("Claims"); }
        result = JSON.parse(message.content);
        if (result.accepted && result.complete === false || result.terminal === false) {
          jobId = result.jobId ?? jobId;
          responses.unshift(afterTool);
          return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `claims-poll-${++polls}`);
        }
        return textResponse("CLAIMS_TOOL_PATH_DONE");
      };
      responses.push(commandResponse("execute_program", { timeoutMs: 90_000, code: `
        const queue = page.frameLocator('iframe[title="Claims queue"]');
        const progress = queue.locator('#page');
        await progress.filter({hasText:'Page 1 of 3'}).waitFor();
        let retried = false;
        for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
          const rows = queue.locator('tbody tr');
          for (let index = 0; index < 3; index++) {
            const row = rows.nth(index), cells = row.locator('td');
            const id = (await cells.nth(0).textContent()).trim();
            const region = (await cells.nth(1).textContent()).trim();
            const amount = Number((await cells.nth(2).textContent()).trim().slice(1));
            const status = (await cells.nth(3).textContent()).trim();
            if (region !== 'APAC' || amount > 500 || status !== 'pending') continue;
            await row.getByRole('button', {name:'Approve ' + id, exact:true}).click();
            await cells.nth(3).filter({hasText:'approved'}).waitFor();
            if (${duplicate} && !retried) {
              // Reproduce an obsolete UI retry, without issuing a direct request.
              await row.locator('button').evaluate(button => { button.hidden = false; button.dataset.revision = '1'; });
              await row.locator('button').click();
              await queue.locator('#notice').filter({hasText:'Approval failed for ' + id}).waitFor();
              retried = true;
            }
          }
          if (pageNumber < 3) {
            await queue.getByRole('button', {name:'Next page'}).click();
            await progress.filter({hasText:'Page ' + (pageNumber + 1) + ' of 3'}).waitFor();
          }
        }
        return 'done';`,
      }, "claims-program"), afterTool, textResponse("Claims"));
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill(fixture.prompt);
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("CLAIMS_TOOL_PATH_DONE", { timeout: 105_000 });
      expect(result).toMatchObject({ ok: true, state: "succeeded", result: "done" });
      const evidence = fixture.evidence();
      const events = await readEvents(opened.page);
      expect(toolLifecycleEvidence(events).complete).toBe(true);
      expect(Object.entries(completedProgramOperations(events)).filter(([name]) => name.endsWith(".click")).reduce((total, [, count]) => total + count, 0)).toBeGreaterThanOrEqual(5);
      expect(evidence.attempts.filter((attempt) => attempt.accepted)).toHaveLength(3);
      expect(new Set(evidence.attempts.filter((attempt) => attempt.accepted).map((attempt) => attempt.id)).size).toBe(3);
      expect(evidence.attempts).toHaveLength(duplicate ? 4 : 3);
      if (duplicate) {
        expect(evidence.attempts[1]).toMatchObject({ id: evidence.attempts[0]!.id, revision: 1, accepted: false });
        expect(claimsScore(evidence)).toBe(false);
      } else {
        expect(evidence.attempts.every((attempt) => attempt.accepted)).toBe(true);
        expect(claimsScore(evidence)).toBe(true);
      }
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
      await closeServer(fixture.server);
    }
  });
}
