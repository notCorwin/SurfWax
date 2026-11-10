import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("preserves visible live native values and selected labels without exposing masked or internal values", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let initial: any, filled: any, selected: any, anonymousFilled: any, failure: unknown, textareaRef = "", selectRef = "", anonymousRef = "";
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main><h1>Form observation</h1><section aria-hidden="true">
        <label for="notes">Notes</label><textarea id="notes">OLD_DEFAULT</textarea>
        <label for="color">Color</label><select id="color"><option value="INTERNAL_RED">Red label</option><option value="INTERNAL_BLUE">Blue label</option></select>
        <label for="password">Password</label><input id="password" type="password" value="SECRET_PASSWORD">
        <label for="masked">Masked</label><input id="masked" value="SECRET_MASK" style="-webkit-text-security:disc">
        <input id="anonymous-password" type="password" value="SECRET_ANONYMOUS">
        <label for="empty">Empty</label><input id="empty" placeholder="Hint text">
        <label for="duplicate">Outer label</label><input id="duplicate" value="OUTER_VALUE"><div id="one"></div><div id="two"></div>
      </section><section>
        <label for="ax-password">AX password</label><input id="ax-password" type="password" value="SECRET_AX_PASSWORD">
        <label for="ax-mask">AX masked</label><input id="ax-mask" value="SECRET_AX_MASK" style="-webkit-text-security:disc">
        <label for="ax-area">AX area</label><textarea id="ax-area" style="-webkit-text-security:disc">SECRET_AX_AREA</textarea>
      </section></main>`;
      (document.querySelector("#notes") as HTMLTextAreaElement).value = "LIVE_NOTES";
      (document.querySelector("#color") as HTMLSelectElement).value = "INTERNAL_BLUE";
      for (const [id, label, value] of [["one", "Inner one", "INNER_ONE"], ["two", "Inner two", "INNER_TWO"]]) {
        document.querySelector(`#${id}`)!.attachShadow({ mode: "open" }).innerHTML = `<label for="duplicate">${label}</label><input id="duplicate" value="${value}">`;
      }
    });
    const done = () => textResponse("FORM_PROBE_DONE");
    responses.push(commandResponse("inspect_page", { budget: 16000 }, "form-inspect"), (request) => {
      try {
        initial = lastTool(request);
        textareaRef = initial.items?.find((item: any) => itemLine(item).includes('textbox "Notes"') && itemLine(item).includes("LIVE_NOTES"))?.ref ?? "";
        selectRef = initial.items?.find((item: any) => itemLine(item).includes('combobox "Color"') && itemLine(item).includes('selected="Blue label"'))?.ref ?? "";
        anonymousRef = initial.items?.find((item: any) => /^\s*- textbox(?:\s|$)/.test(itemLine(item)) && itemLine(item).includes("masked=true") && !itemLine(item).includes('textbox "'))?.ref ?? "";
        if (!textareaRef || !selectRef || !anonymousRef) return done();
        return commandResponse("fill", { target: { ref: textareaRef }, value: "CHANGED_NOTES" }, "form-fill");
      } catch (error) { failure = error; return done(); }
    }, (request) => {
      try { filled = lastTool(request); return commandResponse("select_option", { target: { ref: selectRef }, value: "Red label" }, "form-select"); }
      catch (error) { failure = error; return done(); }
    }, (request) => {
      try { selected = lastTool(request); return commandResponse("fill", { target: { ref: anonymousRef }, value: "SECRET_ANONYMOUS_CHANGED" }, "form-anonymous-fill"); }
      catch (error) { failure = error; return done(); }
    }, (request) => { try { anonymousFilled = lastTool(request); } catch (error) { failure = error; } return done(); }, textResponse("Inspect the form"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the form and update the notes and color");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FORM_PROBE_DONE", { timeout: 45_000 });
    if (failure) throw failure;
    expect(initial).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const contents = JSON.stringify(initial.items);
    expect(contents).toContain("LIVE_NOTES");
    expect(contents).toContain('selected=\\\"Blue label\\\"');
    for (const hidden of ["OLD_DEFAULT", "INTERNAL_BLUE", "INTERNAL_RED", "SECRET_PASSWORD", "SECRET_MASK", "SECRET_ANONYMOUS", "SECRET_AX_PASSWORD", "SECRET_AX_MASK", "SECRET_AX_AREA"]) expect(contents).not.toContain(hidden);
    const lines = (initial.items).map(itemLine);
    for (const [label, value] of [["Outer label", "OUTER_VALUE"], ["Inner one", "INNER_ONE"], ["Inner two", "INNER_TWO"]]) {
      const row = initial.items.find((item: any) => itemLine(item).includes(`textbox "${label}"`) && itemLine(item).includes(value));
      expect.soft(row?.ref, JSON.stringify(lines)).toEqual(expect.any(String));
    }
    expect(lines.some((line: string) => line.includes('textbox "Password"') && line.includes("masked=true"))).toBe(true);
    expect(lines.some((line: string) => line.includes('textbox "Masked"') && line.includes("masked=true"))).toBe(true);
    for (const label of ["AX password", "AX masked", "AX area"]) expect(lines.some((line: string) => line.includes(`textbox "${label}"`) && line.includes("masked=true"))).toBe(true);
    expect(textareaRef).toEqual(expect.any(String)); expect(selectRef).toEqual(expect.any(String)); expect(anonymousRef).toEqual(expect.any(String));
    expect(filled).toMatchObject({ ok: true }); expect(selected).toMatchObject({ ok: true }); expect(anonymousFilled).toMatchObject({ ok: true });
    expect(await target.locator("#anonymous-password").inputValue()).toBe("SECRET_ANONYMOUS_CHANGED");
    expect(JSON.stringify(anonymousFilled.pageSnapshot)).not.toContain("SECRET_ANONYMOUS_CHANGED");
    expect(await target.locator("#notes").inputValue()).toBe("CHANGED_NOTES");
    expect(await target.locator("#color").inputValue()).toBe("INTERNAL_RED");
    expect(JSON.stringify(selected.pageSnapshot)).toContain("Red label");
    expect(JSON.stringify(selected.pageSnapshot)).not.toContain("INTERNAL_RED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
