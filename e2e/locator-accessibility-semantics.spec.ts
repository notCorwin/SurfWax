import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

test("preserves accessible locator semantics across unique scopes, shadow roots, and frames", async () => {
  test.setTimeout(210_000);
  const cases = [
    { key: "rootSubstring", target: { by: "role", value: "button", name: "sav" }, expected: 1 },
    { key: "rootExact", target: { by: "role", value: "button", name: "Save", exact: true }, expected: 1 },
    { key: "rootEmpty", target: { by: "role", value: "button", name: "", exact: true }, expected: 1 },
    { key: "rootHiddenName", target: { by: "role", value: "button", name: "Save draft", exact: true }, expected: 0 },
    { key: "rootLabelSubstring", target: { by: "label", value: "billing" }, expected: 1 },
    { key: "frameExact", target: { by: "role", value: "button", name: "Save", exact: true, frame: { by: "css", value: "#local" } }, expected: 1 },
    { key: "frameHiddenName", target: { by: "role", value: "button", name: "Save draft", exact: true, frame: { by: "css", value: "#local" } }, expected: 0 },
    { key: "frameListbox", target: { by: "role", value: "listbox", frame: { by: "css", value: "#local" } }, expected: 1 },
    { key: "frameCombobox", target: { by: "role", value: "combobox", frame: { by: "css", value: "#local" } }, expected: 0 },
    { key: "shadowExact", target: { by: "role", value: "button", name: "Shadow", exact: true, scope: { by: "css", value: "#host" } }, expected: 1 },
    { key: "selfExcluded", target: { by: "role", value: "button", name: "Self", exact: true, scope: { by: "role", value: "button", name: "Self", exact: true } }, expected: 0 },
  ];
  const responses: MockResponse[] = [];
  const command = (item: typeof cases[number]) => commandResponse("count_elements", { target: item.target }, `semantics-${item.key}`);
  const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
  responses.push(command(cases[0]!));
  for (let index = 1; index < cases.length; index++) responses.push((request) => {
    expect(last(request), cases[index - 1]!.key).toMatchObject({ ok: true, result: cases[index - 1]!.expected });
    return command(cases[index]!);
  });
  responses.push((request) => {
    expect(last(request), cases.at(-1)!.key).toMatchObject({ ok: true, result: cases.at(-1)!.expected });
    return textResponse("SEMANTICS_DONE");
  }, textResponse("语义定位"));
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const controls = `<button>Save<span aria-hidden="true"> draft</span></button><select multiple><option>Alpha</option></select>`;
      document.body.innerHTML = `<article tabindex="0" aria-label="Audit scope"><section class="scope"><section class="scope">${controls}</section><button>Self</button><button aria-label=""></button><div id="host"></div><label>Billing Address<input></label></section></article><iframe id="local"></iframe>`;
      document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = '<button>Shadow<span aria-hidden="true"> wrong</span></button>';
      const frame = document.querySelector<HTMLIFrameElement>("#local")!;
      frame.contentDocument!.body.innerHTML = controls;
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SEMANTICS_DONE", { timeout: 180_000 });
    const events = await readEvents(opened.page);
    for (const item of cases) expect(events.find((entry) => entry.toolCallId === `semantics-${item.key}` && entry.type === "tool.finished")?.output)
      .toMatchObject({ ok: true, result: item.expected });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
