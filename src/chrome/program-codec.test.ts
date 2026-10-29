import { describe, expect, it } from "vitest";
import { createProgramCodec } from "./program-codec";

describe("program bridge object graphs", () => {
  it("does not reuse an allowed evaluate callback as serializable function data", () => {
    const codec = createProgramCodec((value, allowed) => typeof value === "function" && allowed ? { value: { $function: String(value) } } : undefined, () => undefined);
    const fn = () => 1;
    const seen = new WeakMap<object, unknown>();
    codec.encode(fn, seen, true);
    expect(() => codec.encode({ callback: fn }, seen)).toThrow("cannot serialize functions as data");
  });
  it("preserves cycles, repeated values and shared binary views through structured clone", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const buffer = new ArrayBuffer(16);
    const view = new Uint16Array(buffer, 4, 3);
    const root: any = { buffer, view, alias: view, ordinary: { $plainObject: [["a", 1]], $map: [1] } };
    root.self = root; root.map = new Map([[root, view]]); root.set = new Set([root]);
    const regexp = /abc/g; (regexp as any).lastIndex = root; root.regexp = regexp;
    const result = codec.decode(structuredClone(codec.encode(root)));
    expect(result.self).toBe(result); expect(result.alias).toBe(result.view);
    expect(result.view.buffer).toBe(result.buffer); expect(result.view.byteOffset).toBe(4);
    expect(result.map.get(result)).toBe(result.view); expect(result.set.has(result)).toBe(true);
    expect(result.regexp.lastIndex).toBe(result); expect(result.ordinary).toEqual(root.ordinary);
  });

  it("preserves sparse array holes and self references without visiting their length", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const array: any[] = new Array(1_000_000_000); array[999_999_999] = array;
    const wire = codec.encode(array);
    expect(JSON.stringify({ length: wire.$sparseArray.length, count: wire.$sparseArray.entries.length })).toContain("1000000000");
    const result = codec.decode(structuredClone(wire));
    expect(result.length).toBe(1_000_000_000); expect(result[999_999_999]).toBe(result); expect(Object.hasOwn(result, 0)).toBe(false);
  });

  it("preserves extra properties, error causes and null prototypes, and rejects unsupported values", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const root: any = Object.create(null); root.date = new Date(0); root.date.owner = root;
    root.error = new TypeError("problem"); Object.defineProperty(root.error, "cause", { value: root }); root.array = [1]; root.array.owner = root;
    const value = codec.decode(structuredClone(codec.encode(root)));
    expect(Object.getPrototypeOf(value)).toBeNull(); expect(value.date.owner).toBe(value); expect(value.array.owner).toBe(value);
    expect(value.error).toBeInstanceOf(TypeError); expect(value.error.cause).toBe(value);
    expect(() => codec.encode(new URL("https://example.com"))).toThrow("object type");
    expect(() => codec.encode({ [Symbol("secret")]: 1 })).toThrow("symbol");
    const fake = { data: 123 }; Object.defineProperty(fake, Symbol.toStringTag, { value: "ArrayBuffer" });
    expect(codec.decode(structuredClone(codec.encode(fake)))).toEqual({ data: 123 });
  });

  it("reads Date and RegExp internal state despite own property shadows", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const date = new Date("2020-01-02T03:04:05Z");
    Object.defineProperty(date, "getTime", { value: "user getTime", enumerable: true });
    Object.defineProperty(date, "toISOString", { value: "user toISOString", enumerable: true });
    const regexp = /hello/gi;
    Object.defineProperty(regexp, "source", { value: "user source", enumerable: true });
    Object.defineProperty(regexp, "flags", { value: "user flags", enumerable: true });
    Object.defineProperty(regexp, "global", { value: false, enumerable: true });
    Object.defineProperty(regexp, "ignoreCase", { value: false, enumerable: true });
    const result = codec.decode(structuredClone(codec.encode({ date, regexp })));
    expect(Date.prototype.getTime.call(result.date)).toBe(Date.parse("2020-01-02T03:04:05Z"));
    expect(result.date.getTime).toBe("user getTime"); expect(result.date.toISOString).toBe("user toISOString");
    expect(Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!.call(result.regexp)).toBe("hello");
    expect(Object.getOwnPropertyDescriptor(RegExp.prototype, "global")!.get!.call(result.regexp)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(RegExp.prototype, "ignoreCase")!.get!.call(result.regexp)).toBe(true);
    expect(result.regexp.source).toBe("user source"); expect(result.regexp.flags).toBe("user flags");
    expect(result.regexp.global).toBe(false); expect(result.regexp.ignoreCase).toBe(false);
  });

  it("serializes actual Map and Set entries despite overridden iteration", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const map = new Map([["real", 1]]);
    Object.defineProperty(map, Symbol.iterator, { value: function* () { yield ["fake", 2]; } });
    const set = new Set(["real"]);
    Object.defineProperty(set, Symbol.iterator, { value: function* () { yield "fake"; } });
    const result = codec.decode(structuredClone(codec.encode({ map, set })));
    expect([...Map.prototype.entries.call(result.map)]).toEqual([["real", 1]]);
    expect([...Set.prototype.values.call(result.set)]).toEqual(["real"]);
  });

  it("captures native methods before program code can replace them", () => {
    const codec = createProgramCodec(() => undefined, () => undefined);
    const getTime = Date.prototype.getTime; const entries = Map.prototype.entries;
    let encoded: unknown;
    try {
      Date.prototype.getTime = () => NaN;
      Map.prototype.entries = function* () { yield ["fake", 2]; } as typeof Map.prototype.entries;
      encoded = codec.encode({ date: new Date(0), map: new Map([["real", 1]]) });
    } finally {
      Date.prototype.getTime = getTime; Map.prototype.entries = entries;
    }
    const result = codec.decode(structuredClone(encoded));
    expect(result.date.getTime()).toBe(0); expect([...result.map]).toEqual([["real", 1]]);
  });
});
