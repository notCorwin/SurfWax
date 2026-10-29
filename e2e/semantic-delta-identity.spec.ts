import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("reconstructs a semantic delta from the full snapshot with duplicate text and reordered nodes", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main><button id="a">Same</button><button id="b">Same</button><button id="c">Third</button><textarea aria-label="Notes">first\nsecond</textarea></main>`;
    });
    let baseline: any, delta: any;
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "baseline"),
      (request) => { baseline = lastTool(request); expect(baseline.mode).toBe("full"); return commandResponse("execute_program", { code: `await page.evaluate(() => { const main=document.querySelector('main'); main.querySelector('#a').remove(); main.prepend(main.querySelector('#c')); main.querySelector('textarea').value='changed\\nvalue'; const added=document.createElement('button'); added.id='d'; added.textContent='Same'; main.append(added); });` }, "mutate"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("inspect_page", { since: baseline.observationId }, "delta"); },
      (request) => { delta = lastTool(request); expect(delta.mode).toBe("delta"); return commandResponse("inspect_page", {}, "fresh"); },
      (request) => {
        const fresh = lastTool(request);
        expect(baseline.items.filter((item: any) => item.line.includes('button "Same"')).length).toBe(2);
        expect(baseline.items.some((item: any) => item.line.includes("first\nsecond"))).toBe(true);
        const state = baseline.items.map((item: any) => ({ ...item }));
        for (const item of delta.items) {
          const index = state.findIndex((old: any) => old.id === item.id);
          if (item.change === "removed") { if (index >= 0) state.splice(index, 1); continue; }
          if (index >= 0) state.splice(index, 1);
          const position = item.after === null ? 0 : state.findIndex((old: any) => old.id === item.after) + 1;
          const { change, after, ...record } = item;
          state.splice(position, 0, record);
        }
        expect(state).toEqual(fresh.items);
        return textResponse("DELTA_IDENTITY_OK");
      },
      textResponse("检查变化"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect the page before and after changes");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DELTA_IDENTITY_OK", { timeout: 45_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
