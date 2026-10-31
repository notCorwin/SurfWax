import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

test("presses keys in a cross-origin frame", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/complex`);
    const frame = page.frames().find((item) => item.url().includes("localhost"))!;
    await frame.evaluate(() => {
      document.body.innerHTML = '<input id="frame-input">';
      const input = document.querySelector<HTMLInputElement>("#frame-input")!;
      (window as any).keyTrace = [];
      let selects = 0;
      input.addEventListener("keydown", (event) => {
        if (event.key === "a" && (event.metaKey || event.ctrlKey) && ++selects === 2) event.preventDefault();
      });
      for (const type of ["focus", "keydown", "keyup", "beforeinput", "input"]) input.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        (window as any).keyTrace.push({type, key: key.key, ctrl: key.ctrlKey, meta: key.metaKey, start: input.selectionStart, end: input.selectionEnd, value: input.value});
      });
    });
    const target = { by: "css", value: "#frame-input", frame: { by: "css", value: 'iframe[src*="localhost"]' } };
    const expectSuccess = (request: any) => {
      const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
      const output = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
      expect(output).toMatchObject({ ok: true });
    };
    responses.push(
      commandResponse("press_key", { target, key: "+" }, "frame-plus"),
      (request) => { expectSuccess(request); return commandResponse("press_key", { target, key: "ControlOrMeta+a" }, "frame-select"); },
      (request) => { expectSuccess(request); return commandResponse("press_key", { target, key: "x" }, "frame-replace"); },
      (request) => { expectSuccess(request); return commandResponse("press_key", { target, key: "ControlOrMeta+a" }, "frame-cancelled-select"); },
      (request) => { expectSuccess(request); return commandResponse("press_key", { target, key: "z" }, "frame-append"); },
      (request) => { expectSuccess(request); return textResponse("FRAME_KEYS_DONE"); },
      textResponse("Frame keys"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Exercise frame keyboard input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_KEYS_DONE", { timeout: 90_000 });
    const events = await frame.evaluate(() => (window as any).keyTrace);
    expect(events).toContainEqual(expect.objectContaining({ type: "keyup", key: "a", start: 0, end: 1, value: "+" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "keyup", key: "a", start: 1, end: 1, value: "x" }));
    await expect(frame.locator("#frame-input")).toHaveValue("xz");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
