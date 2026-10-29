import { describe, expect, it } from "vitest";
import { normalizationExceedsBudget, normalizeResultEnvelope } from "./tool-result-values";

describe("native result values", () => {
  it("defers oversized binary data and collections before materializing JSON", () => {
    expect(normalizationExceedsBudget({ result: new ArrayBuffer(1_000_000) })).toBe(true);
    expect(normalizationExceedsBudget({ result: new Map([["huge", new Array(1_000_000)]]) })).toBe(true);
    expect(normalizationExceedsBudget({ result: new Map([["large", "x".repeat(100_000)]]) })).toBe(true);
    expect(normalizationExceedsBudget({ result: { ["x".repeat(100_000)]: 1 } })).toBe(true);
    expect(normalizationExceedsBudget({ result: { ["x".repeat(15_000)]: Array(2500).fill(undefined) } })).toBe(true);
    const cycle = new Map(); cycle.set("self", cycle);
    expect(normalizationExceedsBudget({ result: cycle })).toBe(true);
  });

  it("defers cycles, repeated references, and views with backing data that JSON cannot preserve", () => {
    const shared = { value: 1 };
    expect(normalizationExceedsBudget({ result: { a: shared, b: shared } })).toBe(true);
    const buffer = new ArrayBuffer(16);
    expect(normalizationExceedsBudget({ result: new Uint8Array(buffer, 3, 2) })).toBe(true);
    expect(normalizationExceedsBudget({ result: { buffer, view: new Uint8Array(buffer) } })).toBe(true);
    expect(normalizationExceedsBudget({ result: { a: { value: 1 }, b: { value: 1 } } })).toBe(false);
  });

  it("wraps outer metadata that collides with native type sidecars", () => {
    expect(normalizeResultEnvelope({ ok: true, result: 1, typePaths: ["ordinary"] })).toEqual({
      ok: true, result: { ok: true, result: 1, typePaths: ["ordinary"] }, envelopeWrapped: true,
    });
  });

  it("allows nested native values to be reconstructed deepest-first", () => {
    const output = normalizeResultEnvelope({ result: { map: new Map([["key", new Set([12n, new Date("2020-01-01Z")])]]) } }) as any;
    const root = structuredClone(output.result);
    const replace = (path: (string | number)[], convert: (value: any) => any) => {
      const parent = path.slice(0, -1).reduce((value, part) => value[part], root);
      const key = path.at(-1)!; parent[key] = convert(parent[key]);
    };
    for (const entry of output.bigintPaths) replace(entry.path, () => BigInt(entry.value));
    for (const entry of [...output.typePaths].sort((a, b) => b.path.length - a.path.length)) replace(entry.path, (value) => {
      if (entry.type === "date") return new Date(value);
      if (entry.type === "set") return new Set(value);
      if (entry.type === "map") return new Map(value);
      throw new Error(`Unexpected type: ${entry.type}`);
    });
    expect(root.map.get("key")).toEqual(new Set([12n, new Date("2020-01-01Z")]));
  });
});
