import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("press_key reports edits blocked by the interaction guard", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<textarea id="editor">abc</textarea><input id="cancel" value="keep"><button id="submit">Submit</button><output id="clicks">0</output>';
      document.querySelector("#cancel")!.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key === "Backspace") event.preventDefault();
      });
      document.querySelector("#submit")!.addEventListener("click", () => { document.querySelector("#clicks")!.textContent = "1"; });
    });
    const css = (value: string) => ({ by: "css", value });
    const commands: Array<[string, object]> = [
      ["focus_element", { target: css("#editor") }], ["press_key", { key: "End" }],
      ["press_key", { key: "Backspace" }], ["press_key", { key: "Home" }],
      ["press_key", { key: "Delete" }], ["press_key", { key: "Enter" }], ["press_key", { key: "x" }],
      ["focus_element", { target: css("#cancel") }], ["press_key", { key: "Backspace" }],
      ["focus_element", { target: css("#submit") }], ["press_key", { key: "Enter" }],
    ];
    const results: any[] = [];
    responses.push(commandResponse(...commands[0], "key-0"), ...commands.slice(1).map(([name, args], index) => (request: any) => {
      results.push(lastTool(request));
      return commandResponse(name, args, `key-${index + 1}`);
    }), (request: any) => { results.push(lastTool(request)); return textResponse("KEY_BLOCKER_DONE"); }, textResponse("Keyboard"));
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Exercise keyboard input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("KEY_BLOCKER_DONE", { timeout: 60_000 });
    for (const index of [2, 4, 5]) expect(results[index]).toMatchObject({ ok: false, error: { code: "guard-blocked-input", effectUnknown: true } });
    for (const index of [0, 1, 3, 6, 7, 8, 9, 10]) expect(results[index]).toMatchObject({ ok: true });
    await expect(target.locator("#editor")).toHaveValue("xabc");
    await expect(target.locator("#cancel")).toHaveValue("keep");
    await expect(target.locator("#clicks")).toHaveText("1");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
