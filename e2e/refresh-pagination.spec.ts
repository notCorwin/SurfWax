import { expect } from "@playwright/test";
import { test, commandResponse, configure, delayedResponse, dispose, openExtension, readEvents, startProvider, textResponse, type MockResponse } from "./fixtures";
import { SemanticPages } from "./evaluation/semantic-state";
import { itemLine } from "./snapshot-format";

/** A scripted provider consumes the actual refresh, metadata artifact, and frozen snapshot. */
test("restores long refresh metadata and continues a bounded snapshot in the same run", async () => {
  test.setTimeout(120_000);
  let releaseModel!: () => void, releaseLoad!: () => void;
  const modelMayFinish = new Promise<void>((resolve) => { releaseModel = resolve; });
  const loadMayFinish = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  const completeTitle = `TITLE_BEGIN_${"海🌊".repeat(3500)}_TITLE_END`;
  expect(Buffer.byteLength(completeTitle, "utf8")).toBeGreaterThan(16 * 1024);
  let problem: unknown, firstText = "", tabId = 0, currentCursor: string | undefined, pagesRead = 0;
  let titleAccess: any, titleLength = 0, title = "", titleReads = 0, pendingTitleId = "";
  const pages = new SemanticPages();
  const done = () => textResponse("REFRESH_PAGINATION_DONE");
  const consume: MockResponse = (request) => {
    if (!Array.isArray(request.tools)) { responses.unshift(consume); return textResponse("Refresh pagination"); }
    try {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      expect(message).toBeDefined();
      const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
      const page = JSON.parse(content);
      expect(page).toMatchObject({ tabId, mode: "full", items: expect.any(Array), truncation: expect.any(Object) });
      expect(page).not.toHaveProperty("error");
      expect(page).toMatchObject({ continuation: true });
      expect(page).not.toHaveProperty("url");
      expect(page).not.toHaveProperty("title");
      currentCursor = pages.append(page, currentCursor);
      pagesRead++;
      expect(pagesRead).toBeLessThan(30);
      if (currentCursor) {
        responses.unshift(consume);
        return commandResponse("inspect_page", { tabId, cursor: currentCursor, budget: 3000 }, `refresh-page-${pagesRead}`);
      }
      expect(pages.result().items.some((item) => itemLine(item).includes("REFRESH_PAGE_LAST_ITEM"))).toBe(true);
      expect(pages.result().items.some((item) => itemLine(item).includes("REFRESH_PAGE_LOADED_MARKER"))).toBe(true);
      return done();
    } catch (error) { problem = error; return done(); }
  };
  const consumeTitle: MockResponse = (request) => {
    if (!Array.isArray(request.tools) || !request.messages.some((entry: any) => entry.role === "tool" && entry.tool_call_id === pendingTitleId)) {
      responses.unshift(consumeTitle); return textResponse("Read the complete page title");
    }
    try {
      const message = request.messages.findLast((entry: any) => entry.role === "tool" && entry.tool_call_id === pendingTitleId);
      const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
      const result = JSON.parse(content);
      expect(result).toMatchObject({ ok: true, result: expect.any(String) });
      expect(result.result.length).toBeGreaterThan(0);
      title += result.result;
      expect(title.length).toBeLessThanOrEqual(titleLength);
      if (title.length < titleLength) return readTitle();
      expect(title).toBe(completeTitle);
      responses.unshift(consume);
      return commandResponse("inspect_page", { tabId, cursor: currentCursor, budget: 3000 }, "refresh-page-0");
    } catch (error) { problem = error; return done(); }
  };
  const readTitle = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> => {
    pendingTitleId = `refresh-title-${++titleReads}`;
    expect(titleReads).toBeLessThan(30);
    responses.unshift(consumeTitle);
    return commandResponse("read_artifact", { ...titleAccess, offset: title.length }, pendingTitleId);
  };
  const afterRefresh: MockResponse = (request) => {
    if (!Array.isArray(request.tools)) { responses.unshift(afterRefresh); return textResponse("Refresh pagination"); }
    try {
      const contents = request.messages.flatMap((message: any) => {
        if (message.role !== "user") return [];
        return typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
          ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text) : [];
      });
      firstText = contents.find((text: string) => text.startsWith("<page-refresh>"));
      expect(firstText).toEqual(expect.any(String));
      expect(Buffer.byteLength(firstText, "utf8")).toBeLessThan(16_000);
      const observation = JSON.parse(firstText.split("\n")[2]!);
      expect(observation).toMatchObject({ tabId: expect.any(Number), observationId: expect.any(String), mode: "full",
        nextCursor: expect.any(String), truncation: { truncated: true, budget: 12_000 } });
      expect(observation.truncation.used).toBeLessThanOrEqual(12_000);
      expect(firstText).not.toContain("REFRESH_PAGE_LAST_ITEM");
      expect(observation).toMatchObject({ metadataTruncated: expect.arrayContaining(["title"]), metadataOffsetUnit: "UTF-16",
        metadataLengths: { title: completeTitle.length }, metadataAccess: { title: { artifactId: expect.any(Number), path: ["title"], offset: 0, limit: 1000 } } });
      expect(observation.title.length).toBeLessThan(completeTitle.length);
      expect(completeTitle.startsWith(observation.title)).toBe(true);
      tabId = observation.tabId;
      currentCursor = pages.append(observation);
      expect(currentCursor).toBeTruthy();
      titleAccess = observation.metadataAccess.title; titleLength = observation.metadataLengths.title;
      return readTitle();
    } catch (error) { problem = error; return done(); }
  };
  responses.push(delayedResponse(textResponse("REFRESH_MODEL_BEFORE"), 0, modelMayFinish), afterRefresh, textResponse("Refresh pagination"));
  try {
    const target = await opened.context.newPage();
    let documents = 0;
    await target.route("**/refresh-pagination", async (route) => {
      documents++;
      const rows = Array.from({ length: 160 }, (_, index) => `<p>Record ${index}: ${"content ".repeat(14)}</p>`).join("");
      const body = documents === 1 ? "<!doctype html><title>Before</title><main>Initial</main>"
        : `<!doctype html><title>${completeTitle}</title><style>p{font:1px/3px monospace;margin:0}</style><main>${rows}<p>REFRESH_PAGE_LAST_ITEM</p><p id="loaded">not loaded</p></main><img src="/refresh-pagination-held"><script>window.addEventListener('load', () => {document.querySelector('#loaded').textContent = 'REFRESH_PAGE_LOADED_MARKER'})</script>`;
      await route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    await target.route("**/refresh-pagination-held", async (route) => { await loadMayFinish; await route.fulfill({ status: 204, body: "" }); });
    await target.goto(`${provider.origin}/refresh-pagination`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the refreshed page");
    await opened.page.getByTestId("composer-input").press("Enter");
    const agentRequests = () => provider.requests.filter((request) => Array.isArray(request.tools));
    await expect.poll(() => agentRequests().length).toBe(1);
    await target.reload({ waitUntil: "domcontentloaded" });
    expect(await target.evaluate(() => document.readyState)).toBe("interactive");
    releaseModel();
    await expect(opened.page.locator(".markdown-body")).toContainText(["REFRESH_MODEL_BEFORE"]);
    expect(agentRequests()).toHaveLength(1);
    releaseLoad();
    await target.waitForLoadState("load");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REFRESH_PAGINATION_DONE", { timeout: 90_000 });
    if (problem) throw problem;
    expect(pagesRead).toBeGreaterThan(1);
    expect(titleReads).toBeGreaterThan(1);
    expect(title).toBe(completeTitle);
    const events = await readEvents(opened.page);
    const refreshEvents = events.filter((event) => event.type === "conversation.message" && JSON.stringify(event).includes("<page-refresh>"));
    expect(refreshEvents).toHaveLength(1);
    expect(JSON.stringify(refreshEvents)).not.toContain("REFRESH_PAGE_LAST_ITEM");
  } finally {
    releaseModel(); releaseLoad();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
