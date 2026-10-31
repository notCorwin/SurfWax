import { describe, expect, it } from "vitest";
import { partitionArtifact, readPartitionedArtifact, type ArtifactPart } from "./artifact-graph";
import { decodeLogGraph, encodeLogGraph } from "./log-graph";
import { EventLogger, type LogEvent } from "./logging";

function fixture(value: unknown) {
  const { graph, parts } = partitionArtifact(value);
  let reads: ArtifactPart[] = [];
  const read = async (node: number, section?: string, first?: number, last?: number) => {
    const found = parts.filter((part) => part.node === node && (section === undefined || part.section === section) && (first === undefined || part.part >= first) && (last === undefined || part.part <= last));
    reads.push(...found);
    return found;
  };
  const readBuckets = async (node: number, prefix: "i:" | "e:", first: number, last: number) => {
    const found = parts.filter((part) => part.node === node && part.section.startsWith(prefix)
      && Number(part.section.slice(prefix.length)) >= first && Number(part.section.slice(prefix.length)) <= last);
    reads.push(...found);
    return found;
  };
  return { get: (selection = {}) => readPartitionedArtifact(graph, read, selection, 1, readBuckets), reads: () => reads, reset: () => { reads = []; }, parts };
}

describe("partitioned artifact graphs", () => {
  it("matches the V5 graph for scalar, binary, collection, error and cyclic values", async () => {
    const lengths = [0, 1, 2, 3, 383, 384, 385, 6143, 6144, 6145, 12289];
    const buffers = lengths.map((length) => Uint8Array.from({ length }, (_, index) => (index * 13 + 7) % 256).buffer);
    const sparse: any[] = new Array(501); sparse[2] = undefined; sparse[500] = -0; (sparse as any).long = "a".repeat(9000);
    const error = new TypeError("bad", { cause: { detail: 9 } });
    Object.defineProperty(error, "statusCode", { value: 418 });
    const pattern = /hello/gi; pattern.lastIndex = 7; (pattern as any).extra = "z".repeat(8200);
    const shared: any = Object.assign(Object.create(null), { undefined, nan: NaN, negativeZero: -0, infinity: Infinity, bigint: 123n });
    const map = new Map<any, any>(); const set = new Set<any>();
    const input: any = { shared, alias: shared, buffers, sparse, error, pattern, dates: [new Date(0), new Date(NaN)], map, set,
      view: new Uint16Array(buffers[8]!, 4, 5), text: "🌊abc".repeat(4000) };
    input.self = input; map.set(shared, input); map.set("self", map); set.add(shared); set.add(set);
    const expected: any = decodeLogGraph(encodeLogGraph(input));
    const result: any = await fixture(input).get();
    expect(result).toEqual(expected);
    expect(result.self).toBe(result); expect(result.shared).toBe(result.alias);
    expect(result.map.get(result.shared)).toBe(result); expect(result.map.get("self")).toBe(result.map);
    expect(result.set.has(result.set)).toBe(true); expect(result.view.buffer).toBe(result.buffers[8]);
    expect(Object.getPrototypeOf(result.shared)).toBeNull();
    expect(Object.is(result.shared.negativeZero, -0)).toBe(true);
    for (let index = 0; index < lengths.length; index++)
      expect([...new Uint8Array(result.buffers[index])]).toEqual([...new Uint8Array(expected.buffers[index])]);
  });
  it("snapshots input before it can be mutated", async () => {
    const value = { rows: [1, 2], buffer: Uint8Array.from([3, 4]).buffer };
    const store = fixture(value);
    value.rows[0] = 99; new Uint8Array(value.buffer)[0] = 99;
    const saved: any = await store.get();
    expect(saved.rows).toEqual([1, 2]); expect([...new Uint8Array(saved.buffer)]).toEqual([3, 4]);
  });
  it("reads getters in V5 breadth-first order and propagates their errors", () => {
    const source = () => {
      const accesses: string[] = [];
      const child = { get detail() { accesses.push("child.detail"); return 3; } };
      const value = { get first() { accesses.push("first"); return child; }, get second() { accesses.push("second"); return 2; } };
      return { value, accesses };
    };
    const legacy = source(); encodeLogGraph(legacy.value);
    const partitioned = source(); partitionArtifact(partitioned.value);
    expect(legacy.accesses).toEqual(["first", "second", "child.detail"]);
    expect(partitioned.accesses).toEqual(legacy.accesses);

    for (const encode of [encodeLogGraph, partitionArtifact]) {
      const accesses: string[] = [];
      const value = { get first() { accesses.push("first"); return 1; }, get second() { accesses.push("second"); throw new Error("getter failed"); }, get third() { accesses.push("third"); return 3; } };
      expect(() => encode(value)).toThrow("getter failed");
      expect(accesses).toEqual(["first", "second"]);
    }
  });
  it("rejects unsupported graph values with the same errors as V5", () => {
    const symbol = { [Symbol("unsupported")]: 1 };
    for (const value of [() => 1, Symbol("unsupported"), new URL("https://example.com"), symbol, new Uint8Array(new SharedArrayBuffer(8))]) {
      let message = "";
      try { encodeLogGraph(value); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe("");
      expect(() => partitionArtifact(value)).toThrow(message);
    }
  });
  it("paginates large arrays and strings without reading their other chunks", async () => {
    const store = fixture({ rows: Array.from({ length: 20000 }, (_, i) => i), text: "abc".repeat(100000) });
    expect(await store.get({ path: ["rows"], offset: 512, limit: 3 })).toEqual([512, 513, 514]);
    expect(store.reads().filter((row) => row.section.startsWith("i:")).length).toBe(1);
    store.reset();
    expect(await store.get({ path: ["text"], offset: 90000, limit: 5 })).toBe("abcab");
    expect(store.reads().filter((row) => row.section === "text").length).toBe(1);
  });
  it("reads only occupied buckets in a wide sparse page", async () => {
    const sparse: number[] = new Array(20_000_000);
    for (let bucket = 0; bucket < 1000; bucket++) sparse[bucket * 16_384] = bucket;
    const store = fixture({ sparse });
    const page = await store.get({ path: ["sparse"], offset: 5_000_000, limit: 200_000 }) as number[];
    expect(page.length).toBe(200_000);
    expect(page[5_013_504 - 5_000_000]).toBe(306);
    const rows = store.reads().filter((part) => part.section.startsWith("i:"));
    expect(rows).toHaveLength(12);
    expect(rows.every((part) => {
      const bucket = Number(part.section.slice(2));
      return bucket >= Math.floor(5_000_000 / 128) && bucket <= Math.floor(5_199_999 / 128);
    })).toBe(true);
  });
  it("preserves sparse holes, aliases, cycles, and shared backing buffers", async () => {
    const buffer = new ArrayBuffer(40000), left = new Uint16Array(buffer, 4, 4), right = new DataView(buffer, 2, 5);
    left[0] = 98;
    const sparse: any[] = new Array(20); sparse[5] = undefined;
    const shared: any = { left, right, sparse }; shared.self = shared; shared.other = shared.left;
    const store = fixture({ result: shared });
    const result: any = await store.get({ path: ["result"] });
    expect(result.self).toBe(result); expect(result.left).toBe(result.other); expect(result.left.buffer).toBe(result.right.buffer);
    expect(result.left[0]).toBe(98); expect(5 in result.sparse).toBe(true); expect(4 in result.sparse).toBe(false);
    const page: any = await store.get({ path: ["result", "sparse"], offset: 4, limit: 3 });
    expect(0 in page).toBe(false); expect(1 in page).toBe(true); expect(page.length).toBe(3);
    expect([...await store.get({ path: ["result", "left"], offset: 0, limit: 2 }) as Uint16Array]).toEqual([98, 0]);
  });
  it("navigates Map entry pairs and rejects missing paths", async () => {
    const store = fixture(new Map([["a", { nested: 42 }]]));
    expect(await store.get({ path: [0, 1, "nested"] })).toBe(42);
    await expect(store.get({ path: [1] })).rejects.toMatchObject({ code: "result-path-not-found" });
    expect([...await store.get({ offset: 0, limit: 1 }) as Map<unknown, unknown>]).toEqual([["a", { nested: 42 }]]);
  });
  it("matches the existing V5 reader for native values, own paths, and pages", async () => {
    const sparse: any[] = new Array(12); sparse[1] = undefined; sparse[5] = "five"; (sparse as any).named = "extra";
    const error = new TypeError("bad", { cause: { detail: 7 } }); error.stack = "trace";
    const regex = /xy/gi; regex.lastIndex = 3;
    const buffer = new Uint8Array(Array.from({ length: 60 }, (_, index) => index)).buffer;
    const input = { sparse, error, regex, view: new Uint16Array(buffer, 4, 8), bytes: new DataView(buffer, 2, 20), buffer,
      map: new Map<any, any>([["first", { value: 3 }], ["second", 4]]), set: new Set(["a", "b", "c"]), text: "xyz".repeat(10000) };
    const split = fixture(input);
    const event: LogEvent = { id: 1, type: "tool.result.data", timestamp: "", valueEncoding: 5, content: null, output: encodeLogGraph(input) };
    const logger = new EventLogger({ store: { append: async () => event, get: async () => event, all: async () => [event], latestByType: async () => undefined } });
    const selections = [
      { path: ["error", "name"] }, { path: ["error", "message"] }, { path: ["error", "stack"] }, { path: ["error", "cause", "detail"] },
      { path: ["regex", "lastIndex"] }, { path: ["view", 2] }, { path: ["map", 0, 1, "value"] }, { path: ["set", 2] },
      { path: ["sparse", "named"] }, { path: ["sparse", "length"] }, { path: ["text", "length"] }, { path: ["text", 10] },
      { path: ["sparse"], offset: 0, limit: 9 }, { path: ["view"], offset: 2, limit: 4 }, { path: ["bytes"], offset: 3, limit: 7 },
      { path: ["buffer"], offset: 8, limit: 9 }, { path: ["map"], offset: 1, limit: 1 }, { path: ["set"], offset: 1, limit: 2 },
      { path: ["text"], offset: 8090, limit: 200 }, { path: ["map", 0], offset: 1, limit: 1 },
    ];
    for (const selection of selections) expect(await split.get(selection), JSON.stringify(selection)).toEqual(await logger.result(1, selection));
    for (const path of [["error", "toString"], ["regex", "source"], ["view", "length"], ["sparse", 2], ["map", 4], ["text", "slice"]]) {
      await expect(split.get({ path })).rejects.toMatchObject({ code: "result-path-not-found" });
      await expect(logger.result(1, { path })).rejects.toMatchObject({ code: "result-path-not-found" });
    }
  });
});
