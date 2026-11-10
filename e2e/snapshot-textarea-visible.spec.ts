import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  const output = JSON.parse(content);
  return output;
}

test("snapshot preserves proven multiline textarea values and marks unpainted values unknown", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, axRead: any, domRead: any, visibleRegion: any, visibleRegionRead: any, clippedRegion: any, clippedRegionRead: any;
  let earlyFailure: { stage: string; result: unknown } | undefined;
  const stopWithEvidence = (stage: string, result: unknown) => {
    earlyFailure = { stage, result };
    // The conversation is about to finish; leave only a title response so
    // an automatic title request cannot consume a tool-result callback.
    responses.splice(0, responses.length, textResponse("Textarea test"));
    return textResponse("TEXTAREA_DONE");
  };
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>textarea { display:block; margin:4px 0; font:16px monospace; border-radius:0; resize:none; }</style>
        <textarea id="ax-visible" style="width:320px;height:85px"></textarea>
        <textarea id="dom-visible" aria-hidden="true" style="width:320px;height:85px"></textarea>
        <textarea id="ax-clipped" style="width:320px;height:25px"></textarea>
        <textarea id="dom-clipped" aria-hidden="true" style="width:320px;height:25px"></textarea>
        <textarea id="narrow" style="width:30px;height:25px"></textarea>
        <textarea id="trailing" style="width:320px;height:85px"></textarea>`;
      const set = (id: string, value: string) => { (document.getElementById(id) as HTMLTextAreaElement).value = value; };
      set("ax-visible", "AX_FIRST\n\nAX_SECOND");
      set("dom-visible", "DOM_FIRST\n\nDOM_SECOND");
      set("ax-clipped", "AX_VISIBLE\nAX_SECOND\nAX_SECRET_ABC");
      set("dom-clipped", "DOM_VISIBLE\nDOM_SECOND\nDOM_SECRET_ABC");
      set("narrow", "NARROW_VISIBLE_HIDDEN_ABC");
      set("trailing", "TAIL_FIRST\nTAIL_SECOND\n");
    });
    for (const [id, replacement, original] of [
      ["ax-clipped", "AX_VISIBLE\nAX_SECOND\nAX_SECRET_XYZ", "AX_VISIBLE\nAX_SECOND\nAX_SECRET_ABC"],
      ["dom-clipped", "DOM_VISIBLE\nDOM_SECOND\nDOM_SECRET_XYZ", "DOM_VISIBLE\nDOM_SECOND\nDOM_SECRET_ABC"],
      ["narrow", "NARROW_VISIBLE_HIDDEN_XYZ", "NARROW_VISIBLE_HIDDEN_ABC"],
      ["trailing", "TAIL_FIRST\nTAIL_SECOND", "TAIL_FIRST\nTAIL_SECOND\n"],
    ] as const) {
      const textarea = target.locator(`#${id}`), before = await textarea.screenshot();
      await textarea.evaluate((element: HTMLTextAreaElement, value) => { element.value = value; }, replacement);
      expect((await textarea.screenshot()).equals(before), `${id}: the changed value must not change painted pixels`).toBe(true);
      await textarea.evaluate((element: HTMLTextAreaElement, value) => { element.value = value; }, original);
    }
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "textarea-visible"), (request) => {
      snapshot = lastTool(request);
      const rows = snapshot.items?.filter((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string") ?? [];
      return rows[2] ? commandResponse("read_value", { target: { ref: rows[2].ref } }, "textarea-read-ax") : stopWithEvidence("initial AX ref", snapshot);
    }, (request) => {
      axRead = lastTool(request);
      const rows = (axRead.pageSnapshot?.items ?? snapshot.items)?.filter((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string") ?? [];
      return rows[3] ? commandResponse("read_value", { target: { ref: rows[3].ref } }, "textarea-read-dom") : stopWithEvidence("initial DOM ref", axRead);
    }, (request) => {
      domRead = lastTool(request);
      return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#ax-visible" } }, "textarea-region-visible");
    }, (request) => {
      visibleRegion = lastTool(request);
      const row = visibleRegion.items?.find((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string");
      return row ? commandResponse("read_value", { target: { ref: row.ref } }, "textarea-region-visible-read") : stopWithEvidence("visible region ref", visibleRegion);
    }, (request) => {
      visibleRegionRead = lastTool(request);
      return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#ax-clipped" } }, "textarea-region-clipped");
    }, (request) => {
      clippedRegion = lastTool(request);
      const row = clippedRegion.items?.find((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string");
      return row ? commandResponse("read_value", { target: { ref: row.ref } }, "textarea-region-clipped-read") : stopWithEvidence("clipped region ref", clippedRegion);
    }, (request) => { clippedRegionRead = lastTool(request); return textResponse("TEXTAREA_DONE"); }, textResponse("Inspect the textareas"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible textarea values");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("TEXTAREA_DONE", { timeout: 60_000 });
    expect(earlyFailure).toBeUndefined();
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    const rows = snapshot.items.filter((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string");
    expect(rows).toHaveLength(6);
    for (const [index, expected] of [[0, "AX_FIRST\n\nAX_SECOND"], [1, "DOM_FIRST\n\nDOM_SECOND"]] as const) {
      const line = itemLine(rows[index]), valueOffset = line.indexOf(": ");
      expect(valueOffset).toBeGreaterThan(-1);
      expect(line).not.toContain("\n");
      expect(JSON.parse(line.slice(valueOffset + 2))).toBe(expected);
      expect(line).not.toContain("[value=unknown]");
    }
    for (const row of rows.slice(2)) expect(itemLine(row)).toContain("[value=unknown]");
    const text = JSON.stringify(snapshot.items);
    expect(text).not.toContain("AX_SECRET_ABC");
    expect(text).not.toContain("DOM_SECRET_ABC");
    expect(text).not.toContain("NARROW_VISIBLE_HIDDEN_ABC");
    expect(text).not.toContain("TAIL_FIRST\\nTAIL_SECOND\\n");
    expect(axRead).toMatchObject({ ok: true, result: "AX_VISIBLE\nAX_SECOND\nAX_SECRET_ABC" });
    expect(domRead).toMatchObject({ ok: true, result: "DOM_VISIBLE\nDOM_SECOND\nDOM_SECRET_ABC" });
    expect(visibleRegion).toMatchObject({ mode: "full", items: expect.any(Array) });
    const visibleRegionRow = visibleRegion.items.find((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string");
    expect(visibleRegionRow).toBeTruthy();
    const visibleRegionValueOffset = itemLine(visibleRegionRow).indexOf(": ");
    expect(visibleRegionValueOffset).toBeGreaterThan(-1);
    expect(JSON.parse(itemLine(visibleRegionRow).slice(visibleRegionValueOffset + 2))).toBe("AX_FIRST\n\nAX_SECOND");
    expect(JSON.stringify(visibleRegion.items)).not.toMatch(/StaticText|LineBreak/);
    expect(visibleRegionRead).toMatchObject({ ok: true, result: "AX_FIRST\n\nAX_SECOND" });
    expect(clippedRegion).toMatchObject({ mode: "full", items: expect.any(Array) });
    const clippedRegionRow = clippedRegion.items.find((item: any) => itemLine(item).includes("textbox") && typeof item.ref === "string");
    expect(itemLine(clippedRegionRow)).toContain("[value=unknown]");
    expect(JSON.stringify(clippedRegion.items)).not.toContain("AX_SECRET_ABC");
    expect(clippedRegionRead).toMatchObject({ ok: true, result: "AX_VISIBLE\nAX_SECOND\nAX_SECRET_ABC" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
