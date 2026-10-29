import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("page and cross-origin locator evaluate preserve native object graphs", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `
        const shared = { count: 123n }, buffer = new ArrayBuffer(8);
        const value = { first: shared, second: shared, buffer, view: new Uint8Array(buffer, 2, 3), date: new Date(0), map: new Map(), set: new Set([undefined, NaN]), sparse: [,undefined] };
        value.self = value; value.map.set(shared, value); value.view.set([7,8,9]); value.sparse.extra = 'kept';
        value.date.note = shared; value.map.extra = shared; value.dictionary = Object.assign(Object.create(null), {entry: shared});
        value.error = new TypeError('details', {cause: shared});
        const result = await page.evaluate(arg => {
          if (arg.self !== arg || arg.first !== arg.second || arg.first.count !== 123n || arg.map.get(arg.first) !== arg ||
              arg.view.buffer !== arg.buffer || arg.view.byteOffset !== 2 || arg.view[0] !== 7 || !(arg.date instanceof Date) ||
              !arg.set.has(undefined) || !arg.set.has(NaN) || 0 in arg.sparse || !(1 in arg.sparse) || arg.sparse.extra !== 'kept' ||
              arg.date.note !== arg.first || arg.map.extra !== arg.first || Object.getPrototypeOf(arg.dictionary) !== null || arg.dictionary.entry !== arg.first ||
              !(arg.error instanceof TypeError) || arg.error.message !== 'details' || arg.error.cause !== arg.first) throw new Error('bad page input graph');
          const shared = { n: 9n }, buffer = new ArrayBuffer(6);
          const output = { a: shared, b: shared, map: new Map(), buffer, view: new Uint8Array(buffer, 1, 2), date: new Date(0), missing: undefined, number: -0 };
          output.self = output; output.map.set(shared, output); output.view[0] = 77; output.date.note = shared;
          output.error = new TypeError('returned', {cause: shared}); return output;
        }, value);
        const frame = await page.frameLocator('iframe[src*=localhost]').locator('button').evaluate((element, arg) => {
          const returned = { element: element.textContent, input: arg.first === arg.second && arg.self === arg && arg.map.get(arg.first) === arg };
          returned.self = returned; return returned;
        }, value);
        const foreign = await page.evaluate(() => {
          const realm = document.querySelector('iframe[src="/same-frame"]').contentWindow;
          const shared = realm.JSON.parse('{"value":7}');
          const graph = new realm.Object(); graph.a = shared; graph.b = shared; graph.self = graph;
          graph.date = new realm.Date(0); graph.date.getTime = 'user';
          graph.rx = new realm.RegExp('a+', 'gi'); Object.defineProperty(graph.rx, 'source', {value:'user', enumerable:true}); Object.defineProperty(graph.rx, 'flags', {value:'user', enumerable:true});
          graph.map = new realm.Map([[shared, 'real']]); graph.set = new realm.Set([shared]);
          Object.defineProperty(graph.map, Symbol.iterator, {value:function*(){yield ['fake', -1]}});
          Object.defineProperty(graph.set, Symbol.iterator, {value:function*(){yield 'fake'}});
          graph.buffer = new realm.ArrayBuffer(6); graph.view = new realm.Uint8Array(graph.buffer, 1, 2); graph.view[0] = 88;
          return graph;
        });
        const patched = await page.evaluate(() => {
          window.__savedMapEntries = Map.prototype.entries; window.__savedSetValues = Set.prototype.values;
          window.__savedGlobalGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global');
          window.__savedSubarray = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'subarray');
          Map.prototype.entries = function* () { yield ['fake', -1]; }; Set.prototype.values = function* () { yield 'fake'; };
          Object.defineProperty(RegExp.prototype, 'global', { configurable:true, get: () => false });
          Object.defineProperty(Uint8Array.prototype, 'subarray', {configurable:true, value: function(start, end) {return new Uint8Array(end - start);}});
          return { map: new Map([['real', 7]]), set: new Set(['real']), rx: /a/g, bytes: new Uint8Array([1,2,3]) };
        });
        const patchedOk = Map.prototype.get.call(patched.map, 'real') === 7 && Set.prototype.has.call(patched.set, 'real') &&
          Object.getOwnPropertyDescriptor(RegExp.prototype, 'global').get.call(patched.rx) === true && patched.bytes[0] === 1 && patched.bytes[2] === 3;
        await protocol.send({tabId:page.tabId}, 'Runtime.evaluate', {expression: "Map.prototype.entries = window.__savedMapEntries; Set.prototype.values = window.__savedSetValues; Object.defineProperty(RegExp.prototype, 'global', window.__savedGlobalGetter); if (window.__savedSubarray) Object.defineProperty(Uint8Array.prototype, 'subarray', window.__savedSubarray); else delete Uint8Array.prototype.subarray; true;"});
        const absent = await page.evaluate(() => undefined);
        return { page: result.self === result && result.a === result.b && result.a.n === 9n && result.map.get(result.a) === result &&
            result.view.buffer === result.buffer && result.view.byteOffset === 1 && result.view[0] === 77 && result.date instanceof Date &&
            Object.hasOwn(result, 'missing') && result.missing === undefined && Object.is(result.number, -0) && result.date.note === result.a &&
            result.error instanceof TypeError && result.error.message === 'returned' && result.error.cause === result.a,
          frame: frame.self === frame && frame.input && frame.element === 'Frame action', absent: absent === undefined, patched: patchedOk,
          foreign: foreign.self === foreign && foreign.a === foreign.b && Date.prototype.getTime.call(foreign.date) === 0 && foreign.date.getTime === 'user' &&
            Object.getOwnPropertyDescriptor(RegExp.prototype,'source').get.call(foreign.rx) === 'a+' && foreign.rx.source === 'user' && foreign.rx.flags === 'user' &&
            foreign.map.get(foreign.a) === 'real' && foreign.set.has(foreign.a) && foreign.view.buffer === foreign.buffer && foreign.view.byteOffset === 1 && foreign.view[0] === 88 };
      ` }, "evaluate-graph"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { page: true, frame: true, absent: true, patched: true, foreign: true } });
        return commandResponse("execute_program", { code: "return await page.evaluate(() => { document.body.dataset.graphEffect = 'yes'; return new URL(location.href); });" }, "unsupported-page-value");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { effectUnknown: true } });
        return textResponse("EVALUATE_GRAPH_OK");
      },
      textResponse("Graph evaluation"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Evaluate structured browser data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EVALUATE_GRAPH_OK", { timeout: 60_000 });
    await expect(target.locator("body")).toHaveAttribute("data-graph-effect", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("evaluate fails before the callback when a required page intrinsic was already replaced", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { code: "return await page.evaluate(() => { Map.prototype.entries = function*(){ yield ['fake', 1]; }; return true; });" }, "patch-intrinsic"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: true });
        return commandResponse("execute_program", { code: "return await page.evaluate(() => { document.body.dataset.callbackRan = 'yes'; return 42; });" }, "blocked-intrinsic");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { effectUnknown: true, message: expect.stringContaining("Map.prototype.entries is modified") } });
        return textResponse("INTRINSIC_CHECK_OK");
      },
      textResponse("Intrinsic check"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Evaluate with changed page intrinsics");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INTRINSIC_CHECK_OK", { timeout: 60_000 });
    await expect(target.locator("body")).not.toHaveAttribute("data-callback-ran", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
