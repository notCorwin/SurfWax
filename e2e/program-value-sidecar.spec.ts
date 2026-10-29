import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("preserves undefined and holes in program results, including compacted results", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { code: 'return {missing:undefined, rows:[,undefined,null], undefinedPaths:["ordinary"], nan:NaN, zero:-0, big:123n, literal:{$type:"bigint",value:"123"}};' }, "small"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { missing: null, rows: [null, null, null], undefinedPaths: ["ordinary"], nan: null, zero: null, big: null, literal: { $type: "bigint", value: "123" } },
          undefinedPaths: [["missing"], ["rows", 1]], holePaths: [["rows", 0]], numberPaths: [{ path: ["nan"], value: "NaN" }, { path: ["zero"], value: "-0" }], bigintPaths: [{ path: ["big"], value: "123" }] });
        return commandResponse("execute_program", { code: 'const rows = new Array(2500); for(let i=1;i<rows.length;i+=2) rows[i]=undefined; rows[0]=123n; rows[2]=NaN; return rows;' }, "large");
      },
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ $ref: expect.any(Number), undefinedCount: 1250, holeCount: 1248, numberCount: 1, bigintCount: 1,
          undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 }, holePathsAccess: { path: ["holePaths"], offset: 0 } });
        return commandResponse("execute_program", { code: `const value = await artifacts.read(${output.$ref}, {path:['result',0]}); return typeof value === 'bigint' && value === 123n;` }, "native-bigint");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        const output = request.messages.findLast((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("undefinedPathsAccess"));
        const data = JSON.parse(Array.isArray(output.content) ? output.content.find((part: any) => part.type === "text").text : output.content);
        return commandResponse("read_artifact", { ...data.undefinedPathsAccess, limit: 2 }, "undefined-paths");
      },
      (request) => {
        expect(lastTool(request)).toEqual({ ok: true, result: [[1], [3]] });
        return textResponse("PROGRAM_VALUE_SIDECAR_OK");
      },
      textResponse("产物数据"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the program results");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PROGRAM_VALUE_SIDECAR_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("pages a large sparse result before building type sidecars", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    let artifactId = 0;
    responses.push(
      commandResponse("execute_program", { code: "const rows = new Array(1000000000); rows[1]=undefined; rows[2]=NaN; rows[4]=123n; rows[5]=undefined; rows[999999999]='last'; return rows;" }, "large-sparse"),
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ $ref: expect.any(Number), sidecarsDeferred: true, resultAccess: { path: ["result"], offset: 0, limit: 25 } });
        expect(JSON.stringify(output).length).toBeLessThan(2000);
        artifactId = output.$ref;
        return commandResponse("read_artifact", { ...output.resultAccess, limit: 6 }, "sparse-slice");
      },
      (request) => {
        expect(lastTool(request)).toEqual({ ok: true, result: Array(6).fill(null), undefinedPaths: [[1], [5]], holePaths: [[0], [3]],
          numberPaths: [{ path: [2], value: "NaN" }], bigintPaths: [{ path: [4], value: "123" }] });
        return commandResponse("execute_program", { code: `const rows = await artifacts.read(${artifactId}, {path:['result'],offset:0,limit:6}); return !Object.hasOwn(rows,0) && Object.hasOwn(rows,1) && Number.isNaN(rows[2]) && rows[4] === 123n;` }, "native-sparse");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("execute_program", { code: `const rows = await artifacts.read(${artifactId}, {path:['result'],offset:1}); return rows.length === 999999999 && Object.hasOwn(rows,0) && rows[0] === undefined && !Object.hasOwn(rows,2) && rows[999999998] === 'last';` }, "native-unbounded-suffix");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("read_artifact", { artifactId, path: ["result"], offset: 1 }, "unbounded-suffix");
      },
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ sidecarsDeferred: true, resultAccess: { path: ["result"], offset: 0 } });
        return commandResponse("read_artifact", { ...output.resultAccess, limit: 5 }, "suffix-page");
      },
      (request) => {
        expect(lastTool(request)).toEqual({ ok: true, result: Array(5).fill(null), undefinedPaths: [[0], [4]], holePaths: [[2]],
          numberPaths: [{ path: [1], value: "NaN" }], bigintPaths: [{ path: [3], value: "123" }] });
        return textResponse("SPARSE_PAGING_OK");
      },
      textResponse("产物数据"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the sparse result");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SPARSE_PAGING_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
