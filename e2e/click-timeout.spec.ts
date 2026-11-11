import { expect } from "@playwright/test";
import {
  commandResponse,
  configure,
  dispose,
  openExtension,
  startProvider,
  test,
  textResponse,
  type MockResponse,
} from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast(
    (entry: any) => entry.role === "tool",
  ).content;
  return JSON.parse(
    Array.isArray(content)
      ? content.find((part: any) => part.type === "text").text
      : content,
  );
};

test("a covered click returns promptly with the page and can be retried after dismissing the overlay", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML =
        '<button id="target">Open lesson</button><div id="overlay" style="position:fixed;inset:0;background:white"><button id="dismiss">Dismiss overlay</button></div>';
      document.querySelector("#target")!.addEventListener("click", () => {
        document.body.dataset.clicked = "yes";
      });
      document
        .querySelector("#dismiss")!
        .addEventListener("click", () =>
          document.querySelector("#overlay")!.remove(),
        );
    });
    let elapsed = 0;
    responses.push(
      () => {
        elapsed = Date.now();
        return commandResponse(
          "click",
          { target: { by: "css", value: "#target" } },
          "covered",
        );
      },
      (request) => {
        elapsed = Date.now() - elapsed;
        expect(elapsed).toBeLessThan(4_000);
        expect(lastTool(request)).toMatchObject({
          ok: false,
          error: { code: "intercepted" },
          timeoutMs: 5_000,
          timeoutSource: "default",
          pageSnapshot: expect.any(Object),
        });
        expect(JSON.stringify(lastTool(request).pageSnapshot)).toContain(
          "Dismiss overlay",
        );
        return commandResponse(
          "click",
          { target: { by: "css", value: "#dismiss" } },
          "dismiss",
        );
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true });
        return commandResponse(
          "click",
          { target: { by: "css", value: "#target" }, timeoutMs: 10_000 },
          "retry",
        );
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({
          ok: true,
          timeoutMs: 10_000,
          timeoutSource: "explicit",
        });
        return textResponse("CLICK_RECOVERED");
      },
      textResponse("点击恢复"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Open the lesson");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "CLICK_RECOVERED",
      { timeout: 30_000 },
    );
    await expect(target.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
