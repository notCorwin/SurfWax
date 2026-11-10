import { expect, type Page } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  return JSON.parse(content);
}

async function coveredTextPixels(target: Page, images: Buffer[]): Promise<number> {
  return target.evaluate(async (sources) => {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
    const pixels = await Promise.all(sources.map(async (src) => {
      const image = new Image(); image.src = `data:image/png;base64,${src}`; await image.decode();
      canvas.width = image.width; canvas.height = image.height; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    }));
    let covered = 0;
    for (let i = 0; i < pixels[0].length; i += 4) {
      const distance = (a: Uint8ClampedArray, b: Uint8ClampedArray) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (distance(pixels[0], pixels[1]) > 30 && distance(pixels[2], pixels[3]) < 3) covered++;
    }
    return covered;
  }, images.map((image) => image.toString("base64")));
}

for (const kind of ["visible", "parent-overlay", "scaled", "frame-clip"] as const) {
  test(`cross-origin frame ellipsis: ${kind}`, async () => {
    test.setTimeout(90_000);
    const responses: any[] = [], provider = await startProvider(responses), opened = await openExtension();
    let snapshot: any, click: any;
    try {
      const target = await opened.context.newPage();
      await target.setViewportSize({ width: 800, height: 600 });
      await target.goto(`${provider.origin}/target`);
      const frameOrigin = provider.origin.replace("127.0.0.1", "localhost");
      await target.evaluate(({ src, kind }) => {
        document.body.innerHTML = `<style>body{margin:0} #clip{position:absolute;left:50px;top:50px;width:${kind === "frame-clip" ? "95" : "260"}px;height:160px;overflow:${kind === "frame-clip" ? "hidden" : "visible"}} iframe{border:0;width:260px;height:160px;${kind === "scaled" ? "transform:scale(.8);transform-origin:0 0" : ""}}</style><div id="clip"><iframe id="frame"></iframe></div>`;
        (document.querySelector("#frame") as HTMLIFrameElement).src = src;
      }, { src: `${frameOrigin}/target`, kind });
      const owner = target.locator("#frame");
      await expect.poll(() => target.frames().some((entry) => entry.url() === `${frameOrigin}/target`)).toBe(true);
      const frame = target.frame({ url: `${frameOrigin}/target` })!.locator("body");
      await frame.waitFor();
      await frame.evaluate((body) => {
        body.style.margin = "0";
        body.innerHTML = `<button id="queue" aria-label="UNPAINTED_FRAME_ACCESSIBLE_NAME" style="position:absolute;left:20px;top:20px;display:block;width:110px;height:25px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:13.3333px Arial">Next TASK-746F9DB6E6FB</button>`;
        body.querySelector("button")!.addEventListener("click", () => { body.dataset.clicked = "yes"; });
      });
      const button = owner.contentFrame().locator("#queue");
      if (kind === "visible" || kind === "scaled") {
        // Changing only a hidden suffix must not change rendered pixels.
        const before = await button.screenshot();
        await button.evaluate((element) => { element.textContent = "Next TASK-746F9DB6E6FC"; });
        expect((await button.screenshot()).equals(before)).toBe(true);
        await button.evaluate((element) => { element.textContent = "Next TASK-746F9DB6E6FB"; });
      }
      if (kind === "parent-overlay" || kind === "frame-clip") {
        const box = (await button.boundingBox())!;
        const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
        if (kind === "frame-clip") await target.locator("#clip").evaluate((element) => { element.style.overflow = "visible"; });
        const visibleText = await target.screenshot({ clip });
        await button.evaluate((element) => { element.style.color = "transparent"; });
        const noText = await target.screenshot({ clip });
        await button.evaluate((element) => { element.style.color = ""; });
        if (kind === "parent-overlay") {
          await target.evaluate(() => {
            const overlay = document.createElement("div");
            overlay.id = "overlay";
            overlay.style.cssText = "position:absolute;left:74px;top:70px;width:36px;height:25px;background:white;pointer-events:none;z-index:3";
            document.body.append(overlay);
          });
        } else await target.locator("#clip").evaluate((element) => { element.style.overflow = "hidden"; });
        const coveredText = await target.screenshot({ clip });
        await button.evaluate((element) => { element.style.color = "transparent"; });
        const coveredNoText = await target.screenshot({ clip });
        await button.evaluate((element) => { element.style.color = ""; });
        // Verify the parent overlay or clip actually covers text pixels, not just the iframe box.
        expect(await coveredTextPixels(target, [visibleText, noText, coveredText, coveredNoText])).toBeGreaterThan(0);
      }
      responses.push(commandResponse("inspect_page", { budget: 12000 }, `frame-ellipsis-${kind}`), (request: any) => {
        snapshot = lastTool(request);
        const row = snapshot.items?.find((entry: any) => itemLine(entry).includes('- button "Next TASK-7…"'));
        return (kind === "visible" || kind === "scaled") && row?.ref ? commandResponse("click", { target: { ref: row.ref } }, "frame-ellipsis-click") : textResponse("FRAME_ELLIPSIS_DONE");
      }, (request: any) => {
        if (request.messages.some((entry: any) => entry.role === "tool")) click = lastTool(request);
        return textResponse("FRAME_ELLIPSIS_DONE");
      }, textResponse("FRAME_ELLIPSIS_DONE"));
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the visible frame and activate its Next button");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_ELLIPSIS_DONE", { timeout: 60_000 });
      expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
      const text = JSON.stringify(snapshot.items);
      expect(text).not.toContain("UNPAINTED_FRAME_ACCESSIBLE_NAME");
      expect(text).not.toContain("46F9DB6E6FB");
      const row = snapshot.items.find((entry: any) => /\bbutton(?:\s|$)/.test(itemLine(entry)));
      if (kind === "visible" || (kind === "scaled" && itemLine(row).includes('"Next TASK-7…"'))) {
        expect(itemLine(row)).toContain('- button "Next TASK-7…"');
        expect(row?.ref).toEqual(expect.any(String));
        expect(click).toMatchObject({ ok: true });
        expect(await frame.getAttribute("data-clicked")).toBe("yes");
      } else {
        // Parent clipping or occlusion cannot prove the entire prefix; transformed
        // frames may conservatively remain unknown until their proof is supported.
        expect(text).not.toContain("Next TASK-7");
        if (row) expect(itemLine(row)).toContain("[name=unknown]");
      }
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}
