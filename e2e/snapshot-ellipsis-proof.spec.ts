import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse } from "./fixtures";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  return JSON.parse(content);
}

test("exposes a proven painted ellipsis prefix and keeps its action reference", async () => {
  test.setTimeout(90_000);
  const responses: any[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, click: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<button id="queue" aria-label="UNPAINTED_ACCESSIBLE_NAME" style="display:block;width:110px;height:25px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:13.3333px Arial">Next TASK-746F9DB6E6FB</button>';
      document.querySelector("button")!.addEventListener("click", () => { document.body.dataset.clicked = "yes"; });
    });
    const button = target.locator("#queue"), before = await button.screenshot();
    await button.evaluate((element) => { element.textContent = "Next TASK-746F9DB6E6FC"; });
    expect((await button.screenshot()).equals(before)).toBe(true);
    await button.evaluate((element) => { element.textContent = "Next TASK-746F9DB6E6FB"; });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "ellipsis-proof"), (request: any) => {
      snapshot = lastTool(request);
      const item = snapshot.items?.find((entry: any) => entry.line.includes('- button "Next TASK-7…"'));
      return item?.ref ? commandResponse("click", { target: { ref: item.ref } }, "ellipsis-click") : textResponse("ELLIPSIS_DONE");
    }, (request: any) => { click = lastTool(request); return textResponse("ELLIPSIS_DONE"); }, textResponse("Inspect the queue"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and activate the visible Next button");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ELLIPSIS_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(JSON.stringify(snapshot.items)).not.toContain("UNPAINTED_ACCESSIBLE_NAME");
    expect(JSON.stringify(snapshot.items)).not.toContain("46F9DB6E6FB");
    expect(snapshot.items.some((entry: any) => entry.line.includes('- button "Next TASK-7…"') && typeof entry.ref === "string")).toBe(true);
    expect(click).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
