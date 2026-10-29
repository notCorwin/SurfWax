import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("program bridge preserves ordinary objects that resemble protocol tags and top-level undefined", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const value = {
      $date: "ordinary",
      $regexp: { source: "x", flags: "i" },
      $function: "ordinary",
      $remoteArgument: { id: "ordinary" },
      $remoteObject: { id: "ordinary" },
      $remoteFunction: "ordinary",
      $sparseArray: { length: 9, entries: [[1, "ordinary"]] },
      $plainObject: [["nested", { $date: "still ordinary" }]],
      extra: [1, { $date: "2020-01-01", extra: 42 }],
    };
    responses.push(
      commandResponse("execute_program", { code: `const value = ${JSON.stringify(value)}; return {fromArgument: await page.evaluate(x => x, value), fromPage: await page.evaluate(() => (${JSON.stringify(value)}))};` }, "tagged-objects"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { fromArgument: value, fromPage: value } });
        return commandResponse("execute_program", { code: "return undefined;" }, "undefined");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: null, resultType: "undefined" });
        return commandResponse("execute_program", { code: "const sparse = new Array(100000000); sparse[99999999] = {$date:'ordinary'}; await check(sparse); return true;", timeoutMs: 10000 }, "sparse-argument");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("execute_program", { code: "return {value: () => 42};" }, "function-data");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { message: expect.stringContaining("cannot serialize functions as data") } });
        return textResponse("PROGRAM_BRIDGE_VALUES_OK");
      },
      textResponse("Bridge values"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect program bridge values");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PROGRAM_BRIDGE_VALUES_OK", { timeout: 60_000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
