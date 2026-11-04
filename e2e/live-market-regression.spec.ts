import {
  SNAPSHOT_COMPUTED_STYLES,
  snapshotVisibility,
} from "../src/chrome/snapshot-visibility";
import { expect } from "@playwright/test";
import {
  test,
  commandResponse,
  textResponse,
  startProvider,
  openExtension,
  dispose,
  configure,
  readEvents,
  type MockResponse,
} from "./fixtures";

// Use real renderer documents: opacity:0 alone still has layout and cannot
// reproduce a display:none/zero-sized authentication frame's missing viewport.
test("captures a page with hidden layoutless and zero-sized iframe documents", async () => {
  const responses: MockResponse[] = [],
    provider = await startProvider(responses),
    opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(
      (cross) => {
        document.body.innerHTML =
          "<main><h1>Market dashboard</h1><button>Visible market action</button></main>";
        for (const style of [
          "display:none",
          "width:0;height:0;border:0",
        "width:0;height:0;border:4px solid black",
          "visibility:hidden",
          "opacity:0",
        ]) {
          for (const src of ["/same-frame", cross]) {
            const frame = document.createElement("iframe");
            frame.style.cssText = style;
            frame.src = src;
            document.body.append(frame);
          }
        }
      },
      `${provider.origin.replace("127.0.0.1", "localhost")}/frame`,
    );
    await expect.poll(() => target.frames().length).toBe(11);
    await Promise.all(
      target.frames().map((frame) => frame.waitForLoadState("load")),
    );
    const cdp = await opened.context.newCDPSession(target);
    const raw = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...SNAPSHOT_COMPUTED_STYLES],
      includeDOMRects: true,
      includePaintOrder: true,
    });
    // The original strict all-documents pass fails on actual Chrome output.
    expect(() => snapshotVisibility(raw, { requireViewport: true })).toThrow(
      "Missing viewport geometry",
    );
    const geometry = [];
    for (const doc of raw.documents) {
      const root = doc.nodes.nodeName!.findIndex(
        (index) => raw.strings[index] === "#document",
      );
      const row = doc.layout.nodeIndex.indexOf(root);
      const frameId = raw.strings[doc.frameId]!;
      let owner;
      try {
        const { backendNodeId } = await cdp.send("DOM.getFrameOwner", {
          frameId,
        });
        owner = (await cdp.send("DOM.describeNode", { backendNodeId })).node
          .attributes;
      } catch {
        /* Root has no owner. */
      }
      geometry.push({
        frameId,
        owner,
        viewport: doc.layout.bounds[row],
        scrollX: doc.scrollOffsetX,
        scrollY: doc.scrollOffsetY,
      });
    }
    await test
      .info()
      .attach("chrome-document-geometry", {
        body: JSON.stringify(geometry, null, 2),
        contentType: "application/json",
      });
    expect(
      geometry.some(
        (doc) =>
          doc.owner?.includes("display: none;") &&
          doc.viewport?.[2] === 0 &&
          doc.viewport?.[3] === 0,
      ),
    ).toBe(true);
    await cdp.detach();
    await target.evaluate(() => {
      const show = document.createElement("button");
      show.textContent = "Show market frames";
      show.onclick = () =>
        document
          .querySelectorAll("iframe")
          .forEach(
            (frame) => (frame.style.cssText = "width:300px;height:120px"),
          );
      document.querySelector("main")!.append(show);
    });
    responses.push(
      commandResponse(
        "inspect_page",
        { full: true, budget: 12000 },
        "hidden-market",
      ),
      commandResponse(
        "click",
        { target: { by: "role", value: "button", name: "Show market frames" } },
        "reveal-market",
      ),
      commandResponse(
        "inspect_page",
        { full: true, budget: 12000 },
        "visible-market",
      ),
      textResponse("MARKET_CAPTURE_DONE"),
      textResponse("Market"),
    );
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await target.bringToFront();
    await opened.page
      .getByTestId("composer-input")
      .fill("Read visible market content");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "MARKET_CAPTURE_DONE",
      { timeout: 45000 },
    );
    const events = await readEvents(opened.page);
    await test
      .info()
      .attach("canonical-events", {
        body: JSON.stringify(events, null, 2),
        contentType: "application/json",
      });
    const result = events.find(
      (e) =>
        ["tool.finished", "tool.failed"].includes(e.type) &&
        e.toolCallId === "hidden-market",
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      type: "tool.finished",
      output: { items: expect.any(Array) },
    });
    const visible = JSON.stringify(result.output.items);
    expect(visible).toContain("Visible market action");
    expect(visible).not.toContain("Frame action");
    expect(visible).not.toContain("same origin");
    const revealed = events.find(
      (e) =>
        e.type === "tool.finished" && e.toolCallId?.endsWith("visible-market"),
    );
    expect(JSON.stringify(revealed?.output.items)).toContain("Frame action");
    expect(JSON.stringify(revealed?.output.items)).toContain("same origin");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("keeps current frame routes across top-level navigation with process-swapping children", async () => {
  test.setTimeout(90000);
  const responses: MockResponse[] = [],
    provider = await startProvider(responses),
    opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const url = `${provider.origin}/complex`;
    responses.push(
      commandResponse("list_frames", {}, "before-navigation"),
      commandResponse("navigate", { url }, "market-navigation"),
      commandResponse(
        "inspect_page",
        { full: true, budget: 12000 },
        "after-navigation",
      ),
      commandResponse("reload", {}, "market-reload"),
      commandResponse(
        "inspect_page",
        { full: true, budget: 12000 },
        "after-reload",
      ),
      textResponse("NAVIGATION_CAPTURE_DONE"),
      textResponse("Navigation"),
    );
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await target.bringToFront();
    await opened.page
      .getByTestId("composer-input")
      .fill("Read page across navigation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "NAVIGATION_CAPTURE_DONE",
      { timeout: 75000 },
    );
    const events = await readEvents(opened.page);
    await test
      .info()
      .attach("canonical-events", {
        body: JSON.stringify(events, null, 2),
        contentType: "application/json",
      });
    for (const id of ["after-navigation", "after-reload"]) {
      const result = events.find(
        (e) =>
          ["tool.finished", "tool.failed"].includes(e.type) &&
          (e.toolCallId === id || e.toolCallId?.endsWith(":" + id)),
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        type: "tool.finished",
        output: { items: expect.any(Array) },
      });
      expect(JSON.stringify(result.output.items)).toContain("Frame action");
    }
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
