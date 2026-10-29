import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("inspects a region in a cross-process frame without including other page content", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const cross = target.frames().find((frame) => frame.url().includes("localhost"));
    expect(cross).toBeDefined();
    await cross!.evaluate(() => {
      const region = document.createElement("section"); region.id = "region-target";
      region.innerHTML = '<button>Scoped frame marker</button>';
      document.body.append(region);
      const other = document.createElement("button"); other.textContent = "Other frame marker"; document.body.append(other);
    });
    await target.evaluate(() => { const other = document.createElement("button"); other.textContent = "Root marker"; document.body.append(other); });
    responses.push(
      commandResponse("list_frames", {}, "scope-list-frames"),
      (request) => {
        const frame = lastTool(request).frames.find((item: any) => item.url.includes("localhost"));
        expect(frame?.frameRef).toEqual(expect.any(String));
        return commandResponse("inspect_page", { region: { by: "css", value: "#region-target", frame: { ref: frame.frameRef } } }, "scope-inspect");
      },
      (request) => {
        const output = lastTool(request);
        const lines = output.items.map((item: any) => item.line).join("\n");
        expect(lines).toContain("Scoped frame marker");
        expect(lines).not.toContain("Other frame marker");
        expect(lines).not.toContain("Root marker");
        return textResponse("SCOPED_FRAME_OK");
      },
      textResponse("检查框架区域"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect the region in the cross-origin frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCOPED_FRAME_OK", { timeout: 30000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
