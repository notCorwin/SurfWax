import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  return JSON.parse(content);
}

test("native input snapshot distinguishes painted values from hidden and clipped text in AX and DOM paths", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, read: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>input { display:block; margin:8px 0; font:16px monospace; border-radius:0; }</style>
        <input id="visible" value="VISIBLE_NATIVE_VALUE" style="width:320px">
        <input id="zero" value="ZERO_SECRET_ABC" style="width:320px;height:28px;font-size:0">
        <input id="clipped" value="ABCD_CLIPPED_SECRET_ABC" style="width:25px">
        <input id="dom-visible" aria-hidden="true" value="DOM_VISIBLE_VALUE" style="width:320px">
        <input id="dom-clipped" aria-hidden="true" value="EFGH_DOM_SECRET_ABC" style="width:25px">`;
    });
    for (const [id, replacement, original] of [
      ["zero", "ZERO_SECRET_XYZ", "ZERO_SECRET_ABC"],
      ["clipped", "ABCD_CLIPPED_SECRET_XYZ", "ABCD_CLIPPED_SECRET_ABC"],
      ["dom-clipped", "EFGH_DOM_SECRET_XYZ", "EFGH_DOM_SECRET_ABC"],
    ] as const) {
      const input = target.locator(`#${id}`), before = await input.screenshot();
      await input.evaluate((element: HTMLInputElement, value) => { element.value = value; }, replacement);
      expect((await input.screenshot()).equals(before), `${id}: changed text must not affect painted pixels`).toBe(true);
      await input.evaluate((element: HTMLInputElement, value) => { element.value = value; }, original);
    }
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "native-visibility"), (request) => {
      snapshot = lastTool(request);
      const rows = snapshot.items?.filter((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string") ?? [];
      return rows[2] ? commandResponse("read_value", { target: { ref: rows[2].ref } }, "native-read-hidden-value") : textResponse("NATIVE_VISIBILITY_DONE");
    }, (request) => {
      read = lastTool(request); return textResponse("NATIVE_VISIBILITY_DONE");
    }, textResponse("Inspect the inputs"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible input values");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_VISIBILITY_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    const text = JSON.stringify(snapshot.items);
    expect(text).toContain("VISIBLE_NATIVE_VALUE");
    expect(text).toContain("DOM_VISIBLE_VALUE");
    expect(text).not.toContain("ZERO_SECRET_ABC");
    expect(text).not.toContain("CLIPPED_SECRET_ABC");
    expect(text).not.toContain("DOM_SECRET_ABC");
    expect(snapshot.items.filter((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string")).toHaveLength(5);
    expect(snapshot.items.filter((item: any) => itemLine(item).includes("[value=unknown]"))).toHaveLength(3);
    expect(read).toMatchObject({ ok: true, result: "ABCD_CLIPPED_SECRET_ABC" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("focused and horizontally scrolled input does not expose its hidden prefix", async () => {
  test.setTimeout(90_000);
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="scrolled" value="AAA_HIDDEN_PREFIX_TAIL_VISIBLE" style="display:block;width:70px;font:16px monospace;caret-color:transparent">';
    });
    const input = target.locator("#scrolled");
    await input.focus(); await input.press("End");
    const before = await input.screenshot();
    await input.evaluate((element: HTMLInputElement) => { element.value = "BBB_HIDDEN_PREFIX_TAIL_VISIBLE"; element.setSelectionRange(element.value.length, element.value.length); });
    expect((await input.screenshot()).equals(before), "changed prefix must not affect painted pixels while scrolled to the end").toBe(true);
    await input.evaluate((element: HTMLInputElement) => { element.value = "AAA_HIDDEN_PREFIX_TAIL_VISIBLE"; element.setSelectionRange(element.value.length, element.value.length); });
    responses.push({ response: commandResponse("inspect_page", { budget: 12000 }, "native-scrolled"), startAfter: gate }, (request) => {
      snapshot = lastTool(request); return textResponse("NATIVE_SCROLLED_DONE");
    }, textResponse("Inspect the input"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible input value");
    await opened.page.getByTestId("composer-input").press("Enter");
    await target.bringToFront();
    await input.focus(); await input.press("End");
    expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
    ready();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_SCROLLED_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(JSON.stringify(snapshot.items)).not.toContain("AAA_HIDDEN_PREFIX");
    expect(snapshot.items.some((item: any) => itemLine(item).includes("textbox") && itemLine(item).includes("[value=unknown]") && typeof item.ref === "string")).toBe(true);
  } finally { ready(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
