import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configureWithImages, readEvents, type MockResponse } from "./fixtures";

for (const { name, kind, transform, rotated } of [
  { name: "root document scroll", kind: "root", transform: "none", rotated: false },
  { name: "same-process frame", kind: "same", transform: "translate(18px, 12px) scale(1.25)", rotated: false },
  { name: "cross-process frame", kind: "cross", transform: "translate(18px, 12px) scale(.8)", rotated: false },
  { name: "nested frame in cross-process frame", kind: "nested", transform: "translate(18px, 12px) scale(.8)", rotated: false },
  { name: "rotated frame", kind: "same", transform: "rotate(15deg)", rotated: true },
]) test(`captures target geometry in ${name}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { args: ["--site-per-process"] });
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/complex`);
    await page.evaluate(({ kind, transform }) => {
      document.body.style.cssText = "margin:0;height:2000px;background:rgb(0, 180, 0)";
      const same = document.querySelector<HTMLIFrameElement>('iframe[src="/same-frame"]')!;
      const cross = document.querySelector<HTMLIFrameElement>('iframe[src*=localhost]')!;
      same.style.display = cross.style.display = "none";
      if (kind !== "root") {
        const frame = kind === "same" ? same : cross;
        frame.style.cssText = `position:absolute;left:140px;top:300px;width:300px;height:200px;border:6px solid blue;transform-origin:0 0;transform:${transform}`;
      }
      window.scrollTo(0, 120);
    }, { kind, transform });
    let frame = kind === "root" ? page.mainFrame() : page.frames().find((item) => item.url().includes(kind === "same" ? "/same-frame" : "localhost"))!;
    if (kind === "nested") {
      await frame.evaluate(() => {
        document.body.style.cssText = "margin:0;height:700px;background:rgb(0,180,0)";
        const nested = document.createElement("iframe");
        nested.style.cssText = "position:absolute;left:35px;top:90px;width:180px;height:110px;border:4px solid blue;transform-origin:0 0;transform:translate(10px, 5px) scale(1.2)";
        nested.srcdoc = "<!doctype html><body></body>";
        document.body.append(nested);
        scrollTo(0, 30);
      });
      await expect.poll(() => page.frames().some((item) => item.url() === "about:srcdoc")).toBe(true);
      frame = page.frames().find((item) => item.url() === "about:srcdoc")!;
    }
    await frame.evaluate((isRoot) => {
      if (!isRoot) document.body.style.cssText = "margin:0;height:600px;background:rgb(0,180,0)";
      const target = document.createElement("div");
      target.id = "pixel-target";
      target.style.cssText = `position:absolute;left:70px;top:${isRoot ? 320 : 75}px;width:40px;height:30px;background:rgb(240, 10, 20)`;
      document.body.append(target);
      if (!isRoot) scrollTo(0, 25);
    }, kind === "root");
    await expect(frame.locator("#pixel-target")).toBeVisible();
    if (kind === "root") {
      responses.push(commandResponse("take_screenshot", { target: { by: "css", value: "#pixel-target" } }, "target-capture"));
    } else {
      responses.push(commandResponse("list_frames", {}, "frames"), (request) => {
        const entry = request.messages.findLast((item: any) => item.role === "tool");
        const data = JSON.parse(entry.content);
        const selected = data.frames.find((item: any) => kind === "nested" ? item.url === "about:srcdoc" : item.url.includes(kind === "same" ? "/same-frame" : "localhost"));
        expect(selected?.frameRef).toEqual(expect.any(String));
        return commandResponse("take_screenshot", { target: { by: "css", value: "#pixel-target", frame: { ref: selected.frameRef } } }, "target-capture");
      });
    }
    responses.push((request) => {
      if (rotated) {
        const entry = request.messages.findLast((item: any) => item.role === "tool");
        expect(JSON.stringify(entry.content)).toContain("unsupported-screenshot-geometry");
      }
      return textResponse("CAPTURE_DONE");
    }, textResponse("Capture"));
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("capture the target");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CAPTURE_DONE", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const capture = events.find((event) => event.type === "tool.finished" && event.toolCallId === "target-capture")?.output;
    if (rotated) return;
    expect(capture).toMatchObject({ ok: true });
    const result = capture.result;
    // Playwright's frame boundingBox does not apply iframe CSS transforms.
    // Find the red target in an independent root-viewport screenshot instead.
    const rootImage = await page.screenshot();
    const bounds = await opened.page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let x0 = bitmap.width, y0 = bitmap.height, x1 = -1, y1 = -1;
      for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
        const i = (y * bitmap.width + x) * 4;
        if (pixels[i]! > 180 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      bitmap.close();
      return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    }, rootImage.toString("base64"));
    expect(bounds.width).toBeGreaterThan(0);
    expect(Math.abs(result.screenshot.origin.x - bounds.x)).toBeLessThan(2);
    expect(Math.abs(result.screenshot.origin.y - bounds.y)).toBeLessThan(2);
    expect(Math.abs(result.screenshot.width / result.screenshot.scale - bounds.width)).toBeLessThan(2);
    expect(Math.abs(result.screenshot.height / result.screenshot.scale - bounds.height)).toBeLessThan(2);
    const artifact = events.find((event) => event.id === result.artifact.id)?.output;
    const pixel = await opened.page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const rgba = [...context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data];
      bitmap.close();
      return rgba;
    }, artifact.base64);
    expect(pixel[0]).toBeGreaterThan(180);
    expect(pixel[1]).toBeLessThan(80);
    expect(pixel[2]).toBeLessThan(80);
    expect(pixel[3]).toBe(255);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
