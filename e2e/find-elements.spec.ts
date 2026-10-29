import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("preserves snapshot identities through reorder and removal, and expires them on navigation", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const targetPage = await opened.context.newPage();
    await targetPage.goto(`${provider.origin}/automation`);
    await targetPage.evaluate(() => {
      const root = document.createElement("div");
      root.id = "search-list";
      for (const key of ["a", "b", "c"]) {
        const button = document.createElement("button");
        button.className = "search-candidate";
        button.dataset.key = key;
        button.textContent = "Same label";
        button.onclick = () => { document.body.dataset.searchClicks = (document.body.dataset.searchClicks ?? "") + key; };
        root.append(button);
      }
      document.body.append(root);
    });
    const other = await opened.context.newPage();
    await other.goto(`${provider.origin}/target`);
    const [otherTab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/target`);
    expect(otherTab?.id).toEqual(expect.any(Number));
    const selector = { by: "css", value: ".search-candidate" };
    let firstRef = "", removedRef = "", thirdRef = "", cursor = "", staleCursor = "";
    responses.push(
      commandResponse("find_elements", { target: selector, limit: 2 }, "search-capture-removed"),
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ total: 3, hasMore: true, elements: [{ ref: expect.any(String) }, { ref: expect.any(String) }] });
        removedRef = page.elements[1].ref;
        return commandResponse("find_elements", { target: selector, limit: 1 }, "search-first");
      },
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ total: 3, hasMore: true, nextCursor: expect.any(String), elements: [{ ref: expect.any(String), name: "Same label" }] });
        firstRef = page.elements[0].ref;
        cursor = page.nextCursor;
        staleCursor = cursor;
        return commandResponse("execute_program", { code: `await page.evaluate(() => {
          const root = document.querySelector('#search-list');
          root.prepend(root.querySelector('[data-key="c"]'));
          root.querySelector('[data-key="b"]').remove();
          const replacement = document.createElement('button');
          replacement.className = 'search-candidate'; replacement.dataset.key = 'replacement'; replacement.textContent = 'Same label';
          replacement.onclick = () => { document.body.dataset.searchClicks = 'WRONG'; };
          root.append(replacement);
        });` }, "mutate-search");
      },
      () => commandResponse("click", { target: { ref: removedRef }, timeoutMs: 3_000 }, "search-removed-ref"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "detached" } });
        return commandResponse("find_elements", { target: selector, limit: 1, cursor }, "search-second");
      },
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ total: 3, hasMore: true, elements: [{ status: "detached" }], nextCursor: expect.any(String) });
        cursor = page.nextCursor;
        return commandResponse("find_elements", { target: selector, limit: 1, cursor }, "search-third");
      },
      (request) => {
        const page = lastTool(request);
        expect(page).toMatchObject({ total: 3, hasMore: false, elements: [{ ref: expect.any(String), name: "Same label" }] });
        thirdRef = page.elements[0].ref;
        expect(thirdRef).not.toBe(firstRef);
        return commandResponse("click", { target: { ref: firstRef } }, "click-first");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("click", { target: { ref: thirdRef } }, "click-third"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("execute_program", { code: "return await page.evaluate(() => document.body.dataset.searchClicks);" }, "check-search-clicks"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "ac" }); return commandResponse("click", { tabId: otherTab!.id, target: { ref: firstRef }, timeoutMs: 3_000 }, "other-tab-ref"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-ref" } }); return commandResponse("navigate", { url: `${provider.origin}/target` }, "search-navigate"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("find_elements", { target: selector, cursor: staleCursor, limit: 1 }, "search-stale-cursor"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-search" } }); return commandResponse("click", { target: { ref: firstRef }, timeoutMs: 3_000 }, "search-stale-ref"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-ref" } }); return textResponse("FIND_SNAPSHOT_OK"); },
      textResponse("查找元素"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await targetPage.bringToFront();
    await opened.page.getByTestId("composer-input").fill("find matching elements and act on the original results");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIND_SNAPSHOT_OK", { timeout: 45_000 });
    // The old document was navigated away only after both clicks. Capture the
    // dispatched identities from the execution log rather than its new body.
    const requests = provider.requests.filter((request) => request.tools);
    expect(JSON.stringify(requests)).toContain(firstRef);
    expect(JSON.stringify(requests)).toContain(thirdRef);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("finds stable nodes inside same-process and cross-origin frames", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const targetPage = await opened.context.newPage();
    await targetPage.goto(`${provider.origin}/complex`);
    const same = targetPage.frameLocator('iframe[src="/same-frame"]');
    const crossFrame = targetPage.frames().find((frame) => frame.url().includes("localhost"))!;
    const sameFrame = targetPage.frames().find((frame) => frame.url().includes("same-frame"))!;
    for (const frame of [sameFrame, crossFrame]) {
      await frame.evaluate(() => {
        const root = document.createElement("div");
        root.id = "frame-search-list";
        for (const key of ["first", "second"]) {
          const button = document.createElement("button");
          button.className = "frame-search-candidate";
          button.dataset.key = key;
          button.textContent = "Frame candidate";
          button.onclick = () => { document.body.dataset.frameSearchClick = key; };
          root.append(button);
        }
        document.body.append(root);
      });
    }
    const sameTarget = { by: "css", value: ".frame-search-candidate", frame: { by: "css", value: 'iframe[src="/same-frame"]' } };
    const crossTarget = { by: "css", value: ".frame-search-candidate", frame: { by: "css", value: "iframe[src*=localhost]" } };
    let sameRef = "", crossRef = "";
    responses.push(
      commandResponse("find_elements", { target: sameTarget, limit: 1 }, "same-search"),
      (request) => { const page = lastTool(request); expect(page).toMatchObject({ total: 2, hasMore: true, elements: [{ ref: expect.any(String) }] }); sameRef = page.elements[0].ref; return commandResponse("execute_program", { code: `await page.frameLocator('iframe[src="/same-frame"]').locator('#frame-search-list').evaluate(root => root.prepend(root.lastElementChild));` }, "same-reorder"); },
      () => commandResponse("click", { target: { ref: sameRef } }, "same-click"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("find_elements", { target: crossTarget, limit: 1 }, "cross-search"); },
      (request) => { const page = lastTool(request); expect(page).toMatchObject({ total: 2, hasMore: true, elements: [{ ref: expect.any(String) }] }); crossRef = page.elements[0].ref; expect(crossRef).not.toBe(sameRef); return commandResponse("execute_program", { code: `await page.frameLocator('iframe[src*=localhost]').locator('#frame-search-list').evaluate(root => root.prepend(root.lastElementChild));` }, "cross-reorder"); },
      () => commandResponse("click", { target: { ref: crossRef } }, "cross-click"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("FRAME_FIND_OK"); },
      textResponse("查找框架元素"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await targetPage.bringToFront();
    await opened.page.getByTestId("composer-input").fill("find and click the original item in each frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_FIND_OK", { timeout: 45_000 });
    await expect(same.locator("body")).toHaveAttribute("data-frame-search-click", "first");
    await expect(crossFrame.locator("body")).toHaveAttribute("data-frame-search-click", "first");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
