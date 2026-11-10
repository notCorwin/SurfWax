import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("shows native Arial placeholders while rejecting an author font using that name", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let before: any, custom: any, restored: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<style>input{display:block;width:350px;height:30px}</style><input aria-label="Destination" placeholder="NATIVE_ARIAL_HINT"><input style="font-family:Arial,sans-serif" aria-label="Fallback" placeholder="ARIAL_FALLBACK_HINT"><button>Toggle Arial face</button><div id="host"></div>';
      const host = document.querySelector("#host")!;
      host.attachShadow({ mode: "open" }).innerHTML = '<style>input{font:16px Arial;width:300px}</style><input aria-label="Shadow input" placeholder="SHADOW_ARIAL_UNPROVEN">';
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('@font-face{font-family:Arial;src:local("Arial")}');
      document.querySelector("button")!.addEventListener("click", () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.length ? [] : [sheet];
      });
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "arial-before"),
      (request) => {
        before = lastTool(request);
        const button = before.items?.find((item: any) => itemLine(item).includes('button "Toggle Arial face"'));
        if (!button?.id) return textResponse("ARIAL_TEST_DONE");
        responses.unshift(
          () => commandResponse("inspect_page", { budget: 12000 }, "arial-author-font"),
          (next) => { custom = lastTool(next); return commandResponse("click", { target: { id: button.id } }, "arial-restore"); },
          () => commandResponse("inspect_page", { budget: 12000 }, "arial-restored"),
          (next) => { restored = lastTool(next); return textResponse("ARIAL_TEST_DONE"); },
        );
        return commandResponse("click", { target: { id: button.id } }, "arial-author-enable");
      },
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the font changes");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARIAL_TEST_DONE", { timeout: 60_000 });
    for (const snapshot of [before, custom, restored]) expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(JSON.stringify(before.items)).toContain("NATIVE_ARIAL_HINT");
    expect(JSON.stringify(before.items)).toContain("ARIAL_FALLBACK_HINT");
    expect(JSON.stringify(custom.items)).not.toContain("NATIVE_ARIAL_HINT");
    expect(JSON.stringify(custom.items)).not.toContain("ARIAL_FALLBACK_HINT");
    expect(JSON.stringify(custom.items)).toContain("[placeholder=unknown]");
    expect(JSON.stringify(restored.items)).toContain("NATIVE_ARIAL_HINT");
    expect(JSON.stringify(restored.items)).toContain("ARIAL_FALLBACK_HINT");
    expect(JSON.stringify(before.items)).not.toContain("SHADOW_ARIAL_UNPROVEN");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("does not report a placeholder outside the visual viewport after pinch zoom", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 800, height: 600 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input style="position:absolute;left:480px;top:30px;width:280px;height:30px;font:16px monospace" aria-label="Zoomed input" placeholder="OUTSIDE_VISUAL_VIEWPORT">';
    });
    const cdp = await opened.context.newCDPSession(target);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    expect(await target.evaluate(() => visualViewport!.width)).toBe(400);
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "pinch-inspect"),
      (request) => { snapshot = lastTool(request); return textResponse("PINCH_TEST_DONE"); });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the zoomed page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PINCH_TEST_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(JSON.stringify(snapshot.items)).not.toContain("OUTSIDE_VISUAL_VIEWPORT");
    expect(itemLine(snapshot.items.find((item: any) => itemLine(item).includes("Zoomed input")))).toContain("[placeholder=unknown]");
    await cdp.detach();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
