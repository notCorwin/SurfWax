import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("round-trips native program values through compacted artifacts and rejects cycles", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { code: `const rx = /a+/gi; rx.lastIndex = -0;
        return {date: new Date('2025-01-02T03:04:05Z'), invalid: new Date(NaN),
          buffer: new Uint8Array([0,1,2,255]).buffer, view: new DataView(new Uint8Array([1,2]).buffer),
          set: new Set([1n, undefined]), map: new Map([['key', new Date(0)]]), rx};` }, "native-small"),
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true,
          result: { date: '2025-01-02T03:04:05.000Z', invalid: null, buffer: 'AAEC/w==', view: 'AQI=',
            set: [null, null], map: [['key', '1970-01-01T00:00:00.000Z']], rx: { source: 'a+', flags: 'gi', lastIndex: null } },
          typePaths: [ { path: ['date'], type: 'date' }, { path: ['invalid'], type: 'date' },
            { path: ['buffer'], type: 'array-buffer' }, { path: ['view'], type: 'typed-array', name: 'DataView' },
            { path: ['set'], type: 'set' }, { path: ['map'], type: 'map' }, { path: ['map', 0, 1], type: 'date' }, { path: ['rx'], type: 'regexp' } ],
          bigintPaths: [{ path: ['set', 0], value: '1' }], undefinedPaths: [['set', 1]], numberPaths: [{ path: ['rx', 'lastIndex'], value: '-0' }] });
        return commandResponse("execute_program", { code: `
          const bytes = new Uint8Array([0, 1, 2, 255]).buffer;
          const rx = /a+/gi; rx.lastIndex = NaN;
          const rxBig = /b/g; rxBig.lastIndex = 7n;
          return {native: {date: new Date('2025-01-02T03:04:05Z'), invalidDate: new Date(NaN), bytes,
            data: new DataView(bytes, 1, 2), ints: new BigInt64Array([-5n, 9n]), rx, rxBig,
            map: new Map([['values', new Set([1n, undefined])], ['nested', new Map([[2, new Date(0)]])]]),
            ordinary: {$date: null, $regexp: 'ordinary', $map: [['x', 1]], $set: [1]}}, filler: 'x'.repeat(60000)};
        ` }, "native-output");
      },
      (request) => {
        const output = lastTool(request);
        expect(output.$ref).toEqual(expect.any(Number));
        return commandResponse("execute_program", { code: `
          const x = await artifacts.read(${output.$ref}, {path:['result','native']});
          return { date: x.date instanceof Date && x.date.toISOString() === '2025-01-02T03:04:05.000Z',
            invalidDate: x.invalidDate instanceof Date && Number.isNaN(x.invalidDate.getTime()),
            bytes: x.bytes instanceof ArrayBuffer && [...new Uint8Array(x.bytes)].join(',') === '0,1,2,255',
            data: x.data instanceof DataView && x.data.byteLength === 2 && x.data.getUint8(0) === 1 && x.data.getUint8(1) === 2,
            ints: x.ints instanceof BigInt64Array && x.ints[0] === -5n && x.ints[1] === 9n,
            regexp: x.rx instanceof RegExp && x.rx.source === 'a+' && x.rx.flags === 'gi' && Number.isNaN(x.rx.lastIndex),
            regexpBig: x.rxBig instanceof RegExp && x.rxBig.lastIndex === 7n,
            map: x.map instanceof Map && x.map.get('values') instanceof Set && x.map.get('values').has(1n) && x.map.get('values').has(undefined) && x.map.get('nested').get(2) instanceof Date,
            literal: x.ordinary.$date === null && x.ordinary.$regexp === 'ordinary' && x.ordinary.$map[0][0] === 'x' && x.ordinary.$set[0] === 1 };
        ` }, "native-read");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { date: true, invalidDate: true, bytes: true, data: true, ints: true, regexp: true, regexpBig: true, map: true, literal: true } });
        return commandResponse("execute_program", { code: "const m = new Map(); m.set('self', m); return m;", timeoutMs: 10000 }, "map-cycle");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { message: expect.stringContaining("Program bridge requires serializable values") } });
        return commandResponse("execute_program", { code: "const s = new Set(); s.add(s); return s;", timeoutMs: 10000 }, "set-cycle");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: false, error: { message: expect.stringContaining("Program bridge requires serializable values") } });
        return textResponse("PROGRAM_NATIVE_TYPES_OK");
      },
      textResponse("Native values"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect native program data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PROGRAM_NATIVE_TYPES_OK", { timeout: 60_000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("pages oversized native collections and binary values in their natural units", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    let artifact = 0;
    const read = (field: string, offset: number, limit: number, id: string) => commandResponse("read_artifact", { artifactId: artifact, path: ["result", field], offset, limit }, id);
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `
        const bytes = new Uint8Array(40000); bytes.set([171,172,173],1000);
        const data = new Uint8Array(40000); data.set([17,18,19],1000);
        const ints = new BigInt64Array(5000); ints[100] = 123n; ints[101] = -5n;
        const map = new Map(), set = new Set();
        for (let i = 0; i < 33000; i++) { map.set('key' + i, i); set.add(i); }
        map.set('heavy', {payload: 'abcdefghijklmnopqrstuvwxyz'}); set.add({payload: '0123456789'});
        return {bytes: bytes.buffer, data: new DataView(data.buffer), ints, map, set};
      ` }, "native-large"),
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ $ref: expect.any(Number), sidecarsDeferred: true });
        artifact = output.$ref;
        return read("bytes", 1000, 3, "bytes-slice");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "q6yt", typePaths: [{ path: [], type: "array-buffer" }] });
        return read("data", 1000, 3, "view-slice");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "ERIT", typePaths: [{ path: [], type: "typed-array", name: "DataView" }] });
        return read("ints", 100, 2, "ints-slice");
      },
      (request) => {
        const expected = Buffer.from(new BigInt64Array([123n, -5n]).buffer).toString("base64");
        expect(lastTool(request)).toMatchObject({ ok: true, result: expected, typePaths: [{ path: [], type: "typed-array", name: "BigInt64Array" }] });
        return read("map", 125, 2, "map-slice");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: [["key125", 125], ["key126", 126]], typePaths: [{ path: [], type: "map" }] });
        return read("set", 125, 2, "set-slice");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: [125, 126], typePaths: [{ path: [], type: "set" }] });
        return commandResponse("read_artifact", { artifactId: artifact, path: ["result", "map", 33000, 1, "payload"], offset: 2, limit: 4 }, "nested-map");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "cdef" });
        return commandResponse("read_artifact", { artifactId: artifact, path: ["result", "set", 33000, "payload"], offset: 1, limit: 4 }, "nested-set");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: "1234" });
        return commandResponse("execute_program", { timeoutMs: 30000, code: `
          const [bytes, data, ints, map, set] = await Promise.all(['bytes','data','ints','map','set'].map((name) =>
            artifacts.read(${artifact}, {path: ['result',name], offset: name === 'ints' ? 100 : name === 'map' || name === 'set' ? 125 : 1000, limit: name === 'map' || name === 'set' || name === 'ints' ? 2 : 3})));
          return { bytes: bytes instanceof ArrayBuffer && [...new Uint8Array(bytes)].join(',') === '171,172,173',
            data: data instanceof DataView && data.byteLength === 3 && data.getUint8(0) === 17 && data.getUint8(2) === 19,
            ints: ints instanceof BigInt64Array && ints.length === 2 && ints[0] === 123n && ints[1] === -5n,
            map: map instanceof Map && map.size === 2 && map.get('key125') === 125 && map.get('key126') === 126,
            set: set instanceof Set && [...set].join(',') === '125,126' };
        ` }, "native-pages");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { bytes: true, data: true, ints: true, map: true, set: true } });
        return textResponse("NATIVE_PAGES_OK");
      },
      textResponse("Native pages"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read bounded slices of the native data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_PAGES_OK", { timeout: 60000 });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
