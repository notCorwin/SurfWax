import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

for (const { name, kind, transform } of [
  { name: "same-process scale", kind: "same", transform: "scale(1.5)" },
  { name: "same-process rotation", kind: "same", transform: "rotate(18deg) scale(1.2)" },
  { name: "same-process perspective", kind: "same", transform: "perspective(700px) rotateY(30deg)" },
  { name: "cross-process perspective", kind: "cross", transform: "perspective(700px) rotateY(30deg)" },
  { name: "nested same-process inside cross-process", kind: "nested", transform: "perspective(700px) rotateY(20deg)" },
]) test(`clicks the intended element in ${name}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/complex`);
    await page.evaluate(({ kind, transform }) => {
      document.body.addEventListener("click", () => { document.body.dataset.wrongClick = "yes"; });
      const same = document.querySelector<HTMLIFrameElement>('iframe[src="/same-frame"]')!;
      const cross = document.querySelector<HTMLIFrameElement>('iframe[src*=localhost]')!;
      const selected = kind === "same" ? same : cross;
      const other = kind === "same" ? cross : same;
      other.style.display = "none";
      selected.style.cssText = `position:absolute;left:120px;top:100px;width:300px;height:200px;border:0;transform-origin:0 0;transform:${transform}`;
    }, { kind, transform });
    let frame = page.frames().find((item) => item.url().includes(kind === "same" ? "/same-frame" : "localhost"))!;
    if (kind === "nested") {
      await frame.evaluate(() => {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "position:absolute;left:20px;top:15px;width:220px;height:150px;border:0;transform-origin:0 0;transform:rotate(8deg) scale(1.2)";
        iframe.srcdoc = "<!doctype html><body></body>";
        document.body.append(iframe);
      });
      await expect.poll(() => page.frames().some((item) => item.url() === "about:srcdoc")).toBe(true);
      frame = page.frames().find((item) => item.url() === "about:srcdoc")!;
    }
    await frame.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Geometry target";
      button.style.cssText = "position:absolute;left:90px;top:60px;width:80px;height:30px";
      button.onclick = () => { document.body.dataset.geometryClick = "yes"; };
      document.body.append(button);
    });
    let ref = "";
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    responses.push(
      commandResponse("list_frames", {}, "list-geometry-frames"),
      (request) => {
        const frames = last(request).frames;
        const selected = frames.find((item: any) => kind === "nested" ? item.url === "about:srcdoc" : item.url.includes(kind === "same" ? "/same-frame" : "localhost"));
        expect(selected?.frameRef).toEqual(expect.any(String));
        ref = selected.frameRef;
        return commandResponse("click", { target: { by: "role", value: "button", name: "Geometry target", frame: { ref } } }, "click-geometry");
      },
      (request) => { expect(last(request)).toMatchObject({ ok: true }); return textResponse("GEOMETRY_OK"); },
      textResponse("点击框架内的按钮"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("click the geometry target");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("GEOMETRY_OK", { timeout: 30_000 });
    expect(await frame.locator("body").getAttribute("data-geometry-click")).toBe("yes");
    expect(await page.locator("body").getAttribute("data-wrong-click")).toBeNull();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
