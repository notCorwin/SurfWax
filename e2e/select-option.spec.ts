import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("validates all select options before changing state or firing events", async () => {
  test.setTimeout(180_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const container = document.createElement("div");
      container.innerHTML = `<select id="multi" multiple>
        <option value="old" selected>Old</option><option value="one">First</option>
        <option value="two">Second</option><option value="disabled" disabled>Disabled</option>
        <optgroup disabled><option value="group-disabled">Group disabled</option></optgroup>
        <option value="ambiguous-a">Duplicate</option><option value="ambiguous-b">Duplicate</option>
      </select><select id="single"><option value="old" selected>Old</option><option value="one">First</option><option value="two">Second</option></select>`;
      container.id = "select-fixture"; container.dataset.eventCount = "0";
      document.body.append(container);
      const events: string[] = [];
      for (const select of container.querySelectorAll("select")) for (const type of ["input", "change"]) select.addEventListener(type, () => {
        events.push(`${select.id}:${type}:${[...select.selectedOptions].map((option) => option.value).join(",")}`);
        container.dataset.eventCount = String(events.length);
      });
      container.querySelector<HTMLSelectElement>("#single")!.addEventListener("change", (event) => {
        (event.currentTarget as HTMLSelectElement).value = "old";
      });
      (window as any).selectEvents = events;
    });
    const select = (id: string, value: string | string[], callId: string) => commandResponse("select_option", { target: { by: "css", value: `#${id}` }, value }, callId);
    const failed = (request: any) => expect(lastTool(request)).toMatchObject({ ok: false });
    // Read all selected options, the single value and event count through
    // separate purpose-specific tools before continuing to the next case.
    const verifyThen = (callId: string, next: MockResponse) => {
      responses.push((request) => {
        failed(request);
        return commandResponse("read_elements", { target: { by: "css", value: "#multi option:checked" }, attributes: ["value"] }, `${callId}-selected`);
      }, (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { total: 1, items: [{ attributes: { value: "old" } }] } });
        return commandResponse("read_value", { target: { by: "css", value: "#single" } }, `${callId}-single`);
      }, (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "old" });
        return commandResponse("read_attribute", { target: { by: "css", value: "#select-fixture" }, name: "data-event-count" }, `${callId}-events`);
      }, (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "0" });
        return typeof next === "function" ? next(request) : next as ReturnType<typeof commandResponse>;
      });
    };
    responses.push(select("multi", ["one", "missing"], "missing"));
    verifyThen("after-missing", select("multi", ["one", "disabled"], "disabled"));
    verifyThen("after-disabled", select("multi", "group-disabled", "group-disabled"));
    verifyThen("after-group-disabled", select("multi", "Duplicate", "ambiguous"));
    verifyThen("after-ambiguous", select("single", ["one", "two"], "single-multiple"));
    verifyThen("after-single-multiple", select("multi", ["one", "Second"], "multi-valid"));
    responses.push(
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: ["one", "two"] } }); return select("multi", [], "multi-clear"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: [] } }); return select("single", "Second", "single-valid"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: ["old"] } }); return textResponse("SELECT_VALIDATION_OK"); },
      textResponse("选择选项"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("select options and report errors");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SELECT_VALIDATION_OK", { timeout: 165_000 });
    expect(await target.evaluate(() => (window as any).selectEvents)).toEqual([
      "multi:input:one,two", "multi:change:one,two", "multi:input:", "multi:change:", "single:input:two", "single:change:two",
    ]);
    await expect(target.locator("#single")).toHaveValue("old");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
