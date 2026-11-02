import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { SemanticPages } from "./evaluation/semantic-state";

/** Read the actual tool message delivered to the scripted model provider. */
function toolResult(request: any, id: string): any {
  const message = request.messages.findLast((item: any) => item.role === "tool" && item.tool_call_id === id);
  if (!message) throw new Error(`Missing result for ${id}`);
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

test("delivers snapshot pages inline even when the requested budget is oversized", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  const pages = new SemanticPages(), oversizedPages = new SemanticPages();
  let cursor: string | undefined, pending = "budget-page-0", pageCount = 0, largestPageBytes = 0, problem: unknown;
  let oversizedCursor: string | undefined, oversizedPageCount = 0;
  const done = () => textResponse("INSPECT_BUDGET_DONE");
  const after = (fn: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => {
    const callback: MockResponse = (request) => {
      if (!request.messages.some((item: any) => item.role === "tool" && item.tool_call_id === pending)) {
        responses.unshift(callback); return textResponse("Inspect the complete page");
      }
      try { return fn(toolResult(request, pending)); }
      catch (error) { problem = error; return done(); }
    };
    return callback;
  };
  const readOversized = () => {
    pending = `budget-oversized-${oversizedPageCount}`;
    responses.unshift(after((result) => {
      expect(result.$ref).toBeUndefined();
      expect(result.mode).toBe("full");
      expect(result.items).toEqual(expect.any(Array));
      oversizedCursor = oversizedPages.append(result, oversizedCursor);
      expect(++oversizedPageCount).toBeLessThan(50);
      return oversizedCursor ? readOversized() : done();
    }));
    return commandResponse("inspect_page", { budget: 100000, ...(oversizedCursor ? { cursor: oversizedCursor } : {}) }, pending);
  };
  const readPage = () => {
    pending = `budget-page-${pageCount}`;
    responses.unshift(after((result) => {
      expect(result.$ref).toBeUndefined();
      expect(result.mode).toBe("full");
      expect(result.items).toEqual(expect.any(Array));
      const bytes = Buffer.byteLength(JSON.stringify(result.items));
      expect(result.truncation.used).toBe(bytes);
      expect(bytes).toBeLessThanOrEqual(12000);
      largestPageBytes = Math.max(largestPageBytes, bytes);
      pageCount++;
      if (pageCount === 1) expect(result.nextCursor).toEqual(expect.any(String));
      cursor = pages.append(result, cursor);
      return cursor ? readPage() : readOversized();
    }));
    return commandResponse("inspect_page", { budget: 12000, ...(cursor ? { cursor } : {}) }, pending);
  };
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1500, height: 3500 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>body{margin:0}p{margin:0;height:24px;white-space:nowrap;font:10px monospace}</style><main></main>`;
      const main = document.querySelector("main")!;
      for (let index = 0; index < 80; index++) {
        const row = document.createElement("p");
        row.textContent = `PAGE_ROW_${String(index).padStart(3, "0")}_${"x".repeat(125)}${index === 79 ? "_FINAL_ROW" : ""}`;
        main.append(row);
      }
    });
    await expect(target.locator("p")).toHaveCount(80);
    const first = readPage();
    responses.unshift(first);
    responses.push(textResponse("Read the paginated page"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the complete page and the oversized observation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INSPECT_BUDGET_DONE", { timeout: 90_000 });
    if (problem) throw problem;

    const normal = pages.result();
    expect(pageCount).toBeGreaterThan(1);
    expect(largestPageBytes).toBeGreaterThan(8192);
    expect(normal.items.some((item) => item.line.includes("PAGE_ROW_079_") && item.line.includes("_FINAL_ROW"))).toBe(true);
    expect(oversizedPageCount).toBeGreaterThan(1);
    const oversized = oversizedPages.result();
    expect(oversized.items.some((item) => item.line.includes("PAGE_ROW_079_") && item.line.includes("_FINAL_ROW"))).toBe(true);
    expect(oversized.items).toEqual(normal.items);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
