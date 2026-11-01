import { expect } from "@playwright/test";
import { test, commandResponse, configure, delayedResponse, dispose, openExtension, readEvents, startProvider, textResponse, type MockResponse } from "./fixtures";
import { SemanticPages } from "./evaluation/semantic-state";

/** A scripted provider consumes the actual refresh and its real inspect_page continuations. */
test("continues a bounded refresh snapshot in the same run", async () => {
  test.setTimeout(120_000);
  let releaseModel!: () => void, releaseLoad!: () => void;
  const modelMayFinish = new Promise<void>((resolve) => { releaseModel = resolve; });
  const loadMayFinish = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let problem: unknown, firstText = "", tabId = 0, currentCursor: string | undefined, pagesRead = 0;
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
      currentCursor = pages.append(page, currentCursor);
      pagesRead++;
      expect(pagesRead).toBeLessThan(30);
      if (currentCursor) {
        responses.unshift(consume);
        return commandResponse("inspect_page", { tabId, cursor: currentCursor, budget: 3000 }, `refresh-page-${pagesRead}`);
      }
      expect(pages.result().items.some((item) => item.line.includes("REFRESH_PAGE_LAST_ITEM"))).toBe(true);
      expect(pages.result().items.some((item) => item.line.includes("REFRESH_PAGE_LOADED_MARKER"))).toBe(true);
      return done();
    } catch (error) { problem = error; return done(); }
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
      tabId = observation.tabId;
      currentCursor = pages.append(observation);
      expect(currentCursor).toBeTruthy();
      responses.unshift(consume);
      return commandResponse("inspect_page", { tabId, cursor: currentCursor, budget: 3000 }, "refresh-page-0");
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
        : `<!doctype html><title>After</title><main>${rows}<p>REFRESH_PAGE_LAST_ITEM</p><p id="loaded">not loaded</p></main><img src="/refresh-pagination-held"><script>window.addEventListener('load', () => {document.querySelector('#loaded').textContent = 'REFRESH_PAGE_LOADED_MARKER'})</script>`;
      await route.fulfill({ contentType: "text/html", body });
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
    const events = await readEvents(opened.page);
    const refreshEvents = events.filter((event) => event.type === "conversation.message" && JSON.stringify(event).includes("<page-refresh>"));
    expect(refreshEvents).toHaveLength(1);
    expect(JSON.stringify(refreshEvents)).not.toContain("REFRESH_PAGE_LAST_ITEM");
  } finally {
    releaseModel(); releaseLoad();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
