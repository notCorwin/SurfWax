import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("reads paginated console history beyond the live cache", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  let baseline = 0;
  responses.push(
    commandResponse("read_console", { limit: 100 }, "console-start"),
    (request) => { const result = lastTool(request); expect(result).toMatchObject({ ok: true, result: { hasMore: false } }); baseline = result.result.messages.length; return commandResponse("click", { target: { by: "css", value: "#generate-console" }, timeoutMs: 90_000 }, "console-generate"); },
    () => commandResponse("read_console", { offset: baseline, limit: 2 }, "console-first"),
    (request) => {
      expect(lastTool(request)).toMatchObject({ ok: true, result: { integrity: "complete", hasMore: true, nextOffset: baseline + 2,
        messages: [{ text: "CONSOLE_MARKER_0" }, { text: "CONSOLE_MARKER_1" }] } });
      return commandResponse("read_console", { offset: baseline + 1000, limit: 2 }, "console-last");
    },
    (request) => {
      expect(lastTool(request)).toMatchObject({ ok: true, result: { integrity: "complete", hasMore: false,
        messages: [{ text: "CONSOLE_MARKER_1000" }, { text: "CONSOLE_MARKER_1001" }] } });
      return textResponse("CONSOLE_HISTORY_OK");
    },
  );
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`); await target.waitForLoadState("networkidle");
    await target.evaluate(() => {
      const button = document.createElement("button"); button.id = "generate-console"; button.textContent = "Generate console history";
      button.onclick = () => { for (let index = 0; index < 1002; index++) console.warn(`CONSOLE_MARKER_${index}`); };
      document.body.append(button);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("capture and paginate console messages");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CONSOLE_HISTORY_OK", { timeout: 100_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
