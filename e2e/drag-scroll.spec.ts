import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const source = { by: "css", value: "#drag-source" };
const destination = { by: "css", value: "#drag-target" };

test("drags from the original source to an offscreen target with the button held", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    await page.evaluate(() => {
      document.body.innerHTML = `<div id="drag-source" style="position:absolute;top:100px;left:100px;width:80px;height:80px;background:blue"></div><div id="drag-target" style="position:absolute;top:2400px;left:100px;width:80px;height:80px;background:red"></div>`;
      const source = document.querySelector<HTMLElement>("#drag-source")!;
      source.onpointerdown = (event) => { document.body.dataset.start = event.target === source ? "source" : "wrong"; source.setPointerCapture(event.pointerId); };
      source.onpointermove = (event) => { if (event.buttons & 1) document.body.dataset.held = "yes"; };
      source.onpointerup = (event) => { document.body.dataset.end = document.elementFromPoint(event.clientX, event.clientY)?.id; document.body.dataset.buttons = String(event.buttons); };
    });
    responses.push(commandResponse("drag", { source, destination }, "scrolling-drag"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("DRAG_SCROLL_OK"); }, textResponse("拖放"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("drag the source to the target");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DRAG_SCROLL_OK", { timeout: 45_000 });
    expect(await page.locator("body").evaluate((body) => ({ ...body.dataset }))).toMatchObject({ start: "source", held: "yes", end: "drag-target", buttons: "0" });
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(1000);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("releases the pointer after a drag is interrupted after pressing", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    await page.evaluate(() => {
      document.body.innerHTML = `<div id="drag-source" style="position:absolute;top:100px;left:100px;width:80px;height:80px;background:blue"></div><div id="drag-target" style="position:absolute;top:2400px;left:100px;width:80px;height:80px;background:red"></div>`;
      const source = document.querySelector<HTMLElement>("#drag-source")!;
      source.onpointerdown = () => { document.body.dataset.pressed = "yes"; document.querySelector("#drag-target")?.remove(); };
      document.addEventListener("pointermove", (event) => { document.body.dataset.lastButtons = String(event.buttons); });
    });
    responses.push(commandResponse("drag", { source, destination, timeoutMs: 1800 }, "interrupted-drag"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return textResponse("DRAG_INTERRUPTED_OK"); }, textResponse("取消拖放"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("drag the source to the disappearing target");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DRAG_INTERRUPTED_OK", { timeout: 45_000 });
    await page.mouse.move(200, 200);
    expect(await page.locator("body").evaluate((body) => ({ ...body.dataset }))).toMatchObject({ pressed: "yes", lastButtons: "0" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("dispatches native HTML drag and drop events", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    await page.evaluate(() => {
      document.body.innerHTML = `<div id="drag-source" draggable="true" style="position:absolute;top:100px;left:100px;width:80px;height:80px">drag</div><div id="drag-target" style="position:absolute;top:300px;left:100px;width:80px;height:80px">drop</div>`;
      const source = document.querySelector<HTMLElement>("#drag-source")!;
      const target = document.querySelector<HTMLElement>("#drag-target")!;
      source.ondragstart = (event) => { document.body.dataset.dragstart = "yes"; event.dataTransfer!.setData("text/plain", "dragged"); };
      target.ondragover = (event) => event.preventDefault();
      target.ondrop = (event) => { event.preventDefault(); document.body.dataset.drop = event.dataTransfer!.getData("text/plain"); };
    });
    responses.push(commandResponse("drag", { source, destination }, "html-drag"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("HTML_DRAG_OK"); }, textResponse("拖放"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("drag the item into the target");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HTML_DRAG_OK", { timeout: 45_000 });
    expect(await page.locator("body").evaluate((body) => ({ ...body.dataset }))).toMatchObject({ dragstart: "yes", drop: "dragged" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
