import { expect, type Page } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { manifestFixture } from "./evaluation/manifest-fixture";
import { multitabFixture } from "./evaluation/multitab-fixture";

test.describe("@capability-probe known difficult tool paths", () => {
  test.skip(process.env.SURFWAX_CAPABILITY_PROBES !== "1", "Explicit opt-in: these probes may expose existing tool failures");

  async function run(page: Page, target: Page, provider: Awaited<ReturnType<typeof startProvider>>, responses: MockResponse[], code: string) {
    let result: any;
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Probe"); }
      result = JSON.parse(message.content);
      return textResponse("PROBE_FINISHED");
    };
    responses.push(commandResponse("execute_program", { code, timeoutMs: 10_000 }, "capability-probe"), step);
    await (await configure(page.context(), page, provider.baseURL)).close();
    await target.bringToFront();
    await page.getByTestId("composer-input").fill("Run the browser capability probe.");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.locator(".markdown-body").last()).toContainText("PROBE_FINISHED", { timeout: 25_000 });
    const progress = (await readEvents(page)).filter((event) => event.type === "browser.job.progress").map((event) => event.content);
    expect(result, JSON.stringify(progress)).toMatchObject({ ok: true, state: "succeeded", result: "done" });
  }

  test("consecutive popup event waits observe both windows from one frame", async () => {
    test.setTimeout(45_000);
    const fixture = await multitabFixture(17), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      await run(opened.page, target, provider, responses, `
        const launcher = page.frameLocator('iframe[title="Window launcher"]');
        const first = page.waitForEvent('popup');
        await launcher.getByRole('button', {name:'Open source window'}).click();
        await first;
        const second = page.waitForEvent('popup');
        await launcher.getByRole('button', {name:'Open destination window'}).click();
        await second;
        return 'done';`);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });

  test("click reaches a deeply offscreen target inside a cross-origin frame", async () => {
    test.setTimeout(45_000);
    const fixture = await manifestFixture(17), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      const frame = target.frames().find((item) => item.url().includes("/desk"));
      if (!frame) throw new Error("Fixture frame missing");
      await frame.evaluate(() => {
        const button = document.createElement("button"); button.textContent = "Deep target";
        button.onclick = () => { document.body.dataset.probeClicked = "yes"; };
        document.body.append(button);
      });
      await run(opened.page, target, provider, responses, `
        await page.frameLocator('iframe[title="Manifest desk"]').getByRole('button', {name:'Deep target'}).click();
        return 'done';`);
      expect(await frame.locator("body").getAttribute("data-probe-clicked")).toBe("yes");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });
});
