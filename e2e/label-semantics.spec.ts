import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents } from "./fixtures";

test("locates DOM labels across roles, hidden controls, shadow roots and frames", async () => {
  test.setTimeout(150_000);
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 90_000, code: `
const count = (value, options = {exact:true}) => page.getByLabel(value, options).count();
return {
  link: await count('Account'), generic: await count('Panel'),
  first: await count('First'), second: await count('Second'),
  reference: await count('Reference'), extra: await count('Extra'),
  combined: await count('Reference Extra'), overridden: await count('Overridden'),
  hidden: await count('Hidden Label'), empty: await count(''),
  title: await count('Hint'), content: await count('Content'),
  partial: await count('acc', {exact:false}),
  shadow: await count('Shadow label'),
  frame: await page.frameLocator('#frame').getByLabel('Frame label', {exact:true}).count(),
  scoped: await page.locator('section').getByLabel('Account', {exact:true}).count(),
  chained: await page.getByRole('region', {name:'Area'}).getByLabel('Account', {exact:true}).count(),
};` }, "label-semantics"),
    textResponse("LABELS_DONE"), textResponse("Labels"),
  ]);
  const opened = await openExtension();
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
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LABELS_DONE", { timeout: 120_000 });
    const event = (await readEvents(opened.page)).find((entry) => entry.toolCallId === "label-semantics" && ["tool.finished", "tool.failed"].includes(entry.type));
    expect(event?.output).toMatchObject({ ok: true, result: {
      link: 1, generic: 1, first: 1, second: 1, reference: 1, extra: 1, combined: 0,
      overridden: 0, hidden: 1, empty: 0, title: 0, content: 0, partial: 1,
      shadow: 1, frame: 1, scoped: 1, chained: 1,
    } });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
