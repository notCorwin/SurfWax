import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents } from "./fixtures";

test("preserves accessible locator semantics across scopes, shadow roots, refs, and frames", async () => {
  test.setTimeout(150000);
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 90000, code: `
const scope = page.locator('.scope');
const snapshot = await page.inspect();
const row = snapshot.items.find(item => item.line.includes('article "Audit scope"'));
if (!row?.ref) throw new Error('Missing article reference');
const frame = page.frameLocator('#local');
return {
  rootSubstring: await page.getByRole('button', {name:'sav'}).count(),
  rootExact: await page.getByRole('button', {name:'Save', exact:true}).count(),
  rootEmpty: await page.getByRole('button', {name:'', exact:true}).count(),
  rootHiddenName: await page.getByRole('button', {name:'Save draft', exact:true}).count(),
  rootLabelSubstring: await page.getByLabel('billing').count(),
  frameExact: await frame.getByRole('button', {name:'Save', exact:true}).count(),
  frameHiddenName: await frame.getByRole('button', {name:'Save draft', exact:true}).count(),
  frameListbox: await frame.getByRole('listbox').count(),
  frameCombobox: await frame.getByRole('combobox').count(),
  chainedExact: await scope.getByRole('button', {name:'Save', exact:true}).count(),
  chainedListbox: await scope.getByRole('listbox').count(),
  refExact: await page.ref(row.ref).getByRole('button', {name:'Save', exact:true}).count(),
  filtered: await page.locator('article').filter({has:page.getByRole('listbox')}).count(),
  shadowExact: await page.locator('#host').getByRole('button', {name:'Shadow', exact:true}).count(),
  selfExcluded: await page.getByRole('button', {name:'Self', exact:true}).getByRole('button', {name:'Self', exact:true}).count(),
};` }, "accessibility-semantics"),
    textResponse("SEMANTICS_DONE"), textResponse("语义定位"),
  ]);
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
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SEMANTICS_DONE", { timeout: 120000 });
    const event = (await readEvents(opened.page)).find((entry) => entry.toolCallId === "accessibility-semantics" && ["tool.finished", "tool.failed"].includes(entry.type));
    expect(event?.output).toMatchObject({ ok: true, result: {
      rootSubstring: 1, rootExact: 1, rootEmpty: 1, rootHiddenName: 0, rootLabelSubstring: 1,
      frameExact: 1, frameHiddenName: 0, frameListbox: 1, frameCombobox: 0,
      chainedExact: 1, chainedListbox: 1, refExact: 1, filtered: 1, shadowExact: 1, selfExcluded: 0,
    } });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
