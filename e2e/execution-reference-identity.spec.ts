import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

for (const world of ["MAIN", "ISOLATED"] as const) test(`preserves non-JSON values in ${world} execution results`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const tabId = await opened.page.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, target.url());
    expect(tabId).toEqual(expect.any(Number));
    responses.push(
      commandResponse("evaluate_js", { tabId, world, code: "const item = {value:42}; return {first:item, second:item};" }, "shared"),
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ ok: true, result: { ref: expect.any(String), scope: "page" } });
        const reference = JSON.stringify(output.result.ref);
        return commandResponse("evaluate_js", { tabId, world, code: `const value = globalThis.__surfWaxObject(${reference}); return value.first === value.second && value.first.value === 42;` }, "shared-check");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("evaluate_js", { tabId, world, code: "return -0;" }, "negative-zero");
      },
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ ok: true, result: { ref: expect.any(String), preview: "-0", scope: "page" } });
        const reference = JSON.stringify(output.result.ref);
        return commandResponse("evaluate_js", { tabId, world, code: `return Object.is(globalThis.__surfWaxObject(${reference}), -0);` }, "negative-zero-check");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("evaluate_js", { tabId, world, code: 'const value = Object.create(null); Object.defineProperty(value, "item", {value:42, enumerable:true}); return value;' }, "descriptor");
      },
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ ok: true, result: { ref: expect.any(String), scope: "page" } });
        const reference = JSON.stringify(output.result.ref);
        return commandResponse("evaluate_js", { tabId, world, code: `const value = globalThis.__surfWaxObject(${reference}); const property = Object.getOwnPropertyDescriptor(value, "item"); return Object.getPrototypeOf(value) === null && property.value === 42 && !property.writable && !property.configurable;` }, "descriptor-check");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("evaluate_js", { tabId, world, code: 'return Object.freeze({value:42});' }, "frozen");
      },
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ ok: true, result: { ref: expect.any(String), scope: "page" } });
        const reference = JSON.stringify(output.result.ref);
        return commandResponse("evaluate_js", { tabId, world, code: `return Object.isFrozen(globalThis.__surfWaxObject(${reference}));` }, "frozen-check");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return textResponse("EXECUTION_REFERENCE_OK");
      },
      textResponse("Reference identity"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect values in the requested world");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EXECUTION_REFERENCE_OK", { timeout: 60000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
