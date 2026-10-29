import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("discovers nested frames and uses their references for browser actions", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const targetPage = await opened.context.newPage();
    await targetPage.goto(`${provider.origin}/complex`);
    const cross = targetPage.frames().find((frame) => frame.url().includes("localhost"))!;
    const same = targetPage.frames().find((frame) => frame.url().includes("/same-frame"))!;
    for (const frame of [targetPage.mainFrame(), same]) {
      await frame.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Identical label";
        button.onclick = () => { document.body.dataset.sameFrameClick = "yes"; };
        document.body.append(button);
      });
    }
    await cross.evaluate((url) => {
      const nested = document.createElement("iframe");
      nested.src = url;
      document.body.append(nested);
    }, `${provider.origin}/same-frame?nested=1`);
    await expect.poll(() => targetPage.frames().some((frame) => frame.url().includes("nested=1"))).toBe(true);
    const found: any[] = [];
    let sameRef = "", crossRef = "", nestedRef = "", oldCursor = "", count = 0;
    const consumeFrames: MockResponse = (request) => {
      const page = lastTool(request);
      expect(page).toMatchObject({ tabId: expect.any(Number), documentId: expect.any(Number), total: 4, frames: expect.any(Array), hasMore: expect.any(Boolean) });
      found.push(...page.frames);
      if (page.hasMore) {
        oldCursor ||= page.nextCursor;
        responses.unshift(consumeFrames);
        return commandResponse("list_frames", { limit: 1, cursor: page.nextCursor }, `frame-list-${++count}`);
      }
      const sameInfo = found.find((frame) => typeof frame.url === "string" && frame.url.endsWith("/same-frame"));
      expect(sameInfo?.frameRef).toEqual(expect.any(String));
      sameRef = sameInfo.frameRef;
      const crossInfo = found.find((frame) => typeof frame.url === "string" && frame.url.includes("localhost") && frame.url.includes("/frame"));
      const nestedInfo = found.find((frame) => typeof frame.url === "string" && frame.url.includes("nested=1"));
      expect(crossInfo?.frameRef).toEqual(expect.any(String));
      expect(nestedInfo).toMatchObject({ frameRef: expect.any(String), parentFrameRef: crossInfo.frameRef });
      crossRef = crossInfo.frameRef; nestedRef = nestedInfo.frameRef;
      return commandResponse("find_elements", { target: { by: "role", value: "button", name: "Identical label", frame: { ref: sameRef } } }, "find-same-frame");
    };
    responses.push(
      commandResponse("list_frames", { limit: 1 }, "list-first-frame"),
      consumeFrames,
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ total: 1, elements: [{ ref: expect.any(String), role: "button" }] }); return commandResponse("click", { target: { ref: result.elements[0].ref } }, "click-same-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("find_elements", { target: { by: "role", value: "button", name: "Frame action", frame: { ref: crossRef } } }, "find-discovered-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ total: 1, elements: [{ ref: expect.any(String), role: "button" }] }); return commandResponse("click", { target: { by: "role", value: "button", name: "Frame action", frame: { ref: crossRef } } }, "click-discovered-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("read_text", { target: { by: "css", value: "main", frame: { ref: nestedRef } } }, "read-nested-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "same origin" }); return commandResponse("execute_program", { code: "await page.evaluate(() => document.querySelector('iframe[src*=localhost]').remove());" }, "remove-cross-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("find_elements", { target: { by: "css", value: "main", frame: { ref: nestedRef } }, timeoutMs: 3000 }, "stale-frame-ref"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-frame" } }); return commandResponse("list_frames", { limit: 1, cursor: oldCursor }, "stale-frame-cursor"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return textResponse("FRAME_DISCOVERY_OK"); },
      textResponse("查找页面框架"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await targetPage.bringToFront();
    await opened.page.getByTestId("composer-input").fill("discover nested frames and use their references");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_DISCOVERY_OK", { timeout: 45_000 });
    expect(await targetPage.locator("body").getAttribute("data-same-frame-click")).toBeNull();
    expect(await same.locator("body").getAttribute("data-same-frame-click")).toBe("yes");
    expect(crossRef).toBeTruthy();
    expect(nestedRef).toBeTruthy();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
