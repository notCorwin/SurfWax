import { expect, type Page } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { manifestFixture } from "./evaluation/manifest-fixture";
import { multitabFixture } from "./evaluation/multitab-fixture";
import { frameReplacementFixture } from "./evaluation/frame-replacement-fixture";

test.describe("@capability-probe known difficult tool paths", () => {
  test.skip(process.env.SURFWAX_CAPABILITY_PROBES !== "1", "Explicit opt-in: these probes may expose existing tool failures");

  async function run(page: Page, target: Page, provider: Awaited<ReturnType<typeof startProvider>>, responses: MockResponse[], actions: Array<{ name: string; input: object; check?: (result: any) => void }>) {
    let problem: unknown, index = 0, polls = 0;
    const command = (name: string, input: object) => commandResponse(name, input, `probe-${++polls}`);
    const receive: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(receive); return textResponse("Probe"); }
      try {
        const result = JSON.parse(message.content);
        if (result.accepted && result.complete === false || result.terminal === false) {
          responses.unshift(receive);
          return command("get_job", { jobId: result.jobId ?? result.id, after: result.nextCursor, waitMs: 1000 });
        }
        expect(result).toMatchObject({ ok: true });
        actions[index - 1]?.check?.(result);
        const action = actions[index++];
        if (action) { responses.unshift(receive); return command(action.name, action.input); }
        return textResponse("PROBE_FINISHED");
      } catch (error) { problem = error; return textResponse("PROBE_FINISHED"); }
    };
    const first = actions[index++]!;
    responses.push(command(first.name, first.input), receive);
    await (await configure(page.context(), page, provider.baseURL)).close();
    await target.bringToFront();
    await page.getByTestId("composer-input").fill("Run the browser capability probe.");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.locator(".markdown-body").last()).toContainText("PROBE_FINISHED", { timeout: 90_000 });
    if (problem) throw new Error(`Probe failed; progress: ${JSON.stringify((await readEvents(page)).filter((event) => event.type === "browser.job.progress").map((event) => event.content))}`, { cause: problem });
  }

  test("consecutive popup launches open both windows from one frame", async () => {
    test.setTimeout(120_000);
    const fixture = await multitabFixture(17), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      const portalId = await opened.page.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, target.url());
      expect(portalId).toEqual(expect.any(Number));
      const frame = { by: "css", value: 'iframe[title="Window launcher"]' };
      await run(opened.page, target, provider, responses, [
        ...["Open source window", "Open destination window"].map((name) => ({ name: "click", input: { tabId: portalId, target: { by: "role", value: "button", name, frame } } })),
        { name: "list_tabs", input: {}, check: ({ result }) => {
          expect(result.some((tab: any) => tab.url?.includes("/window/source"))).toBe(true);
          expect(result.some((tab: any) => tab.url?.includes("/window/destination"))).toBe(true);
        } },
      ]);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });

  test("click reaches a deeply offscreen target inside a cross-origin frame", async () => {
    test.setTimeout(120_000);
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
      await run(opened.page, target, provider, responses, [{ name: "click", input: { target: { by: "role", value: "button", name: "Deep target", frame: { by: "css", value: 'iframe[title="Manifest desk"]' } } } }]);
      expect(await frame.locator("body").getAttribute("data-probe-clicked")).toBe("yes");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });

  test("click reaches the newly replaced lower cross-origin frame", async () => {
    test.setTimeout(120_000);
    const fixture = await frameReplacementFixture(17), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      await target.evaluate(() => {
        (document.querySelector('#slots') as HTMLElement).style.display = 'block';
        for (const frame of document.querySelectorAll('iframe')) frame.style.width = '540px';
      });
      const progress = (count: number) => ({ name: "verify_state", input: { target: { by: "css", value: "#progress" }, textIncludes: `Completed ${count} of 12`, timeoutMs: 10_000 }, check: (result: any) => expect(result).toMatchObject({ result: { verified: true } }) });
      const click = () => ({ name: "click", input: { target: { by: "role", value: "button", name: "Confirm", exact: true, frame: { by: "css", value: 'section[data-next="true"] iframe' } } } });
      try { await run(opened.page, target, provider, responses, [progress(0), click(), progress(1), click(), progress(2), click(), progress(3)]); }
      catch (cause) {
        const attempts = fixture.evidence().attempts.map(({ round, slot, accepted, trusted }) => ({ round, slot, accepted, trusted }));
        throw new Error(`Frame replacement attempts: ${JSON.stringify(attempts)}`, { cause });
      }
      expect(fixture.evidence().completed).toHaveLength(3);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });
});
