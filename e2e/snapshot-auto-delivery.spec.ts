import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { applySemanticDelta, SemanticPages, type SemanticItem } from "./evaluation/semantic-state";

/** Observe exactly the result passed to the model provider. */
function toolResult(request: any, id: string): any {
  const message = request.messages.findLast((item: any) => item.role === "tool" && item.tool_call_id === id);
  if (!message) throw new Error(`Missing result for ${id}`);
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

test("delivers action snapshots transactionally and preserves actions when metadata is too large", async () => {
  test.setTimeout(150_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  const text = `VISIBLE_BEGIN_${"海🌊".repeat(2300)}_VISIBLE_END`;
  const rows = Array.from({ length: 100 }, (_, index) => `AUTO_ROW_${String(index).padStart(3, "0")}_${"x".repeat(140)}`);
  const initial = new SemanticPages(), changed = new SemanticPages(), fresh = new SemanticPages();
  let serial = 0, problem: unknown, baselineId = "", initialItems: SemanticItem[] = [], updated: SemanticItem[] = [];
  let initialPageCount = 0, observedOversized = false;
  const done = () => textResponse("AUTO_DELIVERY_DONE");

  const call = (name: string, input: object, accept: (value: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>) => {
    const id = `auto-delivery-${++serial}`;
    const receive: MockResponse = (request) => {
      if (!request.messages.some((item: any) => item.role === "tool" && item.tool_call_id === id)) {
        responses.unshift(receive); return textResponse("Continue reading the page");
      }
      try { return accept(toolResult(request, id)); }
      catch (error) { problem = error; return done(); }
    };
    responses.unshift(receive);
    return commandResponse(name, input, id);
  };

  const readRemaining = (pages: SemanticPages, cursor: string, complete: () => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("inspect_page", { cursor, budget: 30000 }, (page) => {
      expect(page.$ref).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      const next = pages.append(page, cursor);
      expect(++initialPageCount).toBeLessThan(80);
      return next ? readRemaining(pages, next, complete) : complete();
    });

  const compareFresh = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("inspect_page", { full: true, budget: 30000 }, (page) => {
      expect(page.$ref).toBeUndefined();
      const next = fresh.append(page);
      const compare = () => { expect(fresh.result().items).toEqual(updated); return done(); };
      return next ? readRemaining(fresh, next, compare) : compare();
    });
  const compareDelta = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("inspect_page", { budget: 30000 }, (page) => {
      expect(page.mode).toBe("delta");
      expect(page.baseObservationId).toBe(baselineId);
      const next = changed.append(page);
      const compare = () => {
        updated = applySemanticDelta(initialItems, changed.result().items);
        expect(updated.some((item) => item.line.includes("STATUS_2"))).toBe(true);
        expect(updated.some((item) => item.line.includes("STATUS_1"))).toBe(false);
        return compareFresh();
      };
      return next ? readRemaining(changed, next, compare) : compare();
    });
  const restoreTitle = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("click", { target: { by: "css", value: "#restore-title" } }, (result) => {
      expect(result).toMatchObject({ ok: true, pageSnapshot: { items: expect.any(Array) } });
      // Every delivered automatic snapshot advances the model's baseline too.
      const restored = new SemanticPages();
      const next = restored.append(result.pageSnapshot);
      const complete = () => {
        const baseline = restored.result();
        initialItems = result.pageSnapshot.mode === "delta" ? applySemanticDelta(initialItems, baseline.items) : baseline.items;
        baselineId = baseline.observationId;
        return compareDelta();
      };
      return next ? readRemaining(restored, next, complete) : complete();
    });
  const changeWithHugeTitle = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("click", { target: { by: "css", value: "#large-title" } }, (result) => {
      expect(result).toMatchObject({ ok: true, pageSnapshotStatus: { state: "unavailable" } });
      expect(result.pageSnapshot).toBeUndefined();
      observedOversized = true;
      return restoreTitle();
    });
  const finishInitial = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> => {
    const baseline = initial.result(); baselineId = baseline.observationId; initialItems = baseline.items;
    expect(initialItems.some((item) => item.line.includes(text))).toBe(true);
    expect(initialItems.some((item) => item.line.includes("STATUS_1"))).toBe(true);
    for (const row of rows) expect(initialItems.some((item) => item.line.includes(row))).toBe(true);
    return changeWithHugeTitle();
  };

  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1500, height: 3500 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(({ text, rows }) => {
      document.title = "Normal title";
      document.body.innerHTML = '<style>body{margin:0;font:10px monospace}p{margin:0;line-height:16px;white-space:nowrap}#long{white-space:normal;overflow-wrap:anywhere;line-height:12px}nav{position:fixed;top:0;right:0}</style><main><output>STATUS_0</output></main><nav><button id="initial">Start</button><button id="large-title">Change</button><button id="restore-title">Restore</button></nav>';
      const main = document.querySelector("main")!;
      rows.forEach((value) => { const row = document.createElement("p"); row.textContent = value; main.append(row); });
      const long = document.createElement("p"); long.id = "long"; long.textContent = text; main.append(long);
      document.querySelector("#initial")!.addEventListener("click", () => { document.querySelector("output")!.textContent = "STATUS_1"; });
      document.querySelector("#large-title")!.addEventListener("click", () => { document.querySelector("output")!.textContent = "STATUS_2"; document.title = "海🌊".repeat(7000); });
      document.querySelector("#restore-title")!.addEventListener("click", () => { document.title = "Normal title"; });
    }, { text, rows });
    const first = call("click", { target: { by: "css", value: "#initial" } }, (result) => {
      expect(result).toMatchObject({ ok: true, pageSnapshot: { items: expect.any(Array) } });
      const page = result.pageSnapshot;
      expect(Buffer.byteLength(JSON.stringify({ ...page, evidenceId: result.evidenceId }))).toBeLessThanOrEqual(16 * 1024);
      expect(page.truncation.used).toBeLessThanOrEqual(page.truncation.budget);
      const next = initial.append(page); initialPageCount = 1;
      expect(next).toEqual(expect.any(String));
      return readRemaining(initial, next!, finishInitial);
    });
    responses.unshift(first); responses.push(textResponse("Start and inspect the page"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Start the page and compare the changed state");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("AUTO_DELIVERY_DONE", { timeout: 130_000 });
    if (problem) throw problem;
    expect(initialPageCount).toBeGreaterThan(1);
    expect(observedOversized).toBe(true);
    expect(await target.locator("output")).toHaveText("STATUS_2");
    expect(await target.title()).toBe("Normal title");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
