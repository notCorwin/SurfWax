import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("scoped snapshots include visible descendant frames and exclude frames outside the region", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let parentSnapshot: any, childSnapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const crossOrigin = provider.origin.replace("127.0.0.1", "localhost");
    expect(crossOrigin).not.toBe(provider.origin);
    await target.evaluate(({ same, cross }) => {
      document.body.innerHTML = `<main>
        <p>ROOT_OUTSIDE_MARKER</p>
        <section id="region"><p>ROOT_INSIDE_MARKER</p>
          <iframe id="same" title="Same origin document" src="${same}"></iframe>
          <iframe id="cross" title="Cross origin document" src="${cross}"></iframe>
          <iframe id="hidden" title="Hidden document" style="display:none" src="${same}"></iframe>
        </section>
        <iframe id="outside" title="Outside document" src="${same}"></iframe>
      </main>`;
      for (const frame of document.querySelectorAll("iframe")) {
        frame.style.width = "300px";
        frame.style.height = "160px";
      }
    }, { same: `${provider.origin}/target`, cross: `${crossOrigin}/target` });
    const same = target.frameLocator("#same"), cross = target.frameLocator("#cross");
    const hidden = target.frameLocator("#hidden"), outside = target.frameLocator("#outside");
    await Promise.all([same, cross, hidden, outside].map((frame) => frame.locator("body").waitFor({ state: "attached" })));
    await same.locator("body").evaluate((body) => { body.innerHTML = "<p>SAME_INSIDE_FRAME</p><button>Same frame action</button>"; });
    await cross.locator("body").evaluate((body) => {
      body.innerHTML = `<p>CHILD_OUTSIDE_REGION</p><section id="child-region">
        <p>CROSS_INSIDE_REGION</p><button>Cross frame action</button></section>`;
    });
    await hidden.locator("body").evaluate((body) => { body.innerHTML = "<p>HIDDEN_FRAME_CONTENT</p>"; });
    await outside.locator("body").evaluate((body) => { body.innerHTML = "<p>OUTSIDE_FRAME_CONTENT</p>"; });
    responses.push(
      commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#region" } }, "region-containing-frames"),
      (request) => {
        parentSnapshot = lastTool(request);
        return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#child-region", frame: { by: "css", value: "#cross" } } }, "region-in-child-frame");
      },
      (request) => { childSnapshot = lastTool(request); return textResponse("REGION_FRAMES_DONE"); },
      textResponse("Inspect frame regions"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the region and its child frames, then the cross-frame region");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REGION_FRAMES_DONE", { timeout: 60_000 });

    expect.soft(parentSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const parent = JSON.stringify(parentSnapshot?.items ?? []);
    for (const present of ["ROOT_INSIDE_MARKER", "SAME_INSIDE_FRAME", "Same frame action", "CHILD_OUTSIDE_REGION", "CROSS_INSIDE_REGION", "Cross frame action"]) expect.soft(parent).toContain(present);
    for (const absent of ["ROOT_OUTSIDE_MARKER", "HIDDEN_FRAME_CONTENT", "OUTSIDE_FRAME_CONTENT"]) expect.soft(parent).not.toContain(absent);
    for (const label of ["Same frame action", "Cross frame action"]) {
      const button = parentSnapshot?.items?.find((item: any) => itemLine(item).includes(`- button "${label}"`));
      expect.soft(button?.ref).toEqual(expect.any(String));
    }

    expect.soft(childSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const child = JSON.stringify(childSnapshot?.items ?? []);
    for (const present of ["CROSS_INSIDE_REGION", "Cross frame action"]) expect.soft(child).toContain(present);
    for (const absent of ["ROOT_OUTSIDE_MARKER", "ROOT_INSIDE_MARKER", "SAME_INSIDE_FRAME", "CHILD_OUTSIDE_REGION", "HIDDEN_FRAME_CONTENT", "OUTSIDE_FRAME_CONTENT", "Cross origin document"]) expect.soft(child).not.toContain(absent);
    expect.soft(childSnapshot?.items?.find((item: any) => itemLine(item).includes('- button "Cross frame action"'))?.ref).toEqual(expect.any(String));
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
