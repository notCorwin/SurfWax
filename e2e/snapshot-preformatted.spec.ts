import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { inspectText } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("preserves rendered preformatted whitespace in AX and DOM supplement text", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<pre id="ax"></pre><pre id="dom" aria-hidden="true"></pre><div id="normal"></div><div id="ax-line" style="white-space:pre-line"></div><div id="dom-line" aria-hidden="true" style="white-space:pre-line"></div>';
      document.querySelector("#ax")!.textContent = "AX_A    B\nC";
      document.querySelector("#dom")!.textContent = "DOM_A    B\nC";
      document.querySelector("#normal")!.textContent = "NORMAL_A    B\nC";
      document.querySelector("#ax-line")!.textContent = "AX_LINE A    B\nC\t\tD";
      document.querySelector("#dom-line")!.textContent = "DOM_LINE 甲    乙\n丙\t\t丁";
    });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "preformatted-inspect"),
      (request) => { snapshot = lastTool(request); return textResponse("PREFORMATTED_DONE"); });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the preformatted content");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PREFORMATTED_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    const lines = inspectText(snapshot.items);
    expect(lines).toContain('"AX_A    B\\nC"');
    expect(lines).toContain('"DOM_A    B\\nC"');
    expect(lines).toContain('"NORMAL_A B C"');
    expect(lines).toContain('"AX_LINE A B\\nC D"');
    expect(lines).toContain('"DOM_LINE 甲 乙\\n丙 丁"');
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
