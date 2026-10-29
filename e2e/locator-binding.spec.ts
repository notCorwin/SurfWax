import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("keeps selected nodes bound when matching elements change during click, check and drag", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    await page.evaluate(() => {
      document.body.innerHTML = `<button id="click-a" class="chosen" style="position:absolute;left:20px;top:40px">A</button>
        <button id="click-b" style="position:absolute;left:120px;top:40px">B</button>
        <input id="check-a" class="check-target" type="checkbox" style="position:absolute;left:20px;top:100px">
        <input id="check-b" type="checkbox" style="position:absolute;left:120px;top:100px">
        <div id="source" style="position:absolute;left:20px;top:200px;width:60px;height:60px;background:blue"></div>
        <div id="drop-a" class="drop-target" style="position:absolute;left:200px;top:200px;width:60px;height:60px;background:red"></div>
        <div id="drop-b" style="position:absolute;left:400px;top:200px;width:60px;height:60px;background:green"></div>`;
      for (const id of ["click-a", "click-b"]) document.getElementById(id)!.addEventListener("click", () => { document.body.dataset.clicked = id; });
      const original = document.querySelectorAll.bind(document);
      let changed = false, checkSelected = false;
      document.querySelectorAll = ((selector: string) => {
        const result = original(selector);
        if (selector === ".chosen" && !changed) {
          changed = true; document.getElementById("click-a")!.classList.remove("chosen"); document.getElementById("click-b")!.classList.add("chosen");
        }
        if (selector === ".check-target") checkSelected = true;
        return result;
      }) as typeof document.querySelectorAll;
      const a = document.querySelector<HTMLInputElement>("#check-a")!;
      const checked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!;
      let swapped = false;
      Object.defineProperty(a, "checked", {
        get() { if (checkSelected && !swapped) { swapped = true; document.body.dataset.swappedAfter = document.body.dataset.clicked || "before-click"; a.classList.remove("check-target"); document.getElementById("check-b")!.classList.add("check-target"); } return checked.get!.call(a); },
        set(value) { checked.set!.call(a, value); },
      });
      document.getElementById("source")!.addEventListener("pointerdown", () => {
        document.getElementById("drop-a")!.classList.remove("drop-target"); document.getElementById("drop-b")!.classList.add("drop-target");
      });
      for (const id of ["drop-a", "drop-b"]) document.getElementById(id)!.addEventListener("pointerup", () => { document.body.dataset.dropped = id; });
    });
    const css = (value: string) => ({ by: "css", value });
    responses.push(
      commandResponse("click", { target: css(".chosen") }, "click-bound"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("set_checked", { target: css(".check-target"), checked: true }, "check-bound"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("drag", { source: css("#source"), destination: css(".drop-target") }, "drag-bound"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("BOUND_NODES_OK"); },
      textResponse("Bound actions"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Run the three actions");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BOUND_NODES_OK", { timeout: 60_000 });
    expect(await page.evaluate(() => ({ clicked: document.body.dataset.clicked, dropped: document.body.dataset.dropped, swappedAfter: document.body.dataset.swappedAfter,
      a: document.querySelector<HTMLInputElement>("#check-a")!.checked, b: document.querySelector<HTMLInputElement>("#check-b")!.checked })))
      .toEqual({ clicked: "click-a", dropped: "drop-a", swappedAfter: "click-a", a: true, b: false });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
