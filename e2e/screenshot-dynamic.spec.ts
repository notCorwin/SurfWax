import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configureWithImages, readEvents, type MockResponse } from "./fixtures";

for (const targeted of [false, true]) test(`captures ${targeted ? "target" : "viewport"} pixels independently of changing semantic content`, async () => {
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension(undefined, { viewport: null });
  let updating = true, mutations = 0, updates = Promise.resolve(), updateFailure: unknown;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<div id="pixel-proof" style="position:absolute;left:20px;top:20px;width:80px;height:60px;background:rgb(240,10,20)"></div><main id="quotes" style="position:absolute;top:200px"></main>';
      document.body.style.cssText = "margin:0;height:1300px;background:white";
      let tick = 0;
      const update = () => {
        document.querySelector("#quotes")!.innerHTML = `<section data-tick="${++tick}"><h1>Live quotes ${tick}</h1>${Array.from({ length: tick % 3 + 1 }, (_, i) => `<p>Market ${i}: ${tick + i}</p>`).join("")}</section>`;
      };
      (window as any).advanceQuotes = update;
      update();
    });
    responses.push(
      commandResponse("inspect_page", {}, "dynamic-semantics"),
      commandResponse("take_screenshot", targeted ? { target: { by: "css", value: "#pixel-proof" } } : {}, "dynamic-pixels"),
      textResponse("DYNAMIC_SCREENSHOT_DONE"), textResponse("Dynamic screenshot"),
    );
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    // Drive real renderer mutations through a separate CDP client. Background
    // tab timer throttling must not turn this into a static-page screenshot test.
    updates = (async () => {
      while (updating) {
        await target.evaluate(() => (window as any).advanceQuotes());
        mutations++;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })().catch(error => { updating = false; updateFailure = error; });
    await opened.page.getByTestId("composer-input").fill("Capture the live market page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_SCREENSHOT_DONE", { timeout: 45_000 });
    updating = false; await updates;
    expect(updateFailure).toBeUndefined();
    expect(mutations).toBeGreaterThan(10);
    const events = await readEvents(opened.page);
    await test.info().attach("canonical-events", { body: JSON.stringify(events), contentType: "application/json" });
    const semantic = events.find(e => ["tool.finished", "tool.failed"].includes(e.type) && e.toolCallId === "dynamic-semantics");
    if (semantic?.type === "tool.failed") expect(semantic).toMatchObject({ error: { code: "snapshot-unavailable" } });
    else {
      expect(semantic).toMatchObject({ type: "tool.finished", output: { partial: true, limitations: expect.any(String) } });
      expect(semantic.output.items.some((item: any) => item.ref)).toBe(false);
    }
    const terminals = events.filter(e => ["tool.finished", "tool.failed"].includes(e.type) && e.toolCallId === "dynamic-pixels");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: "tool.finished", output: { ok: true } });
    const automatic = terminals[0].output;
    if (automatic.pageSnapshotStatus) expect(automatic.pageSnapshotStatus).toMatchObject({ state: "unavailable" });
    else if (automatic.pageSnapshot?.partial) expect(automatic.pageSnapshot).toMatchObject({ partial: true, limitations: expect.any(String) });
    else expect(automatic.pageSnapshot).toMatchObject({ observationId: expect.any(String), items: expect.any(Array) });
    const result = terminals[0].output.result;
    const artifact = events.find(e => e.id === result.artifact.id)?.output;
    const pixels = await opened.page.evaluate(async ({ base64, scale }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const result = { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(Math.round(40 * scale), Math.round(40 * scale), 1, 1).data] };
      bitmap.close(); return result;
    }, { base64: artifact.base64, scale: result.screenshot.scale });
    expect(result.screenshot).toMatchObject({ width: pixels.width, height: pixels.height });
    expect(pixels.pixel).toEqual([240, 10, 20, 255]);
    if (targeted) {
      expect(result.screenshot.origin).toEqual({ x: 20, y: 20 });
      expect(pixels.width / result.screenshot.scale).toBe(80);
      expect(pixels.height / result.screenshot.scale).toBe(60);
    }
    expect(JSON.stringify(provider.requests[2])).toContain("image_url");
  } finally { updating = false; await updates; await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
