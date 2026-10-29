import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("preserves object identity, cycles and shared buffers across jobs, artifacts and the worker bridge", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `const buffer = new ArrayBuffer(16);
        const view = new Uint8Array(buffer,4,3); view.set([7,8,9]);
        const x = {buffer, view, alias:view}; x.self = x; x.map = new Map([[x,view]]); x.set = new Set([x,view]);
        x.regex = /x/g; x.regex.lastIndex = x; x.sparse = new Array(1000000000); x.sparse[999999999] = x;
        x.nullObject = Object.create(null); x.nullObject.child = Object.create(null); x.nullObject.child.owner = x;
        x.array = [1]; x.array.label = x; x.date = new Date(0); x.date.owner = x; x.map.owner = x;
        x.buffer.owner = x; x.dataView = new DataView(buffer,2,8); x.dataView.owner = x;
        x.error = new TypeError('failure'); Object.defineProperty(x.error,'cause',{value:x}); x.error.owner = x;
        return x;` }, "create-graph"),
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ $ref: expect.any(Number), sidecarsDeferred: true });
        expect(output.pathsNote).toContain("Shared or cyclic");
        return commandResponse("execute_program", { timeoutMs: 30000, code: `const x = await artifacts.read(${output.$ref},{path:['result']});
          return { self:x.self===x, alias:x.alias===x.view, backing:x.view.buffer===x.buffer,
            offset:x.view.byteOffset===4, bytes:[...x.view].join(',')==='7,8,9',
            map:x.map.get(x)===x.view, set:x.set.has(x)&&x.set.has(x.view),
            regexp:x.regex.lastIndex===x, sparse:x.sparse[999999999]===x&&!Object.hasOwn(x.sparse,0),
            nulls:Object.getPrototypeOf(x.nullObject)===null && Object.getPrototypeOf(x.nullObject.child)===null && x.nullObject.child.owner===x,
            extras:x.array.label===x && x.date.owner===x && x.map.owner===x && x.buffer.owner===x && x.dataView.owner===x && x.dataView.buffer===x.buffer,
            error:x.error instanceof TypeError && x.error.message==='failure' && x.error.cause===x && x.error.owner===x };` }, "read-graph");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { self: true, alias: true, backing: true, offset: true, bytes: true, map: true, set: true, regexp: true, sparse: true, nulls: true, extras: true, error: true } });
        return commandResponse("execute_program", { code: "return new URL('https://example.com');" }, "unsupported-url");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { message: expect.stringContaining("cannot serialize this object type") } });
        return textResponse("PROGRAM_GRAPH_OK");
      },
      textResponse("Graph values"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect graph data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PROGRAM_GRAPH_OK", { timeout: 60000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
