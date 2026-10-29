import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("reads stored artifact paths without treating missing values as successful results", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let artifactId = 0;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { code: 'const sparse = new Array(4); sparse[0] = undefined; sparse[2] = null; sparse[3] = "last"; return {rows:["first", null, undefined], sparse, object:{result:null,resultType:"undefined"}, literal:{$type:"undefined",value:null}, large:"x".repeat(12000)};' }, "produce-artifact"),
      (request) => { const output = lastTool(request); artifactId = output.$ref; expect(artifactId).toEqual(expect.any(Number)); return commandResponse("read_artifact", { artifactId, path: ["result", "rows", 0] }, "read-value"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: "first" }); return commandResponse("read_artifact", { artifactId, path: ["result", "rows", 1] }, "read-null"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: null }); return commandResponse("read_artifact", { artifactId, path: ["result", "rows", 2] }, "read-undefined"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: null, resultType: "undefined" }); return commandResponse("read_artifact", { artifactId, path: ["result", "object"] }, "read-object"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: { result: null, resultType: "undefined" } }); return commandResponse("read_artifact", { artifactId, path: ["result", "literal"] }, "read-literal"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: { $type: "undefined", value: null } }); return commandResponse("read_artifact", { artifactId, path: ["result", "sparse"] }, "read-sparse"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: [null, null, null, "last"], undefinedPaths: [[0]], holePaths: [[1]] }); return commandResponse("read_artifact", { artifactId, path: ["result", "sparse"], offset: 1, limit: 3 }, "read-slice"); },
      (request) => { expect(lastTool(request)).toEqual({ ok: true, result: [null, null, "last"], holePaths: [[0]] }); return commandResponse("read_artifact", { artifactId, path: ["result", "rows", 3] }, "read-missing"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return commandResponse("read_artifact", { artifactId, path: ["result", "rows", "map"] }, "read-inherited"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return textResponse("ARTIFACT_PATHS_OK"); },
      textResponse("产物路径"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the stored data and check its missing paths");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_PATHS_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
