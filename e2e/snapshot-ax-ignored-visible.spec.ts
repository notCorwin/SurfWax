import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("captures rendered content omitted by the accessibility tree and can act on its native button", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let snapshot: any, click: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <h1>Visible content</h1>
        <section aria-hidden="true">
          <p>AX ignored visible text</p>
          <button id="ignored-button">AX ignored visible button</button>
          <p style="display:none">AX ignored display none text</p>
          <button style="opacity:0">AX ignored transparent button</button>
          <div style="width:0;height:0;overflow:hidden"><p>AX ignored clipped text</p></div>
        </section>
      </main>`;
      document.getElementById("ignored-button")!.addEventListener("click", () => { document.body.dataset.clicked = "yes"; });
    });
    await expect(target.locator("#ignored-button")).toBeVisible();
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "ignored-inspect"),
      (request) => {
        snapshot = lastTool(request);
        const button = snapshot.items?.find((item: any) => itemLine(item).includes('button "AX ignored visible button"'));
        if (typeof button?.id !== "string") return textResponse("AX_IGNORED_DONE");
        responses.unshift((nextRequest) => { click = lastTool(nextRequest); return textResponse("AX_IGNORED_DONE"); });
        return commandResponse("click", { target: { id: button.id } }, "ignored-click");
      },
      textResponse("Inspect the page"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and click the visible button");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("AX_IGNORED_DONE", { timeout: 45_000 });

    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const output = JSON.stringify(snapshot.items);
    expect(output).toContain("AX ignored visible text");
    expect(output).toContain("AX ignored visible button");
    for (const hidden of ["AX ignored display none text", "AX ignored transparent button", "AX ignored clipped text"]) {
      expect(output).not.toContain(hidden);
    }
    expect(click).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
