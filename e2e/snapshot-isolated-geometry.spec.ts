import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

test("isolates resizing text in a clipped container from a separate stable button", async () => {
  test.setTimeout(100_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let observed: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1200, height: 800 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<style>body{font:16px monospace}#dynamic{display:inline-block; width:180px; height:24px; overflow:hidden; vertical-align:top}button{margin-left:100px}</style><main><span id="dynamic">short</span><button>Stable action</button></main>';
      const ballast = document.createElement("div"); ballast.hidden = true;
      ballast.innerHTML = "<span>unchanged</span>".repeat(2000); document.body.append(ballast);
      let n = 0;
      setInterval(() => { document.querySelector("#dynamic")!.textContent = ++n % 2 ? "short" : "a longer value"; }, 1);
    });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "geometry-isolation"),
      (request) => { observed = lastTool(request); return textResponse("ISOLATION_DONE"); }, textResponse("Isolated geometry"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the changing page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ISOLATION_DONE", { timeout: 80_000 });
    expect(observed).toMatchObject({ partial: true, items: expect.any(Array) });
    const items = observed.items;
    expect(items.find((item: any) => itemLine(item).includes('button "Stable action"'))?.id).toEqual(expect.any(String));
    expect(items.some((item: any) => itemLine(item).includes("short") || itemLine(item).includes("a longer value"))).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
