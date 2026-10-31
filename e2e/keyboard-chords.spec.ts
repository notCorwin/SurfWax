import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents } from "./fixtures";

test("sends chord modifiers in order and preserves already held keys", async () => {
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 30000, code: `
await page.locator('#target').focus();
await page.keyboard.press('+');
await page.keyboard.press('Control+a');
await page.keyboard.down('Control');
await page.keyboard.press('Control+a');
await page.keyboard.up('Control');
return 'done';` }, "chords"),
    textResponse("CHORDS_DONE"), textResponse("Keyboard"),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<button id="target">Target</button>';
      (window as any).keyEvents = [];
      for (const type of ["keydown", "keyup"]) document.querySelector("#target")!.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        (window as any).keyEvents.push([key.type, key.key, key.code, key.ctrlKey]);
      });
    });
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Exercise chords");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHORDS_DONE", { timeout: 60000 });
    const event = (await readEvents(opened.page)).find((item) => item.toolCallId === "chords" && ["tool.finished", "tool.failed"].includes(item.type));
    expect(event?.output).toMatchObject({ ok: true });
    expect(await target.evaluate(() => (window as any).keyEvents)).toEqual([
      ["keydown", "+", "Equal", false], ["keyup", "+", "Equal", false],
      ["keydown", "Control", "ControlLeft", true], ["keydown", "a", "KeyA", true], ["keyup", "a", "KeyA", true], ["keyup", "Control", "ControlLeft", false],
      ["keydown", "Control", "ControlLeft", true], ["keydown", "a", "KeyA", true], ["keyup", "a", "KeyA", true], ["keyup", "Control", "ControlLeft", false],
    ]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("does not send a chord's main key after the target loses focus", async () => {
  const responses: any[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="first"><input id="other">';
      (window as any).keyEvents = [];
      document.addEventListener("keydown", (event) => { (window as any).keyEvents.push([event.target === document.querySelector("#first") ? "first" : "other", event.key, event.ctrlKey]); });
      document.querySelector("#first")!.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Control") (document.querySelector("#other") as HTMLElement).focus(); });
    });
    let failure: any;
    responses.push(commandResponse("press_key", { target: { by: "css", value: "#first" }, key: "Control+a" }, "focus-chord"), (request: any) => {
      const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
      failure = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
      return commandResponse("press_key", { key: "+" }, "after-focus-chord");
    }, textResponse("FOCUS_CHORD_DONE"), textResponse("Keyboard"));
    await target.bringToFront(); await opened.page.getByTestId("composer-input").fill("Check chord focus"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_CHORD_DONE", { timeout: 60000 });
    expect(failure).toMatchObject({ ok: false, error: { code: "focus-lost", effectUnknown: true } });
    expect(await target.evaluate(() => (window as any).keyEvents)).toEqual([["first", "Control", true], ["other", "+", false]]);
    await expect(target.locator("#other")).toHaveValue("+");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
