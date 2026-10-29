import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("validates all select options before changing state or firing events", async () => {
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
      document.body.append(container);
      const events: string[] = [];
      for (const select of container.querySelectorAll("select")) for (const type of ["input", "change"]) select.addEventListener(type, () => {
        events.push(`${select.id}:${type}:${[...select.selectedOptions].map((option) => option.value).join(",")}`);
      });
      container.querySelector<HTMLSelectElement>("#single")!.addEventListener("change", (event) => {
        (event.currentTarget as HTMLSelectElement).value = "old";
      });
      (window as any).selectEvents = events;
    });
    const select = (id: string, value: string | string[], callId: string) => commandResponse("select_option", { target: { by: "css", value: `#${id}` }, value }, callId);
    const failed = (request: any) => expect(lastTool(request)).toMatchObject({ ok: false });
    const verify = (callId: string) => commandResponse("execute_program", { code: `return await page.evaluate(() => ({ multi: [...document.querySelector('#multi').selectedOptions].map(option => option.value), single: document.querySelector('#single').value, events: window.selectEvents }));` }, callId);
    const unchanged = (request: any) => expect(lastTool(request)).toMatchObject({ ok: true, result: { multi: ["old"], single: "old", events: [] } });
    responses.push(
      select("multi", ["one", "missing"], "missing"),
      (request) => { failed(request); return verify("after-missing"); },
      (request) => { unchanged(request); return select("multi", ["one", "disabled"], "disabled"); },
      (request) => { failed(request); return verify("after-disabled"); },
      (request) => { unchanged(request); return select("multi", "group-disabled", "group-disabled"); },
      (request) => { failed(request); return verify("after-group-disabled"); },
      (request) => { unchanged(request); return select("multi", "Duplicate", "ambiguous"); },
      (request) => { failed(request); return verify("after-ambiguous"); },
      (request) => { unchanged(request); return select("single", ["one", "two"], "single-multiple"); },
      (request) => { failed(request); return verify("after-single-multiple"); },
      (request) => { unchanged(request); return select("multi", ["one", "Second"], "multi-valid"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: ["one", "two"] } }); return select("multi", [], "multi-clear"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: [] } }); return select("single", "Second", "single-valid"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { selected: ["old"] } }); return textResponse("SELECT_VALIDATION_OK"); },
      textResponse("选择选项"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("select options and report errors");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SELECT_VALIDATION_OK", { timeout: 45_000 });
    expect(await target.evaluate(() => (window as any).selectEvents)).toEqual([
      "multi:input:one,two", "multi:change:one,two", "multi:input:", "multi:change:", "single:input:two", "single:change:two",
    ]);
    await expect(target.locator("#single")).toHaveValue("old");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
