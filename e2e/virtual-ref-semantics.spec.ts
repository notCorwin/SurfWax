import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("does not retarget an issued ref after the same DOM node changes visible identity", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const list = document.createElement("section");
      list.innerHTML = '<button id="virtual-ax">Order A</button><button id="virtual-css" aria-label="Invoice A">Invoice</button>';
      for (const button of list.querySelectorAll("button")) button.addEventListener("click", () => {
        const name = button.getAttribute("aria-label") || button.textContent;
        document.body.dataset.received = `${document.body.dataset.received || ""}|${name}`;
      });
      document.body.append(list);
    });
    let axRef = "", cssRef = "";
    responses.push(
      commandResponse("inspect_page", {}, "inspect-a"),
      (request) => {
        axRef = lastTool(request).items.find((item: any) => item.line.includes('button "Order A"'))?.ref;
        expect(axRef).toEqual(expect.any(String));
        return commandResponse("execute_program", { code: `await page.evaluate(() => { document.querySelector('#virtual-ax').textContent = 'Order B'; });` }, "rewrite-ax");
      },
      () => commandResponse("click", { target: { ref: axRef } }, "old-ax"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-ref" } }); return commandResponse("inspect_page", {}, "inspect-b"); },
      (request) => {
        const next = lastTool(request).items.find((item: any) => item.line.includes('button "Order B"'))?.ref;
        expect(next).toEqual(expect.any(String)); expect(next).not.toBe(axRef); axRef = next;
        return commandResponse("click", { target: { ref: axRef } }, "new-ax");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("find_elements", { target: { by: "css", value: "#virtual-css" } }, "find-a"); },
      (request) => {
        cssRef = lastTool(request).elements[0].ref;
        return commandResponse("execute_program", { code: `await page.evaluate(() => { document.querySelector('#virtual-css').setAttribute('aria-label', 'Invoice B'); });` }, "rewrite-css");
      },
      () => commandResponse("click", { target: { ref: cssRef } }, "old-css"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-ref" } }); return commandResponse("find_elements", { target: { by: "css", value: "#virtual-css" } }, "find-b"); },
      (request) => {
        const next = lastTool(request).elements[0].ref;
        expect(next).not.toBe(cssRef); cssRef = next;
        return commandResponse("click", { target: { ref: cssRef } }, "new-css");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("VISIBLE_REF_IDENTITY_OK"); },
      textResponse("检查引用身份"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("observe identity changes before clicking");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("VISIBLE_REF_IDENTITY_OK", { timeout: 60000 });
    await expect(target.locator("body")).toHaveAttribute("data-received", "|Order B|Invoice B");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
