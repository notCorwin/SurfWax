import { expect } from "@playwright/test";
import { test, commandResponse, delayedResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((item) => item.line.includes(`button "${name}"`));

test("snapshot excludes offscreen content until root, nested and frame scrolling makes it visible", async () => {
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
        <span id="hidden-label" style="position:absolute;left:-9999px;top:140px">Offscreen accessible name</span><button id="offscreen-label-button" style="position:absolute;left:10px;top:140px" aria-labelledby="hidden-label"></button>
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
    // Independently identify characters whose boxes lie wholly inside both
    // the button and its own viewport. Partially visible glyphs are unproven.
    const visibleRuns = (element: Element) => {
      const text = element.firstChild!, box = element.getBoundingClientRect(), view = element.ownerDocument.defaultView!;
      const range = element.ownerDocument.createRange(), runs: string[] = [];
      let run = "";
      for (let index = 0; index < text.textContent!.length; index++) {
        range.setStart(text, index); range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        const inside = rect.width > 0 && rect.height > 0 && rect.left >= Math.max(0, box.left) && rect.top >= Math.max(0, box.top)
          && rect.right <= Math.min(view.innerWidth, box.right) && rect.bottom <= Math.min(view.innerHeight, box.bottom);
        if (inside) run += text.textContent![index];
        else if (run) { runs.push(run.replace(/\s+/g, " ").trim()); run = ""; }
      }
      if (run) runs.push(run.replace(/\s+/g, " ").trim());
      return runs.filter(Boolean);
    };
    const fixedRuns = await target.locator("#fixed-partial").evaluate(visibleRuns);
    const frameRuns = await frame.locator("#frame-partial").evaluate(visibleRuns);
    let revealRoot!: () => void, revealNested!: () => void;
    const rootGate = new Promise<void>((resolve) => { revealRoot = resolve; });
    const nestedGate = new Promise<void>((resolve) => { revealNested = resolve; });
    let baseline: any;
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "offscreen-before"),
      (request) => {
        baseline = lastTool(request);
        return commandResponse("inspect_page", { region: { by: "css", value: "#offscreen-label-button" }, budget: 12000 }, "offscreen-label");
      },
      () => commandResponse("inspect_page", { region: { by: "css", value: "#fixed-partial" }, budget: 12000 }, "offscreen-partial"),
      () => commandResponse("inspect_page", { region: { by: "css", value: "#frame-partial", frame: { by: "css", value: "#child-frame" } }, budget: 12000 }, "offscreen-frame-partial"),
      () => {
        return commandResponse("click", { target: { ref: button(baseline.items, "Reveal offscreen")?.ref } }, "offscreen-reveal");
      },
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "offscreen-delta"),
      delayedResponse(commandResponse("inspect_page", { budget: 12000 }, "scroll-root"), 0, rootGate),
      ((request: any) => delayedResponse(commandResponse("inspect_page", { since: lastTool(request).observationId, budget: 12000 }, "scroll-nested"), 0, nestedGate) as any),
      textResponse("OFFSCREEN_OK"),
      textResponse("屏幕外内容测试"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page and reveal offscreen content");
    await opened.page.getByTestId("composer-input").press("Enter");
    const finished = async (id: string) => (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === id);
    await expect.poll(() => finished("offscreen-delta"), { timeout: 45_000 }).toBeTruthy();
    await target.evaluate(() => window.scrollTo(0, 10000));
    revealRoot();
    await expect.poll(() => finished("scroll-root"), { timeout: 45_000 }).toBeTruthy();
    await target.evaluate(() => {
      window.scrollTo(0, 0);
      document.getElementById("ltr")!.scrollLeft = 10000;
      document.getElementById("rtl")!.scrollLeft = -10000;
      document.getElementById("vertical")!.scrollLeft = -10000;
      (document.getElementById("child-frame") as HTMLIFrameElement).contentWindow!.scrollTo(0, 10000);
    });
    revealNested();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OFFSCREEN_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("offscreen-before"), changed = output("offscreen-reveal"), delta = output("offscreen-delta");
    for (const name of ["Root negative hidden", "Root above hidden", "Fixed negative hidden", "Fixed right hidden", "LTR scroller hidden", "Frame fixed hidden"]) {
      expect(button(before.items, name)).toBeUndefined();
      expect(JSON.stringify(before.items)).not.toContain(name);
    }
    for (const name of ["Root right reachable", "Root below reachable", "LTR scroller reachable", "RTL scroller reachable", "Vertical scroller reachable", "Transformed fixed reachable", "Frame below reachable"]) {
      expect(JSON.stringify(before), name).not.toContain(name);
    }
    const previousBelow = button(output("scroll-root").items, "Root below reachable");
    expect(previousBelow?.ref).toBeTruthy();
    expect(output("scroll-nested").mode).toBe("delta");
    expect(output("scroll-nested").items).toContainEqual(expect.objectContaining({ id: previousBelow.id, change: "removed" }));
    for (const name of ["LTR scroller reachable", "RTL scroller reachable", "Vertical scroller reachable", "Frame below reachable"]) {
      expect(button(output("scroll-nested").items, name), name).toMatchObject({ ref: expect.any(String), change: "added" });
    }
    for (const [id, runs] of [["offscreen-partial", fixedRuns], ["offscreen-frame-partial", frameRuns]] as const) {
      const partial = output(id)?.items?.find((item: any) => /\bbutton(?:\s|$)/.test(item.line) && item.ref);
      expect(partial?.ref, id).toEqual(expect.any(String));
      const name = /\bbutton\s+("(?:\\.|[^"\\])*")/.exec(partial.line)?.[1];
      if (name) expect(runs.some((run) => run.includes(JSON.parse(name))) || runs.join(" ").includes(JSON.parse(name)), id).toBe(true);
      else expect(partial.line, id).toContain("[name=unknown]");
    }
    expect(JSON.stringify(before.items)).not.toContain("Offscreen accessible name");
    const anonymous = output("offscreen-label");
    expect(anonymous?.items?.some((item: any) => /\bbutton(?:\s|$)/.test(item.line) && typeof item.ref === "string")).toBe(true);
    expect(JSON.stringify(anonymous.items)).not.toContain("Offscreen accessible name");
    expect(changed).toMatchObject({ ok: true });
    for (const name of ["Root negative hidden", "Fixed negative hidden", "LTR scroller hidden", "Frame fixed hidden"]) {
      expect(button(changed.pageSnapshot.items, name)?.ref).toBeTruthy();
      expect(button(delta.items, name)?.change).toBe("added");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("snapshot exposes RTL root content only after negative scrolling makes it visible", async () => {
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
    let reveal!: () => void;
    const gate = new Promise<void>((resolve) => { reveal = resolve; });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "rtl-snapshot"),
      delayedResponse(commandResponse("inspect_page", { budget: 12000 }, "rtl-scrolled"), 0, gate),
      textResponse("RTL_OFFSCREEN_OK"), textResponse("RTL 测试"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the RTL page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "tool.finished" && event.toolCallId === "rtl-snapshot"), { timeout: 45_000 }).toBe(true);
    await target.evaluate(() => window.scrollTo(-10000, 0));
    reveal();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RTL_OFFSCREEN_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "rtl-snapshot")?.output;
    expect(JSON.stringify(result)).not.toContain("RTL root reachable");
    expect(JSON.stringify(result)).not.toContain("RTL root hidden");
    const scrolled = events.find((event) => event.type === "tool.finished" && event.toolCallId === "rtl-scrolled")?.output;
    expect(button(scrolled.items, "RTL root reachable")?.ref).toBeTruthy();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("snapshot intersects iframe content with the visible parent viewport and ancestor clips", async () => {
  const provider = await startProvider([
    commandResponse("inspect_page", { budget: 12000 }, "frame-clips"),
    textResponse("FRAME_CLIPS_OK"), textResponse("Frame clips"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.style.margin = "0";
      document.body.innerHTML = `<iframe id="viewport-frame" style="position:fixed;left:-100px;top:40px;width:220px;height:100px;border:0"></iframe>
        <div style="position:fixed;left:250px;top:40px;width:100px;height:100px;overflow:hidden"><iframe id="clipped-frame" style="width:240px;height:100px;border:0"></iframe></div>`;
      (document.getElementById("viewport-frame") as HTMLIFrameElement).srcdoc = `<!doctype html><style>body{margin:0}</style>
        <button style="position:absolute;left:10px;top:10px">VF_OUT</button>
        <button style="position:absolute;left:115px;top:50px">VF_IN</button>`;
      (document.getElementById("clipped-frame") as HTMLIFrameElement).srcdoc = `<!doctype html><style>body{margin:0}</style>
        <button style="position:absolute;left:5px;top:10px">CLIP_IN</button>
        <button style="position:absolute;left:130px;top:50px">CLIP_OUT</button>`;
    });
    await expect(target.frameLocator("#viewport-frame").locator("button")).toHaveCount(2);
    await expect(target.frameLocator("#clipped-frame").locator("button")).toHaveCount(2);
    await target.frameLocator("#clipped-frame").locator("body").evaluate(() => {
      const nested = document.createElement("iframe");
      nested.id = "nested-frame";
      nested.style.cssText = "position:absolute;left:40px;top:65px;width:110px;height:30px;border:0";
      nested.srcdoc = `<!doctype html><style>body{margin:0}button{position:absolute;top:0}</style><button style="left:0">D_IN</button><button style="left:70px">D_OUT</button>`;
      document.body.append(nested);
    });
    await expect(target.frameLocator("#clipped-frame").frameLocator("#nested-frame").locator("button")).toHaveCount(2);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect visible frame contents");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CLIPS_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const capture = events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "frame-clips");
    expect(capture).toMatchObject({ type: "tool.finished", output: { items: expect.any(Array) } });
    const result = capture!.output;
    expect(JSON.stringify(result)).toContain("VF_IN");
    expect(JSON.stringify(result)).toContain("CLIP_IN");
    expect(JSON.stringify(result)).toContain("D_IN");
    expect(JSON.stringify(result)).not.toContain("VF_OUT");
    expect(JSON.stringify(result)).not.toContain("CLIP_OUT");
    expect(JSON.stringify(result)).not.toContain("D_OUT");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("snapshot excludes ordinary elements completely covered by opaque content", async () => {
  const provider = await startProvider([commandResponse("inspect_page", { budget: 12000 }, "opaque"), textResponse("OPAQUE_DONE"), textResponse("Opaque")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<button style="position:absolute;left:20px;top:30px">OPEN_BUTTON</button>
        <button style="position:absolute;left:20px;top:120px">COVERED_BUTTON</button>
        <p style="position:absolute;left:20px;top:150px">COVERED_TEXT</p>
        <div style="position:absolute;left:0;top:100px;width:400px;height:160px;background:rgb(22,22,22);z-index:1;pointer-events:none"></div>`;
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect what is visible");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("OPAQUE_DONE", { timeout: 45_000 });
    const result = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "opaque")?.output;
    expect(JSON.stringify(result)).toContain("OPEN_BUTTON");
    expect(JSON.stringify(result)).not.toContain("COVERED_BUTTON");
    expect(JSON.stringify(result)).not.toContain("COVERED_TEXT");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("partially occluded button keeps its ref without exposing covered text", async () => {
  const provider = await startProvider([commandResponse("inspect_page", { budget: 12000 }, "partial-opaque"), textResponse("PARTIAL_OPAQUE_DONE"), textResponse("Partial opaque")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<button style="position:absolute;left:20px;top:30px">CONTROL_VISIBLE</button>
        <button id="partial" style="position:absolute;left:20px;top:120px;width:300px;height:40px">PARTIALLY_OCCLUDED_BUTTON</button>
        <div id="cover" style="position:absolute;left:170px;top:120px;width:150px;height:40px;background:white;z-index:1;pointer-events:none"></div>`;
    });
    const geometry = await target.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("partial")!);
      const text = range.getBoundingClientRect(), cover = document.getElementById("cover")!.getBoundingClientRect();
      return { textLeft: text.left, textRight: text.right, coverLeft: cover.left, coverRight: cover.right };
    });
    expect(geometry.textLeft).toBeLessThan(geometry.coverLeft);
    expect(geometry.textRight).toBeGreaterThan(geometry.coverLeft);
    expect(geometry.textRight).toBeLessThanOrEqual(geometry.coverRight);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PARTIAL_OPAQUE_DONE", { timeout: 45_000 });
    const result = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "partial-opaque")?.output;
    expect(JSON.stringify(result)).toContain("CONTROL_VISIBLE");
    expect(JSON.stringify(result)).not.toContain("PARTIALLY_OCCLUDED_BUTTON");
    expect(result.items.filter((item: any) => /\bbutton(?:\s|$)/.test(item.line) && typeof item.ref === "string")).toHaveLength(2);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("snapshot retains visible text above an opaque negative z-index background", async () => {
  const provider = await startProvider([commandResponse("inspect_page", { budget: 12000 }, "negative-z"), textResponse("NEGATIVE_Z_DONE"), textResponse("Negative z")]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<p id="front" style="color:black">TEXT_ABOVE_NEGATIVE_BACKGROUND</p>
        <div style="position:fixed;inset:0;z-index:-1;background:white;pointer-events:none"></div>
        <p style="position:absolute;left:200px;top:60px;z-index:2;color:black">TEXT_ABOVE_LOWER_STACKING</p>
        <div style="position:absolute;left:180px;top:60px;width:360px;height:70px;z-index:1;background:white;pointer-events:none"></div>`;
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NEGATIVE_Z_DONE", { timeout: 45_000 });
    const result = (await readEvents(opened.page)).find((event) => event.type === "tool.finished" && event.toolCallId === "negative-z")?.output;
    expect(JSON.stringify(result)).toContain("TEXT_ABOVE_NEGATIVE_BACKGROUND");
    expect(JSON.stringify(result)).toContain("TEXT_ABOVE_LOWER_STACKING");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const kind of ["root", "nested", "opacity", "occlusion", "reparent"] as const) test(`a ${kind} change cannot continue a frozen snapshot with no-longer-visible content`, async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let cursor: string | undefined;
  let initialResult: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 720 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate((scrollKind) => {
      document.body.style.margin = "0";
      const rows = Array.from({ length: 60 }, (_, i) => `<p>OLD_VISIBLE_ROW_${i}_${"x".repeat(60)}</p>`).join("");
      const content = `${rows}<div style="height:1600px"></div><p>NEW_VISIBLE_AFTER_SCROLL</p>`;
      document.body.innerHTML = `<style>p{font:6px/8px monospace;margin:0}</style>${scrollKind === "nested" ? `<main id="scroll-box" style="height:500px;overflow:auto">${content}</main>` : scrollKind === "reparent" ? `<main id="content" style="position:absolute;left:0;top:0;width:100%">${content}</main><main id="hidden" style="position:absolute;left:0;top:0;width:100%;opacity:0"></main>` : `<main id="content">${content}</main>`}`;
      if (scrollKind === "occlusion") {
        document.getElementById("content")!.style.cssText = "position:relative;z-index:2";
        const cover = document.createElement("div");
        cover.id = "cover";
        cover.style.cssText = "position:fixed;inset:0;background:white;z-index:1;pointer-events:none";
        document.body.append(cover);
      }
    }, kind);
    responses.push(commandResponse("inspect_page", { budget: 400 }, "cursor-initial"),
      ((request: any) => {
        initialResult = lastTool(request);
        cursor = initialResult.nextCursor;
        return delayedResponse(commandResponse("inspect_page", { cursor, budget: 400 }, "cursor-after-scroll"), 0, gate) as any;
      }), textResponse("SCROLL_CURSOR_DONE"), textResponse("Scroll cursor"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and continue");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => initialResult, { timeout: 45_000 }).toBeDefined();
    expect(initialResult).toMatchObject({ nextCursor: expect.any(String) });
    const boxes = (elements: Element[]) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const originalBoxes = kind === "reparent" ? await target.locator("#content p").evaluateAll(boxes) : null;
    await target.evaluate((scrollKind) => {
      if (scrollKind === "nested") document.getElementById("scroll-box")!.scrollTop = 10000;
      else if (scrollKind === "opacity") document.getElementById("content")!.style.opacity = "0";
      else if (scrollKind === "occlusion") document.getElementById("cover")!.style.zIndex = "9999";
      else if (scrollKind === "reparent") document.getElementById("hidden")!.append(...document.getElementById("content")!.childNodes);
      else window.scrollTo(0, 10000);
    }, kind);
    if (kind === "reparent") expect(await target.locator("#hidden p").evaluateAll(boxes)).toEqual(originalBoxes);
    release();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SCROLL_CURSOR_DONE", { timeout: 45_000 });
    const event = (await readEvents(opened.page)).find((item) => ["tool.finished", "tool.failed"].includes(item.type) && item.toolCallId === "cursor-after-scroll");
    expect(event).toMatchObject({ type: "tool.failed", output: { ok: false, error: { code: "stale-observation" } } });
    expect(JSON.stringify(event!.output)).not.toContain("OLD_VISIBLE_ROW_");
  } finally { release(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
