import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("locates and clicks inside a sandboxed opaque-origin frame", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "sandbox";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = '<button id="action" onclick="document.body.dataset.clicked=\'yes\'">Sandbox action</button>';
      document.body.append(frame);
    });
    await expect(target.frameLocator("#sandbox").locator("#action")).toBeVisible();
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#action", frame: { by: "css", value: "#sandbox" } }, timeoutMs: 15000 }, "sandbox-click"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("SANDBOX_FRAME_OK"); },
      textResponse("沙盒框架"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click the sandboxed action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SANDBOX_FRAME_OK", { timeout: 30000 });
    await expect(target.frameLocator("#sandbox").locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
