import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("text tools reject non-editable controls before focus or keyboard effects", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<input id="checkbox" type="checkbox"><input id="radio" type="radio">
        <input id="submit" type="submit" value="Send"><select id="select"><option value="one">One</option><option value="two">Two</option></select>
        <input id="readonly" value="locked" readonly><input id="text" value="before"><textarea id="textarea">before</textarea>
        <div id="editor" contenteditable="true">before</div>`;
      const events: string[] = [];
      (window as any).editEvents = events;
      for (const element of document.querySelectorAll("input,select,textarea,[contenteditable]")) {
        for (const kind of ["focus", "blur", "keydown", "keyup", "beforeinput", "input", "change", "click"])
          element.addEventListener(kind, () => events.push(`${element.id}:${kind}`));
      }
    });
    const actions: Array<{ tool: "fill" | "type_text"; id: string }> = [];
    for (const id of ["checkbox", "radio", "submit", "select", "readonly"]) {
      actions.push({ tool: "fill", id }, { tool: "type_text", id });
    }
    const command = (action: typeof actions[number], index: number) => commandResponse(action.tool, {
      target: { by: "css", value: `#${action.id}` }, timeoutMs: 900,
      ...(action.tool === "fill" ? { value: "hello" } : { text: "hello" }),
    }, `invalid-${index}`);
    responses.push(command(actions[0]!, 0));
    for (let index = 0; index < actions.length; index++) responses.push((request) => {
      expect(lastTool(request), `${actions[index]!.tool} on ${actions[index]!.id}`).toMatchObject({ ok: false });
      return actions[index + 1] ? command(actions[index + 1]!, index + 1)
        : commandResponse("execute_program", { code: "await page.locator('#select').waitFor({state:'editable'});", timeoutMs: 1200 }, "wait-select-editable");
    });
    responses.push((request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return textResponse("INVALID_CONTROLS_REJECTED"); }, textResponse("文本控件校验"));
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Reject non-editable controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INVALID_CONTROLS_REJECTED", { timeout: 60000 });
    const invalid = await target.evaluate(() => ({
      events: (window as any).editEvents,
      checkbox: document.querySelector<HTMLInputElement>("#checkbox")!.checked,
      radio: document.querySelector<HTMLInputElement>("#radio")!.checked,
      submit: document.querySelector<HTMLInputElement>("#submit")!.value,
      selected: document.querySelector<HTMLSelectElement>("#select")!.value,
      readonly: document.querySelector<HTMLInputElement>("#readonly")!.value,
    }));
    expect(invalid).toEqual({ events: [], checkbox: false, radio: false, submit: "Send", selected: "one", readonly: "locked" });

    responses.push(
      commandResponse("fill", { target: { by: "css", value: "#text" }, value: "alpha" }, "fill-text"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("type_text", { target: { by: "css", value: "#text" }, text: "!" }, "type-text"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("fill", { target: { by: "css", value: "#textarea" }, value: "beta" }, "fill-textarea"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("fill", { target: { by: "css", value: "#editor" }, value: "gamma" }, "fill-editor"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("type_text", { target: { by: "css", value: "#editor" }, text: "!" }, "type-editor"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("EDITABLE_CONTROLS_OK"); },
    );
    await opened.page.getByTestId("composer-input").fill("Edit text controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITABLE_CONTROLS_OK", { timeout: 60000 });
    await expect(target.locator("#text")).toHaveValue("alpha!");
    await expect(target.locator("#textarea")).toHaveValue("beta");
    await expect(target.locator("#editor")).toHaveText("gamma!");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("clears text fields and fills structured date controls without silently changing the value", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<input id="text" value="before"><textarea id="textarea">before</textarea><div id="editor" contenteditable="true">before</div>
        <input id="number" type="number" value="12"><input id="date" type="date" value="2024-01-02">
        <input id="time" type="time" value="12:30"><input id="datetime" type="datetime-local" value="2024-01-02T12:30">
        <input id="month" type="month" value="2024-01"><input id="week" type="week" value="2024-W01">
        <input id="invalid-date" type="date" value="2024-01-02">`;
      const events: Array<{ id: string; type: string; trusted: boolean }> = [];
      (window as any).dateEvents = events;
      for (const element of document.querySelectorAll("input,textarea,[contenteditable]")) for (const kind of ["focus", "keydown", "keyup", "beforeinput", "input", "change"])
        element.addEventListener(kind, (event) => events.push({ id: element.id, type: event.type, trusted: event.isTrusted }));
    });
    const actions = [
      { id: "text", value: "" }, { id: "textarea", value: "" }, { id: "editor", value: "" },
      { id: "number", value: "34" }, { id: "number", value: "" },
      { id: "date", value: "2025-05-06" }, { id: "time", value: "13:45" },
      { id: "datetime", value: "2025-05-06T13:45" }, { id: "month", value: "2025-05" }, { id: "week", value: "2025-W06" },
    ];
    const fill = (action: typeof actions[number], index: number) => commandResponse("fill", {
      target: { by: "css", value: `#${action.id}` }, value: action.value,
    }, `fill-${index}`);
    responses.push(fill(actions[0]!, 0));
    for (let index = 0; index < actions.length; index++) responses.push((request) => {
      expect(lastTool(request), `fill ${actions[index]!.id}`).toMatchObject({ ok: true });
      return actions[index + 1] ? fill(actions[index + 1]!, index + 1)
        : commandResponse("type_text", { target: { by: "css", value: "#number" }, text: "42" }, "type-number");
    });
    responses.push(
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("fill", { target: { by: "css", value: "#invalid-date" }, value: "2025-99-99" }, "fill-invalid-date"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return commandResponse("type_text", { target: { by: "css", value: "#invalid-date" }, text: "2025-05-06" }, "type-structured-date"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return textResponse("STRUCTURED_FIELDS_OK"); },
      textResponse("日期和清空"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Clear and fill the fields");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STRUCTURED_FIELDS_OK", { timeout: 60000 });
    for (const [id, expected] of [["text", ""], ["textarea", ""], ["number", "42"], ["date", "2025-05-06"], ["time", "13:45"],
      ["datetime", "2025-05-06T13:45"], ["month", "2025-05"], ["week", "2025-W06"], ["invalid-date", "2024-01-02"]])
      await expect(target.locator(`#${id}`)).toHaveValue(expected!);
    await expect(target.locator("#editor")).toHaveText("");
    const events = await target.evaluate(() => (window as any).dateEvents as Array<{ id: string; type: string; trusted: boolean }>);
    expect(events.filter((event) => event.id === "invalid-date")).toEqual([]);
    for (const id of ["date", "time", "datetime", "month", "week"]) {
      expect(events.filter((event) => event.id === id && event.type === "input")).toHaveLength(1);
      expect(events.filter((event) => event.id === id && event.type === "change")).toHaveLength(1);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("stops further typing when focus or input handlers change editability", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="change-on-focus" value="before"><input id="change-on-input">';
      const focus = document.querySelector<HTMLInputElement>("#change-on-focus")!;
      const input = document.querySelector<HTMLInputElement>("#change-on-input")!;
      const events: string[] = [];
      (window as any).dynamicEditEvents = events;
      for (const element of [focus, input]) for (const kind of ["keydown", "keyup", "input"])
        element.addEventListener(kind, (event) => events.push(`${element.id}:${kind}:${(event as KeyboardEvent).key ?? ""}`));
      focus.addEventListener("focus", () => { focus.readOnly = true; });
      input.addEventListener("input", () => { input.readOnly = true; }, { once: true });
    });
    responses.push(
      commandResponse("fill", { target: { by: "css", value: "#change-on-focus" }, value: "new" }, "focus-change"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { effectUnknown: true } }); return commandResponse("type_text", { target: { by: "css", value: "#change-on-input" }, text: "abc" }, "input-change"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { effectUnknown: true } }); return textResponse("EDITABILITY_CHANGED_OK"); },
      textResponse("动态编辑状态"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Stop when a field changes editability");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITABILITY_CHANGED_OK", { timeout: 45000 });
    await expect(target.locator("#change-on-focus")).toHaveValue("before");
    await expect(target.locator("#change-on-input")).toHaveValue("a");
    const events = await target.evaluate(() => (window as any).dynamicEditEvents as string[]);
    expect(events.filter((event) => event.startsWith("change-on-focus:"))).toEqual([]);
    expect(events.filter((event) => event.startsWith("change-on-input:input:"))).toHaveLength(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("fills once through open and closed shadow roots and a nested frame", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<div id="open-host"></div><div id="closed-host"></div><iframe id="frame" srcdoc="<input id=inner value=before>"></iframe>';
      const openRoot = document.querySelector("#open-host")!.attachShadow({ mode: "open" });
      const closedRoot = document.querySelector("#closed-host")!.attachShadow({ mode: "closed" });
      openRoot.innerHTML = '<input id="open-input" aria-label="Open input" value="before">';
      closedRoot.innerHTML = '<input aria-label="Closed input" value="before">';
      const open = openRoot.querySelector("input")!;
      const closed = closedRoot.querySelector("input")!;
      (window as any).closedInput = closed;
      (window as any).shadowEdits = [];
      for (const [name, element] of [["open", open], ["closed", closed]] as const)
        element.addEventListener("input", (event) => (window as any).shadowEdits.push({ name, trusted: event.isTrusted, inputType: (event as InputEvent).inputType }));
    });
    const frame = target.locator("#frame").contentFrame().locator("#inner");
    await expect(frame).toBeVisible();
    await frame.evaluate((element) => element.addEventListener("input", (event) => {
      element.ownerDocument.body.dataset.inputs = String(Number(element.ownerDocument.body.dataset.inputs || 0) + 1);
      element.ownerDocument.body.dataset.trusted = String(event.isTrusted);
    }));
    let closedRef = "";
    responses.push(
      commandResponse("inspect_page", {}, "inspect-editors"),
      (request) => {
        const item = lastTool(request).items.find((entry: any) => entry.ref && entry.line.includes("Closed input"));
        expect(item?.ref).toEqual(expect.any(String));
        closedRef = item.ref;
        return commandResponse("fill", { target: { by: "css", value: "#open-input" }, value: "" }, "clear-open");
      },
      (request) => { expect(lastTool(request), JSON.stringify(lastTool(request))).toMatchObject({ ok: true }); return commandResponse("fill", { target: { ref: closedRef }, value: "" }, "clear-closed"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("fill", { target: { by: "css", value: "#inner", frame: { by: "css", value: "#frame" } }, value: "updated" }, "fill-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("DEEP_EDITORS_OK"); },
      textResponse("深层编辑控件"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Edit the fields in shadow roots and the frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DEEP_EDITORS_OK", { timeout: 60000 });
    await expect(target.locator("#open-input")).toHaveValue("");
    expect(await target.evaluate(() => ({
      closed: (window as any).closedInput.value,
      edits: (window as any).shadowEdits,
      active: document.activeElement?.id,
      frameActive: (document.querySelector("#frame") as HTMLIFrameElement).contentDocument?.activeElement?.id,
    }))).toMatchObject({ closed: "" });
    expect(await target.evaluate(() => (window as any).shadowEdits)).toEqual([
      { name: "open", trusted: true, inputType: "insertText" }, { name: "closed", trusted: true, inputType: "insertText" },
    ]);
    await expect(frame).toHaveValue("updated");
    expect(await frame.evaluate((element) => ({ inputs: element.ownerDocument.body.dataset.inputs, trusted: element.ownerDocument.body.dataset.trusted }))).toEqual({ inputs: "1", trusted: "true" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("targets an out-of-process frame across navigation without editing its sibling", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const crossURL = `${provider.origin.replace("127.0.0.1", "localhost")}/frame`;
    await target.evaluate((url) => {
      document.body.innerHTML = `<iframe id="other" srcdoc="<input id=inner value=other>"></iframe><iframe id="cross" src="${url}"></iframe>`;
    }, crossURL);
    const other = target.frameLocator("#other").locator("#inner");
    const cross = target.frameLocator("#cross").locator("body");
    await expect(cross).toContainText("frame ready");
    await cross.evaluate((body) => { body.innerHTML = '<input id="inner" value="before">'; });
    await other.focus();
    responses.push(
      commandResponse("fill", { target: { by: "css", value: "#inner", frame: { by: "css", value: "#cross" } }, value: "first" }, "fill-oopif"),
      (request) => { expect(lastTool(request), JSON.stringify(lastTool(request))).toMatchObject({ ok: true }); return commandResponse("execute_program", { code: `
await page.evaluate(async url => { const frame = document.querySelector('#cross'); await new Promise(resolve => { frame.onload = resolve; frame.src = url + '?after=1'; }); }, ${JSON.stringify(crossURL)});
await page.frameLocator('#cross').locator('body').evaluate(body => { body.innerHTML = '<input id="inner" value="after">'; });` }, "navigate-oopif"); },
      (request) => { expect(lastTool(request), JSON.stringify(lastTool(request))).toMatchObject({ ok: true }); return commandResponse("fill", { target: { by: "css", value: "#inner", frame: { by: "css", value: "#cross" } }, value: "second" }, "fill-new-oopif"); },
      (request) => { expect(lastTool(request), JSON.stringify(lastTool(request))).toMatchObject({ ok: true }); return textResponse("OOPIF_INPUT_OK"); },
      textResponse("跨进程框架输入"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Edit the frame before and after navigation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OOPIF_INPUT_OK", { timeout: 60000 });
    await expect(other).toHaveValue("other");
    await expect(target.frameLocator("#cross").locator("#inner")).toHaveValue("second");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
