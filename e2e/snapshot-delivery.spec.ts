import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { applySemanticDelta, SemanticPages, type SemanticItem } from "./evaluation/semantic-state";

/** Only consume the actual tool result delivered to the scripted provider. */
function toolResult(request: any, id: string): any {
  const message = request.messages.findLast((item: any) => item.role === "tool" && item.tool_call_id === id);
  if (!message) throw new Error(`Missing result for ${id}`);
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

test("delivers every large snapshot page inline before completing a baseline", async () => {
  test.setTimeout(150_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  const longText = `UNICODE_START_${"海🌊".repeat(2500)}_UNICODE_END`;
  const rowText = (index: number) => `ROW_${String(index).padStart(3, "0")}_${"x".repeat(170)}`;
  let problem: unknown, serial = 0, baselineId = "", baseline: SemanticItem[] = [], updated: SemanticItem[] = [];
  let fullPageCount = 0, fullFragmentCount = 0, deltaPageCount = 0, freshPageCount = 0;
  const done = () => textResponse("SNAPSHOT_DELIVERY_DONE");

  const call = (name: string, input: object, accept: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>) => {
    const id = `snapshot-delivery-${++serial}`;
    const receive: MockResponse = (request) => {
      if (!request.messages.some((item: any) => item.role === "tool" && item.tool_call_id === id)) {
        responses.unshift(receive); return textResponse("Continue reading the snapshot");
      }
      try { return accept(toolResult(request, id)); }
      catch (error) { problem = error; return done(); }
    };
    responses.unshift(receive);
    return commandResponse(name, input, id);
  };

  const capture = (kind: "full" | "delta" | "fresh"): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> => {
    const pages = new SemanticPages();
    let cursor: string | undefined, count = 0;
    const next = (): ReturnType<typeof commandResponse> | ReturnType<typeof textResponse> =>
      call("inspect_page", { budget: 30000, limit: 100, ...(cursor ? { cursor } : kind === "delta" ? { since: baselineId } : {}) }, (result) => {
        expect(result.$ref, "A snapshot page must arrive in the tool message, not as an unread artifact").toBeUndefined();
        expect(result.items).toEqual(expect.any(Array));
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
        expect(Buffer.byteLength(JSON.stringify(result.items))).toBeLessThanOrEqual(result.truncation.budget);
        cursor = pages.append(result, cursor);
        expect(++count).toBeLessThan(100);
        if (cursor) return next();
        const observation = pages.result();
        if (kind === "full") {
          fullPageCount = count; fullFragmentCount = pages.fragments;
          expect(observation.mode).toBe("full");
          baselineId = observation.observationId; baseline = observation.items;
          for (let index = 0; index < 150; index++) expect(baseline.some((item) => item.line.includes(rowText(index)))).toBe(true);
          expect(baseline.some((item) => item.line.includes(longText))).toBe(true);
          return call("click", { target: { by: "css", value: "#change-snapshot" } }, (outcome) => {
            expect(outcome).toMatchObject({ ok: true });
            return capture("delta");
          });
        }
        if (kind === "delta") {
          deltaPageCount = count;
          expect(observation.mode).toBe("delta");
          updated = applySemanticDelta(baseline, observation.items);
          expect(updated.some((item) => item.line.includes("ROW_074_CHANGED"))).toBe(true);
          expect(updated.some((item) => item.line.includes(rowText(74)))).toBe(false);
          return capture("fresh");
        }
        freshPageCount = count;
        expect(observation.mode).toBe("full");
        expect(observation.items).toEqual(updated);
        return done();
      });
    return next();
  };

  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1500, height: 4000 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(({ longText, rows }) => {
      document.body.innerHTML = '<style>body{margin:0;font:10px monospace}p{margin:0;line-height:16px;white-space:nowrap}#long{white-space:normal;overflow-wrap:anywhere;line-height:12px}button{position:fixed;top:0;right:0}</style><main></main><button id="change-snapshot">Change one row</button>';
      const main = document.querySelector("main")!;
      rows.forEach((text, index) => { const row = document.createElement("p"); row.dataset.index = String(index); row.textContent = text; main.append(row); });
      const long = document.createElement("p"); long.id = "long"; long.textContent = longText; main.append(long);
      document.querySelector("button")!.addEventListener("click", () => { document.querySelector('[data-index="74"]')!.textContent = "ROW_074_CHANGED"; });
    }, { longText, rows: Array.from({ length: 150 }, (_, index) => rowText(index)) });
    const first = capture("full"); responses.unshift(first); responses.push(textResponse("Read the entire page"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the page, change the specified row, and compare snapshots");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SNAPSHOT_DELIVERY_DONE", { timeout: 130_000 });
    if (problem) throw problem;
    expect(fullPageCount).toBeGreaterThan(1);
    expect(fullFragmentCount).toBeGreaterThan(0);
    expect(deltaPageCount).toBeGreaterThan(0);
    expect(freshPageCount).toBeGreaterThan(1);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
