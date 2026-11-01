import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse, type MockResponse } from "./fixtures";
import { decodeSnapshotLines } from "../src/chrome/snapshot-line-dictionary";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  if (!message) throw new Error("Missing tool result");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  const output = JSON.parse(content);
  for (const page of [output, output?.pageSnapshot]) if (page?.lineDictionary) page.items = decodeSnapshotLines(page);
  return output;
}

const roleRows = (snapshot: any, role: string) => snapshot.items.filter((item: any) =>
  typeof item.line === "string" && new RegExp(`^\\s*- ${role}(?:\\s|$)`).test(item.line));

test("closed single select exposes the painted label and actionable ref, not its value or unopened options", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, axRead: any, domRead: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>select{display:block;margin:8px 0;font:16px monospace;width:320px;border-radius:0}option{font:16px monospace}</style>
        <select id="normal"><option label="PAINTED_AX_LABEL" value="INTERNAL_AX_ID" selected>UNPAINTED_AX_TEXT</option><option value="OTHER">CLOSED_MENU_SECRET</option></select>
        <select id="dom" aria-hidden="true"><option label="PAINTED_DOM_LABEL" value="INTERNAL_DOM_ID" selected>UNPAINTED_DOM_TEXT</option></select>`;
    });
    for (const [id, original, changed] of [["normal", "PAINTED_AX_LABEL", "PAINTED_AX_LABEX"], ["dom", "PAINTED_DOM_LABEL", "PAINTED_DOM_LABEX"]] as const) {
      const host = target.locator(`#${id}`), option = host.locator("option").first(), before = await host.screenshot();
      await option.evaluate((element: HTMLOptionElement, label) => { element.label = label; }, changed);
      expect((await host.screenshot()).equals(before), `${id}: the selected label must actually affect pixels`).toBe(false);
      await option.evaluate((element: HTMLOptionElement, label) => { element.label = label; }, original);
    }
    const closed = target.locator("#normal"), hiddenOption = closed.locator("option").nth(1), before = await closed.screenshot();
    await hiddenOption.evaluate((element) => { element.textContent = "DIFFERENT_UNOPENED_SECRET"; });
    expect((await closed.screenshot()).equals(before), "an unopened option must not affect the closed control").toBe(true);
    await hiddenOption.evaluate((element) => { element.textContent = "CLOSED_MENU_SECRET"; });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "select-visible"), (request) => {
      snapshot = lastTool(request);
      const rows = roleRows(snapshot, "combobox");
      return rows[0]?.ref ? commandResponse("read_value", { target: { ref: rows[0].ref } }, "select-read-ax") : textResponse("SELECT_VISIBLE_DONE");
    }, (request) => {
      axRead = lastTool(request);
      const rows = roleRows(axRead.pageSnapshot ?? snapshot, "combobox");
      return rows[1]?.ref ? commandResponse("read_value", { target: { ref: rows[1].ref } }, "select-read-dom") : textResponse("SELECT_VISIBLE_DONE");
    }, (request) => { domRead = lastTool(request); return textResponse("SELECT_VISIBLE_DONE"); }, textResponse("Inspect the selects"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible selections");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SELECT_VISIBLE_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array), truncation: { baselineComplete: true } });
    const rows = roleRows(snapshot, "combobox");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ref: expect.any(String), line: expect.stringContaining("PAINTED_AX_LABEL") });
    expect(rows[1]).toMatchObject({ ref: expect.any(String), line: expect.stringContaining("PAINTED_DOM_LABEL") });
    const text = JSON.stringify(snapshot.items);
    for (const hidden of ["UNPAINTED_AX_TEXT", "UNPAINTED_DOM_TEXT", "CLOSED_MENU_SECRET", "INTERNAL_AX_ID", "INTERNAL_DOM_ID", "MenuListPopup"]) expect(text).not.toContain(hidden);
    expect(roleRows(snapshot, "option")).toHaveLength(0);
    expect(axRead).toMatchObject({ ok: true, result: "INTERNAL_AX_ID" });
    expect(domRead).toMatchObject({ ok: true, result: "INTERNAL_DOM_ID" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("closed select does not expose zero-size or clipped labels in AX or DOM supplement", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>select{display:block;margin:8px 0;font:16px monospace;border-radius:0}option{font:16px monospace}</style>
        <select id="zero" style="font-size:0;width:220px;height:25px"><option selected>ZERO_HIDDEN_ABC</option></select>
        <select id="narrow" style="width:36px"><option selected>PREFIX_HIDDEN_ABC</option></select>
        <select id="dom" aria-hidden="true" style="font-size:0;width:220px;height:25px"><option selected>ARIA_HIDDEN_ABC</option></select>`;
    });
    for (const [id, original, changed] of [["zero", "ZERO_HIDDEN_ABC", "ZERO_HIDDEN_XYZ"], ["narrow", "PREFIX_HIDDEN_ABC", "PREFIX_HIDDEN_XYZ"], ["dom", "ARIA_HIDDEN_ABC", "ARIA_HIDDEN_XYZ"]] as const) {
      const host = target.locator(`#${id}`), option = host.locator("option").first(), before = await host.screenshot();
      await option.evaluate((element: HTMLOptionElement, value) => { element.textContent = value; }, changed);
      expect((await host.screenshot()).equals(before), `${id}: changed text must not affect painted pixels`).toBe(true);
      await option.evaluate((element: HTMLOptionElement, value) => { element.textContent = value; }, original);
    }
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "select-hidden"), (request) => { snapshot = lastTool(request); return textResponse("SELECT_HIDDEN_DONE"); }, textResponse("Inspect the selects"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible selections");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SELECT_HIDDEN_DONE", { timeout: 60_000 });
    const rows = roleRows(snapshot, "combobox");
    expect(rows).toHaveLength(3);
    expect(rows.every((item: any) => typeof item.ref === "string" && item.line.includes("[value=unknown]"))).toBe(true);
    const text = JSON.stringify(snapshot.items);
    for (const hidden of ["ZERO_HIDDEN_ABC", "PREFIX_HIDDEN_ABC", "ARIA_HIDDEN_ABC", "MenuListPopup"]) expect(text).not.toContain(hidden);
    expect(roleRows(snapshot, "option")).toHaveLength(0);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

