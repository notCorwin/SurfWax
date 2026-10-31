import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { manifestFixture, manifestScore } from "./evaluation/manifest-fixture";

// Scripted extension execution validates the tool path, not model performance.
test("extension tools preserve and submit the complete paginated manifest via an artifact", async () => {
  test.setTimeout(180_000);
  const fixture = await manifestFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let artifactId = 0, collected: any, first: any, lastPage: any, submission: any;
    const done = () => textResponse("MANIFEST_TOOL_PATH_DONE");
    // Title generation can race a long-running tool call. Keep the next
    // scripted tool response queued until an agent request actually arrives.
    const afterTool = (next: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
      const step: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(step); return textResponse("Manifest"); }
        return next(JSON.parse(message.content));
      };
      return step;
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 120_000, code: `
      const desk = page.frameLocator('iframe[title="Manifest desk"]');
      const current = desk.locator('#page');
      await current.filter({hasText:'Page 1 of 20'}).waitFor();
      const pages = [];
      for (let index = 1; index <= 20; index++) {
        pages.push(await desk.getByRole('list', {name:'Tracking codes'}).innerText());
        if (index < 20) {
          await desk.getByRole('button', {name:'Next page'}).click();
          await current.filter({hasText:'Page ' + (index + 1) + ' of 20'}).waitFor();
        }
      }
      return pages.join('\\n');`,
    }, "collect-manifest"), afterTool((result) => {
      collected = result;
      if (!Number.isSafeInteger(collected.$ref)) return done();
      artifactId = collected.$ref;
      return commandResponse("read_artifact", { artifactId, path: ["result"], offset: 0, limit: 32 }, "manifest-first");
    }), afterTool((result) => {
      first = result;
      return commandResponse("read_artifact", { artifactId, path: ["result"], offset: fixture.evidence().expectedCodeUnits - 32, limit: 32 }, "manifest-last");
    }), afterTool((result) => {
      lastPage = result;
      return commandResponse("execute_program", { timeoutMs: 30_000, code: `
        const value = await artifacts.read(${artifactId}, {path:['result']});
        const desk = page.frameLocator('iframe[title="Manifest desk"]');
        await desk.getByLabel('Complete manifest').fill(value);
        await desk.getByRole('button', {name:'Submit manifest'}).click();
        return 'done';`,
      }, "submit-manifest");
    }), afterTool((result) => { submission = result; return done(); }), textResponse("Manifest"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MANIFEST_TOOL_PATH_DONE", { timeout: 160_000 });
    const progress = (await readEvents(opened.page)).filter((event) => event.type === "browser.job.progress").map((event) => event.content);
    expect(collected, JSON.stringify({ pageReads: fixture.evidence().pageReads, progress })).toMatchObject({ $ref: expect.any(Number) });
    expect(first).toMatchObject({ ok: true, result: expect.any(String) });
    expect(lastPage).toMatchObject({ ok: true, result: expect.any(String) });
    expect(first.result).toHaveLength(32);
    expect(lastPage.result).toHaveLength(32);
    expect(lastPage.result).toContain("海🌊");
    expect(submission).toMatchObject({ ok: true, state: "succeeded", result: "done" });
    await expect.poll(() => manifestScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
