import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { applySemanticDelta, SemanticPages, type SemanticItem } from "./evaluation/semantic-state";

function resultFor(request: any, id: string): any {
  const message = request.messages.findLast((item: any) => item.role === "tool" && item.tool_call_id === id);
  if (!message) throw new Error(`Missing result for ${id}`);
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

test("preview exposes a later target without changing frozen pagination or delta", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  const budget = 1600, label = `LONG_LABEL_BEGIN_${"longtext".repeat(850)}_LONG_LABEL_END`;
  const complete = () => textResponse("LOOKAHEAD_DONE");
  let serial = 0, problem: unknown, first: any, previewTarget: any, clicked: any, delta: any;
  const initial = new SemanticPages(), small = new SemanticPages(), limited = new SemanticPages(), deltaPages = new SemanticPages();
  const initialPages: any[] = [], smallPages: any[] = [], limitedPages: any[] = [];
  let firstLabelPrefix = "", limitedLabelPrefix = "";

  const call = (tool: string, input: object, accept: (value: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>) => {
    const id = `lookahead-${++serial}`;
    const callback: MockResponse = (request) => {
      if (!request.messages.some((item: any) => item.role === "tool" && item.tool_call_id === id)) {
        responses.unshift(callback); return textResponse("Continue the page inspection");
      }
      try { return accept(resultFor(request, id)); }
      catch (error) { problem = error; return complete(); }
    };
    responses.unshift(callback);
    return commandResponse(tool, input, id);
  };
  const page = (pages: SemanticPages, received: any[], cursor: string, continuation: () => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
    call("inspect_page", { cursor, budget: 5000 }, (value) => {
      expect(value.$ref).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(value.items))).toBeLessThanOrEqual(5000);
      expect(value.lookahead?.items ?? []).toEqual([]);
      received.push(value);
      const next = pages.append(value, cursor);
      expect(received.length).toBeLessThan(50);
      return next ? page(pages, received, next, continuation) : continuation();
    });
  const finishLimit = () => {
    const result = limited.result();
    const long = result.items.find((item) => item.line.includes("LONG_LABEL_BEGIN_"));
    expect(long?.line).toContain(label);
    expect(long!.line.slice(0, 255)).toBe(firstLabelPrefix);
    expect(limitedLabelPrefix).toBe(firstLabelPrefix);
    expect(result.items.some((item) => item.line.includes('button "Unique action"'))).toBe(true);
    return complete();
  };
  const beginLimit = () => call("inspect_page", { full: true, budget: 5000, limit: 1 }, (value) => {
    expect(value.lookahead?.items ?? []).toEqual([]);
    expect(value.items.length).toBeLessThanOrEqual(1);
    limitedPages.push(value);
    const cursor = limited.append(value);
    expect(cursor).toEqual(expect.any(String));
    return page(limited, limitedPages, cursor!, () => {
      const fragment = limitedPages.flatMap((entry) => entry.items).find((item: any) => item.line.includes("LONG_LABEL_BEGIN_"));
      expect(fragment?.line.length).toBeGreaterThan(256);
      limitedLabelPrefix = fragment.line.slice(0, 255);
      return finishLimit();
    });
  });
  const beginSmall = () => call("inspect_page", { full: true, budget: 100 }, (value) => {
    expect(value.$ref).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(value.items))).toBeLessThanOrEqual(100);
    smallPages.push(value);
    const cursor = small.append(value);
    expect(cursor).toEqual(expect.any(String));
    return page(small, smallPages, cursor!, () => {
      expect(small.result().items.some((item) => item.line.includes(label))).toBe(true);
      expect(small.result().items.some((item) => item.line.includes('button "Unique action"'))).toBe(true);
      return beginLimit();
    });
  });
  const afterDelta = () => {
    const reconstructed = applySemanticDelta(initial.result().items, deltaPages.result().items);
    expect(reconstructed.some((item) => item.line.includes(label))).toBe(true);
    expect(reconstructed.some((item) => item.line.includes("STATUS_DONE"))).toBe(true);
    expect(reconstructed.some((item) => item.line.includes("STATUS_READY"))).toBe(false);
    return beginSmall();
  };
  const beginDelta = () => call("inspect_page", { since: first.observationId, budget: 5000 }, (value) => {
    delta = value;
    expect(value).toMatchObject({ mode: "delta", baseObservationId: first.observationId });
    expect(value.lookahead?.items ?? []).toEqual([]);
    const cursor = deltaPages.append(value);
    return cursor ? page(deltaPages, [], cursor, afterDelta) : afterDelta();
  });
  const afterInitial = () => {
    const baseline = initial.result().items;
    expect(initialPages.at(-1).truncation.baselineComplete).toBe(true);
    expect(baseline.some((item) => item.line.includes(label))).toBe(true);
    expect(baseline.some((item) => item.line.includes("STATUS_READY"))).toBe(true);
    expect(baseline.some((item) => item.line.includes("STATUS_DONE"))).toBe(false);
    expect(baseline[previewTarget.index]).toMatchObject({ id: previewTarget.id, line: previewTarget.line, ref: expect.any(String) });
    const fragment = initialPages.flatMap((entry) => entry.items).find((item: any) => item.line.includes("LONG_LABEL_BEGIN_"));
    expect(fragment?.line.length).toBeGreaterThan(256);
    firstLabelPrefix = fragment.line.slice(0, 255);
    expect(baseline.find((item) => item.line.includes(label))?.line.slice(0, 255)).toBe(firstLabelPrefix);
    return call("click", { target: { by: "role", value: "button", name: "Unique action", exact: true } }, (outcome) => {
      clicked = outcome;
      expect(outcome).toMatchObject({ ok: true });
      return beginDelta();
    });
  };
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 900 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate((text) => {
      // Keep the entire long text and status on screen; pagination is about the
      // wire budget, not about exposing content beyond the current viewport.
      document.body.innerHTML = '<style>p{margin-top:60px;width:1100px;font:1px/2px monospace;overflow-wrap:anywhere}button{position:fixed;top:4px;left:4px}</style><main><p></p><button>Unique action</button><output>STATUS_READY</output></main>';
      document.querySelector("p")!.textContent = text;
      document.querySelector("button")!.addEventListener("click", () => { document.querySelector("output")!.textContent = "STATUS_DONE"; });
    }, label);
    const begin = call("inspect_page", { full: true, budget, limit: 100 }, (value) => {
      first = value;
      expect(value).toMatchObject({ mode: "full", items: expect.any(Array), lookahead: { items: expect.any(Array) } });
      expect(value.$ref).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify({ items: value.items, lookahead: value.lookahead }))).toBeLessThanOrEqual(budget);
      expect(value.items.length + value.lookahead.items.length).toBeLessThanOrEqual(100);
      expect(value.truncation.baselineComplete).toBe(false);
      initialPages.push(value);
      const cursor = initial.append(value);
      expect(cursor).toEqual(expect.any(String));
      previewTarget = value.lookahead.items.find((item: SemanticItem) => item.line.includes('button "Unique action"'));
      expect(previewTarget).toMatchObject({ index: expect.any(Number), id: expect.any(String) });
      expect(value.lookahead.items.every((item: SemanticItem) => item.ref === undefined)).toBe(true);
      expect(value.items.some((item: SemanticItem) => item.id === previewTarget.id)).toBe(false);
      return page(initial, initialPages, cursor!, afterInitial);
    });
    responses.unshift(begin); responses.push(textResponse("Inspect the page"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page and activate the unique action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LOOKAHEAD_DONE", { timeout: 100_000 });
    if (problem) throw problem;
    expect(clicked).toMatchObject({ ok: true });
    expect(delta.mode).toBe("delta");
    expect(await target.locator("output")).toHaveText("STATUS_DONE");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
