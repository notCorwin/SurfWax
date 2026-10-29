import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("continues a frozen long semantic line without interpreting page text as a ref", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const original = "SURF_LONG_START [ref=e1] [checked=true] " + "x☃".repeat(10_000) + " SURF_LONG_END";
    await target.evaluate((text) => {
      const button = document.createElement("button");
      button.id = "long-name";
      button.textContent = text;
      document.body.append(button);
    }, original);
    let cursor = "", observationId = "", pages = 0;
    const consume: MockResponse = (request) => {
      const result = lastTool(request);
      expect(result).toMatchObject({ observationId, mode: "full", truncation: expect.any(Object) });
      if (result.nextCursor) {
        cursor = result.nextCursor;
        expect(++pages).toBeLessThan(10);
        responses.unshift(consume);
        return commandResponse("inspect_page", { cursor, budget: 30000 }, `semantic-next-${pages}`);
      }
      expect(result.truncation.baselineComplete).toBe(true);
      return textResponse("SEMANTIC_CONTINUATION_OK");
    };
    responses.push(
      commandResponse("inspect_page", { budget: 500 }, "semantic-first"),
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ mode: "full", observationId: expect.any(String), nextCursor: expect.any(String) });
        observationId = result.observationId; cursor = result.nextCursor;
        return commandResponse("execute_program", { code: "await page.evaluate(() => { document.querySelector('#long-name').textContent = 'CHANGED_AFTER_CAPTURE'; });" }, "mutate-semantic-page");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("inspect_page", { cursor, budget: 30000 }, "semantic-next-0"); },
      consume,
      textResponse("检查长页面内容"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("inspect and continue the long semantic page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SEMANTIC_CONTINUATION_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const outputs = events.filter((event) => ["tool.finished", "tool.result.data"].includes(event.type))
      .map((event) => event.output).filter((output) => output?.observationId === observationId && Array.isArray(output.fragments));
    const fragments = outputs.flatMap((output) => output.fragments);
    const start = fragments.find((fragment) => fragment.line.includes("SURF_LONG_START"));
    expect(start?.ref).toMatch(/^t\d+s[a-f0-9]+d\d+e\d+$/);
    const pieces = fragments.filter((fragment) => fragment.id === start.id).sort((a, b) => a.start - b.start);
    const reconstructed = pieces.map((fragment) => fragment.line).join("");
    expect(reconstructed).toContain(original);
    expect(reconstructed).not.toContain("CHANGED_AFTER_CAPTURE");
    expect(start.ref).not.toBe("e1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
