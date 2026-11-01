import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((item) => item.line.includes(`button "${name}"`));

test("snapshot excludes unreachable offscreen content but keeps scroll-reachable and partially visible content", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.style.margin = "0";
      document.body.innerHTML = `<main>
        <button id="reveal" style="position:absolute;left:10px;top:10px">Reveal offscreen</button>
        <button id="root-negative" style="position:absolute;left:-9999px;top:30px">Root negative hidden</button>
        <button id="root-above" style="position:absolute;left:100px;top:-9999px">Root above hidden</button>
        <button id="root-right" style="position:absolute;left:1800px;top:30px">Root right reachable</button>
        <button id="root-below" style="position:absolute;left:100px;top:1600px">Root below reachable</button>
        <button id="fixed-negative" style="position:fixed;left:-9999px;top:65px">Fixed negative hidden</button>
        <button id="fixed-right" style="position:fixed;left:1800px;top:65px">Fixed right hidden</button>
        <button id="fixed-partial" style="position:fixed;left:-25px;top:100px;width:100px">Fixed partially visible</button>
        <span id="hidden-label" style="position:absolute;left:-9999px;top:140px">Offscreen accessible name</span><button style="position:absolute;left:10px;top:140px" aria-labelledby="hidden-label"></button>
        <div id="ltr" style="position:absolute;left:10px;top:220px;width:200px;height:100px;overflow:auto;border:1px solid">
          <div style="position:relative;width:1000px;height:80px">
            <button id="ltr-negative" style="position:absolute;left:-9999px;top:10px">LTR scroller hidden</button>
            <button id="ltr-positive" style="position:absolute;left:800px;top:10px">LTR scroller reachable</button>
          </div>
        </div>
        <div id="rtl" dir="rtl" style="position:absolute;left:300px;top:220px;width:200px;height:100px;overflow:auto;border:1px solid">
          <div style="position:relative;width:1000px;height:80px"><button id="rtl-reachable" style="position:absolute;left:0;top:10px">RTL scroller reachable</button></div>
        </div>
        <div id="vertical" style="position:absolute;left:600px;top:350px;width:200px;height:100px;overflow:auto;writing-mode:vertical-rl;border:1px solid">
          <div style="position:relative;width:1000px;height:80px"><button id="vertical-reachable" style="position:absolute;left:0;top:10px">Vertical scroller reachable</button></div>
        </div>
        <div style="position:absolute;left:600px;top:400px;transform:translateZ(0)"><button id="transformed-fixed" style="position:fixed;left:0;top:800px">Transformed fixed reachable</button></div>
      </main>`;
      const frame = document.createElement("iframe");
      frame.id = "child-frame";
      frame.style.cssText = "position:absolute;left:600px;top:220px;width:200px;height:100px;border:1px solid";
      frame.srcdoc = `<!doctype html><style>body{margin:0}</style>
        <button id="frame-fixed" style="position:fixed;left:-9999px;top:10px">Frame fixed hidden</button>
        <button id="frame-partial" style="position:fixed;left:-25px;top:40px;width:100px">Frame partially visible</button>
        <button id="frame-below" style="position:absolute;left:10px;top:800px">Frame below reachable</button>`;
      document.body.append(frame);
      document.getElementById("reveal")!.addEventListener("click", () => {
        (document.getElementById("root-negative") as HTMLElement).style.left = "200px";
        (document.getElementById("fixed-negative") as HTMLElement).style.left = "200px";
        (document.getElementById("ltr-negative") as HTMLElement).style.left = "20px";
        ((document.getElementById("child-frame") as HTMLIFrameElement).contentDocument!.getElementById("frame-fixed") as HTMLElement).style.left = "20px";
      });
    });
    const frame = target.frameLocator("#child-frame");
    await expect(frame.locator("#frame-below")).toHaveCount(1);
    // Independently verify Chrome's scroll ranges and painted results, so the
    // expected snapshot does not confuse "outside the viewport" with hidden.
    const actual = await target.evaluate(async () => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const hit = (id: string) => {
        const rect = box(id);
        return document.elementFromPoint(Math.max(0, rect.left) + 3, Math.max(0, rect.top) + 3) === document.getElementById(id);
      };
      const ltr = document.getElementById("ltr")!, rtl = document.getElementById("rtl")!, vertical = document.getElementById("vertical")!;
      window.scrollTo(-10000, -10000);
      const rootMin = [scrollX, scrollY], rootNegative = box("root-negative").right < 0, rootAbove = box("root-above").bottom < 0;
      const partial = hit("fixed-partial"), fixedBefore = [box("fixed-negative").left, box("fixed-right").left];
      window.scrollTo(10000, 0); const rightReachable = hit("root-right");
      window.scrollTo(0, 10000); const belowReachable = hit("root-below"), transformedFixedReachable = hit("transformed-fixed");
      const fixedAfter = [box("fixed-negative").left, box("fixed-right").left];
      window.scrollTo(0, 0);
      ltr.scrollLeft = -10000; const ltrMin = ltr.scrollLeft, ltrNegative = box("ltr-negative").right < box("ltr").left;
      ltr.scrollLeft = 10000; const ltrReachable = hit("ltr-positive");
      rtl.scrollLeft = 0; const rtlInitiallyOffscreen = box("rtl-reachable").right < box("rtl").left;
      rtl.scrollLeft = -10000; const rtlPosition = rtl.scrollLeft, rtlReachable = hit("rtl-reachable");
      vertical.scrollLeft = 0; const verticalInitiallyOffscreen = box("vertical-reachable").right < box("vertical").left;
      vertical.scrollLeft = -10000; const verticalPosition = vertical.scrollLeft, verticalReachable = hit("vertical-reachable");
      ltr.scrollLeft = 0; rtl.scrollLeft = 0; vertical.scrollLeft = 0; window.scrollTo(0, 0);
      return { rootMin, rootNegative, rootAbove, partial, fixedBefore, fixedAfter, rightReachable, belowReachable, transformedFixedReachable, ltrMin, ltrNegative, ltrReachable, rtlInitiallyOffscreen, rtlPosition, rtlReachable, verticalInitiallyOffscreen, verticalPosition, verticalReachable };
    });
    expect(actual).toMatchObject({ rootMin: [0, 0], rootNegative: true, rootAbove: true, partial: true,
      fixedBefore: [-9999, 1800], fixedAfter: [-9999, 1800], rightReachable: true, belowReachable: true, transformedFixedReachable: true,
      ltrMin: 0, ltrNegative: true, ltrReachable: true, rtlInitiallyOffscreen: true, rtlPosition: -800, rtlReachable: true,
      verticalInitiallyOffscreen: true, verticalPosition: -800, verticalReachable: true });
    const frameActual = await frame.locator("body").evaluate(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      window.scrollTo(-10000, -10000);
      const fixedBefore = box("frame-fixed").left;
      const partialBox = box("frame-partial");
      const partial = document.elementFromPoint(3, partialBox.top + 3) === document.getElementById("frame-partial");
      window.scrollTo(0, 10000);
      const fixedAfter = box("frame-fixed").left, below = box("frame-below");
      const reachable = document.elementFromPoint(below.left + 3, below.top + 3) === document.getElementById("frame-below");
      window.scrollTo(0, 0);
      return { fixedBefore, fixedAfter, partial, reachable };
    });
    expect(frameActual).toEqual({ fixedBefore: -9999, fixedAfter: -9999, partial: true, reachable: true });
    let baseline: any;
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "offscreen-before"),
      (request) => {
        baseline = lastTool(request);
        return commandResponse("click", { target: { ref: button(baseline.items, "Reveal offscreen")?.ref } }, "offscreen-reveal");
      },
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "offscreen-delta"),
      textResponse("OFFSCREEN_OK"),
      textResponse("屏幕外内容测试"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page and reveal offscreen content");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OFFSCREEN_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("offscreen-before"), changed = output("offscreen-reveal"), delta = output("offscreen-delta");
    for (const name of ["Root negative hidden", "Root above hidden", "Fixed negative hidden", "Fixed right hidden", "LTR scroller hidden", "Frame fixed hidden"]) {
      expect(button(before.items, name)).toBeUndefined();
      expect(JSON.stringify(before.items)).not.toContain(name);
    }
    for (const name of ["Root right reachable", "Root below reachable", "Fixed partially visible", "LTR scroller reachable", "RTL scroller reachable", "Vertical scroller reachable", "Transformed fixed reachable", "Frame partially visible", "Frame below reachable", "Offscreen accessible name"]) {
      expect(button(before.items, name)?.ref).toBeTruthy();
    }
    expect(before.items.filter((item: any) => item.line.includes("Offscreen accessible name"))).toHaveLength(1);
    expect(changed).toMatchObject({ ok: true });
    for (const name of ["Root negative hidden", "Fixed negative hidden", "LTR scroller hidden", "Frame fixed hidden"]) {
      expect(button(changed.pageSnapshot.items, name)?.ref).toBeTruthy();
      expect(button(delta.items, name)?.change).toBe("added");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("snapshot preserves content reachable by negative root scrolling in RTL documents", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.documentElement.dir = "rtl";
      document.body.style.margin = "0";
      document.body.innerHTML = `<button id="rtl-left" style="position:absolute;right:1800px;top:30px">RTL root reachable</button>
        <button id="rtl-right" style="position:absolute;left:1800px;top:80px">RTL root hidden</button>`;
    });
    const actual = await target.evaluate(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      window.scrollTo(10000, 0);
      const maximum = scrollX, hiddenRight = box("rtl-right").left >= innerWidth;
      window.scrollTo(-10000, 0);
      const minimum = scrollX, boxLeft = box("rtl-left");
      const reachable = document.elementFromPoint(boxLeft.left + 3, boxLeft.top + 3) === document.getElementById("rtl-left");
      window.scrollTo(0, 0);
      return { maximum, minimum, hiddenRight, reachable };
    });
    expect(actual.maximum).toBeLessThanOrEqual(1);
    expect(actual.minimum).toBeLessThan(0);
    expect(actual.hiddenRight).toBe(true);
    expect(actual.reachable).toBe(true);
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "rtl-snapshot"), textResponse("RTL_OFFSCREEN_OK"), textResponse("RTL 测试"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the RTL page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RTL_OFFSCREEN_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "rtl-snapshot")?.output;
    expect(button(result.items, "RTL root reachable")?.ref).toBeTruthy();
    expect(button(result.items, "RTL root hidden")).toBeUndefined();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
