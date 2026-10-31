import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("raw CDP mouse input preserves supplied button and modifier bits", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/target`);
    await page.evaluate(() => {
      document.body.style.cssText = "margin:0;width:100vw;height:100vh";
      (window as any).moves = [];
      document.addEventListener("mousemove", (event) => (window as any).moves.push({ buttons: event.buttons, shiftKey: event.shiftKey, clientX: event.clientX, clientY: event.clientY }));
    });
    let tabId = 0;
    responses.push(
      commandResponse("execute_program", { code: "return page.tabId;" }, "get-tab"),
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ ok: true });
        tabId = result.result;
        return commandResponse("send_cdp", { tabId, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 40, y: 50, buttons: 1, modifiers: 8 } }, "raw-move");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true });
        return commandResponse("send_cdp", { tabId, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 40, y: 50, surfWaxAtomicClick: true } }, "invalid-internal");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "invalid-protocol-parameter" } }); return textResponse("RAW_CDP_DONE"); },
      textResponse("Raw CDP"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Send raw mouse input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RAW_CDP_DONE", { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).moves)).toContainEqual({ buttons: 1, shiftKey: true, clientX: 40, clientY: 50 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("raw CDP keyboard input preserves explicit text and modifiers while a key is held", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/target`);
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="field">';
      (window as any).keys = [];
      const input = document.querySelector<HTMLInputElement>("#field")!;
      for (const type of ["keydown", "keyup"]) input.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        (window as any).keys.push({ type, key: key.key, code: key.code, shiftKey: key.shiftKey });
      });
    });
    let tabId = 0;
    const expectSuccess = (request: any) => expect(lastTool(request)).toMatchObject({ ok: true });
    responses.push(
      commandResponse("execute_program", { code: "return page.tabId;" }, "keyboard-tab"),
      (request) => {
        const result = lastTool(request); expect(result).toMatchObject({ ok: true }); tabId = result.result;
        return commandResponse("focus_element", { target: { by: "css", value: "#field" } }, "keyboard-focus");
      },
      (request) => { expectSuccess(request); return commandResponse("key_down", { key: "Shift" }, "hold-shift"); },
      (request) => {
        expectSuccess(request);
        return commandResponse("send_cdp", { tabId, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 0, windowsVirtualKeyCode: 65 } }, "raw-a-down");
      },
      (request) => {
        expectSuccess(request);
        return commandResponse("send_cdp", { tabId, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA", modifiers: 0, windowsVirtualKeyCode: 65 } }, "raw-a-up");
      },
      (request) => { expectSuccess(request); return commandResponse("key_up", { key: "Shift" }, "release-shift"); },
      (request) => { expectSuccess(request); return commandResponse("press_key", { key: "b" }, "after-shift"); },
      (request) => { expectSuccess(request); return textResponse("RAW_KEYBOARD_DONE"); },
      textResponse("Raw keyboard"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Send raw keyboard input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RAW_KEYBOARD_DONE", { timeout: 60_000 });
    await expect(page.locator("#field")).toHaveValue("ab");
    const events = await page.evaluate(() => (window as any).keys);
    expect(events).toContainEqual({ type: "keydown", key: "a", code: "KeyA", shiftKey: false });
    expect(events).toContainEqual({ type: "keyup", key: "Shift", code: "ShiftLeft", shiftKey: false });
    expect(events).toContainEqual({ type: "keydown", key: "b", code: "KeyB", shiftKey: false });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
