import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine, inspectText } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("region snapshots preserve DOM membership and semantic order across aria-owns", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, clicked: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <section id="scope" role="region" aria-label="Selected region" aria-owns="outside-heading">
          <h2 id="inside-heading">REGION_HEADING</h2>
          <button id="action">Region action</button>
        </section>
        <div role="group" aria-owns="inside-heading"></div>
        <h2 id="outside-heading">OUTSIDE_HEADING</h2>
      </main>`;
      document.querySelector("#action")!.addEventListener("click", () => { document.body.dataset.clicked = "yes"; });
    });
    // Confirm Chrome actually applied both ownership edges; otherwise a
    // passing scoped result would not exercise the regression.
    const cdp = await target.context().newCDPSession(target);
    const ax = await cdp.send("Accessibility.getFullAXTree");
    const region = ax.nodes.find((node) => node.role?.value === "region" && node.name?.value === "Selected region");
    const inside = ax.nodes.find((node) => node.role?.value === "heading" && node.name?.value === "REGION_HEADING");
    const outside = ax.nodes.find((node) => node.role?.value === "heading" && node.name?.value === "OUTSIDE_HEADING");
    expect(region?.childIds).toContain(outside?.nodeId);
    expect(region?.childIds).not.toContain(inside?.nodeId);
    expect(inside?.parentId).not.toBe(region?.nodeId);
    await cdp.detach();
    responses.push(
      commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#scope" } }, "owned-region"),
      (request) => {
        snapshot = lastTool(request);
        const button = snapshot.items?.find((item: any) => itemLine(item).includes('- button "Region action"'));
        return button?.ref ? commandResponse("click", { target: { ref: button.ref } }, "owned-click") : textResponse("OWNED_REGION_DONE");
      },
      (request) => { clicked = lastTool(request); return textResponse("OWNED_REGION_DONE"); },
      textResponse("Inspect owned region"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the region and activate its button");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OWNED_REGION_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const text = inspectText(snapshot.items);
    expect(text).toContain('heading "REGION_HEADING"');
    expect(text).toContain('button "Region action"');
    expect(text).not.toContain("OUTSIDE_HEADING");
    expect(text.indexOf('heading "REGION_HEADING"')).toBeLessThan(text.indexOf('button "Region action"'));
    expect(clicked).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
