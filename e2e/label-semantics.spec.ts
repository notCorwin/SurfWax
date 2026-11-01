import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

test("locates DOM labels across roles, hidden controls, shadow roots and frames", async () => {
  test.setTimeout(240_000);
  const cases = [
    { key: "link", value: "Account", expected: 1 }, { key: "generic", value: "Panel", expected: 1 },
    { key: "first", value: "First", expected: 1 }, { key: "second", value: "Second", expected: 1 },
    { key: "reference", value: "Reference", expected: 1 }, { key: "extra", value: "Extra", expected: 1 },
    { key: "combined", value: "Reference Extra", expected: 0 }, { key: "overridden", value: "Overridden", expected: 0 },
    { key: "hidden", value: "Hidden Label", expected: 1 }, { key: "empty", value: "", expected: 0 },
    { key: "title", value: "Hint", expected: 0 }, { key: "content", value: "Content", expected: 0 },
    { key: "empty-placeholder", by: "placeholder", value: "", expected: 0 },
    { key: "empty-alt", by: "alt", value: "", expected: 0 }, { key: "empty-title", by: "title", value: "", expected: 0 },
    { key: "partial", value: "acc", expected: 1, exact: false }, { key: "shadow", value: "Shadow label", expected: 1 },
    { key: "frame", value: "Frame label", expected: 1, frame: { by: "css", value: "#frame" } },
    { key: "scoped", value: "Account", expected: 1, scope: { by: "css", value: "section" } },
    { key: "chained", value: "Account", expected: 1, scope: { by: "role", value: "region", name: "Area" } },
  ];
  const responses: MockResponse[] = [];
  const next = (item: typeof cases[number]) => commandResponse("count_elements", { target: { by: "by" in item ? item.by : "label", value: item.value, exact: item.exact ?? true,
    ...("frame" in item ? { frame: item.frame } : {}), ...("scope" in item ? { scope: item.scope } : {}) } }, `label-${item.key}`);
  const resultOf = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
  responses.push(next(cases[0]!));
  for (let index = 1; index < cases.length; index++) responses.push((request) => {
    expect(resultOf(request), cases[index - 1]!.key).toMatchObject({ ok: true, result: cases[index - 1]!.expected });
    return next(cases[index]!);
  });
  responses.push((request) => {
    expect(resultOf(request), cases.at(-1)!.key).toMatchObject({ ok: true, result: cases.at(-1)!.expected });
    return textResponse("LABELS_DONE");
  }, textResponse("Labels"));
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<section aria-label="Area"><a href="#" aria-label="Account">User</a></section><div aria-label="Panel">Hello</div>
        <label for="x">First</label><label for="x">Second</label><input id="x">
        <span id="lab">Reference</span><span id="other">Extra</span><input aria-labelledby="lab other" aria-label="Overridden">
        <button title="Hint">Title text</button><button>Content</button><input aria-label="">
        <label for="h">Hidden Label</label><input id="h" style="display:none"><div id="host"></div><iframe id="frame"></iframe>`;
      document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = '<label for="s">Shadow label</label><input id="s">';
      document.querySelector<HTMLIFrameElement>("#frame")!.contentDocument!.body.innerHTML = '<a href="#" aria-label="Frame label">Go</a>';
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Find labels");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LABELS_DONE", { timeout: 210_000 });
    const events = await readEvents(opened.page);
    for (const item of cases) expect(events.find((entry) => entry.toolCallId === `label-${item.key}` && entry.type === "tool.finished")?.output)
      .toMatchObject({ ok: true, result: item.expected });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
