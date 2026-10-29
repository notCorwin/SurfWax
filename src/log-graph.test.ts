import { describe, expect, it } from "vitest";
import { decodeLogGraph, encodeLogGraph, requiresLogGraph } from "./log-graph";
import { EventLogger, fromLogValue, toLogValue, type LogEvent } from "./logging";
import { testEventStore } from "./test-event-store";

describe("canonical native object graphs", () => {
  it("round-trips cyclic objects, collection keys, aliases, sparse arrays and shared buffer views", async () => {
    const buffer = new ArrayBuffer(16);
    new Uint8Array(buffer).set([7, 8, 9], 4);
    const view = new Uint8Array(buffer, 4, 3);
    const data = new DataView(buffer, 2, 8);
    const node: any = { buffer, view, data };
    const regexp = /x/gi; (regexp as any).lastIndex = node;
    node.self = node; node.alias = view; node.regexp = regexp;
    node.map = new Map([[node, view]]); node.set = new Set([node, view]);
    node.sparse = new Array(1_000_000_000); node.sparse[999_999_999] = node;
    expect(requiresLogGraph(node)).toBe(true);
    const encoded = encodeLogGraph(node);
    expect(JSON.stringify(encoded).length).toBeLessThan(4000);
    const decoded = decodeLogGraph(JSON.parse(JSON.stringify(encoded))) as any;
    expect(decoded.self).toBe(decoded); expect(decoded.alias).toBe(decoded.view);
    expect(decoded.view.buffer).toBe(decoded.buffer); expect(decoded.data.buffer).toBe(decoded.buffer);
    expect([decoded.view.byteOffset, decoded.data.byteOffset]).toEqual([4, 2]);
    expect([...decoded.view]).toEqual([7, 8, 9]);
    expect(decoded.map.get(decoded)).toBe(decoded.view); expect(decoded.set.has(decoded)).toBe(true);
    expect(decoded.regexp.lastIndex).toBe(decoded); expect(decoded.sparse[999_999_999]).toBe(decoded);
    expect(Object.hasOwn(decoded.sparse, 0)).toBe(false);
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", output: node });
    const first = await logger.result(event!.id, {}, "c") as any;
    expect(first.self).toBe(first); expect(first.view.buffer).toBe(first.buffer); expect(first.alias).toBe(first.view);
    first.view[0] = 255;
    const second = await logger.result(event!.id, {}, "c") as any;
    expect(second.view[0]).toBe(7); expect(second.map.get(second)).toBe(second.view);
  });

  it("keeps ordinary trees compact and does not interpret V4 or escaped user objects as a graph", () => {
    const tree = { alpha: [1, 2, { ok: true }], text: "test" };
    expect(requiresLogGraph(tree)).toBe(false);
    expect(JSON.stringify(toLogValue(tree, undefined, 5))).toBe(JSON.stringify(toLogValue(tree, undefined, 4)));
    const literal = { $type: "object-graph", root: [1, 0], nodes: [] };
    expect(fromLogValue(toLogValue(literal, undefined, 5), 5)).toEqual(literal);
    expect(fromLogValue(literal, 4)).toEqual(literal);
  });

  it("rejects malformed graph references and explicitly rejects resizable buffers", () => {
    expect(() => decodeLogGraph({ $type: "object-graph", root: [1, 0], nodes: [] })).toThrow("Invalid encoded graph token");
    if ("resize" in ArrayBuffer.prototype) {
      const buffer = new (ArrayBuffer as any)(4, { maxByteLength: 8 });
      expect(() => encodeLogGraph({ buffer, alias: buffer })).toThrow("Resizable ArrayBuffer");
    }
  });

  it("does not cache a tiny view that retains an oversized backing buffer", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const buffer = new ArrayBuffer(9 * 1024 * 1024);
    const event = await logger.append({ type: "tool.result.data", conversationId: "c", output: new Uint8Array(buffer, 7, 1) });
    const result = await logger.result(event!.id, {}, "c") as Uint8Array;
    expect(result.byteOffset).toBe(7); expect(result.buffer.byteLength).toBe(buffer.byteLength);
    expect((logger as any).artifactCache.size).toBe(1);
    expect((logger as any).artifactBytes).toBeLessThan(8192);
  });

  it("preserves extra properties, error causes, null prototypes and rejects unsupported objects", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const root: any = Object.create(null); root.self = root; root.array = [1]; root.array.label = root;
    root.date = new Date(0); root.date.label = root; root.map = new Map(); root.map.label = root;
    root.buffer = new ArrayBuffer(8); root.buffer.label = root; root.view = new DataView(root.buffer); root.view.label = root;
    root.error = new TypeError("problem"); Object.defineProperty(root.error, "cause", { value: root, configurable: true, writable: true }); (root.error as any).label = root;
    const saved = await logger.append({ type: "tool.result.data", conversationId: "c", output: root });
    const value = await logger.result(saved!.id, {}, "c") as any;
    expect(Object.getPrototypeOf(value)).toBeNull(); expect(value.self).toBe(value);
    expect(value.array.label).toBe(value); expect(value.date.label).toBe(value); expect(value.map.label).toBe(value);
    expect(value.buffer.label).toBe(value); expect(value.view.label).toBe(value); expect(value.view.buffer).toBe(value.buffer);
    expect(value.error).toBeInstanceOf(TypeError); expect(value.error.message).toBe("problem"); expect(value.error.cause).toBe(value); expect(value.error.label).toBe(value);
    expect(() => logger.append({ type: "tool.result.data", output: new URL("https://example.com") })).toThrow("object type");
    const symbol = { [Symbol("secret")]: 1 };
    expect(() => logger.append({ type: "tool.result.data", output: symbol })).toThrow("symbol");
  });

  it("uses native buffer and typed-array brands despite forged instance fields", async () => {
    const view = new Uint8Array([1, 2, 3]);
    Object.defineProperty(view, "constructor", { value: Date, enumerable: true });
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const saved = await logger.append({ type: "tool.result.data", output: view });
    const value = await logger.result(saved!.id, { offset: 1, limit: 1 }) as Uint8Array;
    expect(value).toBeInstanceOf(Uint8Array); expect([...value]).toEqual([2]);
    const fake = { data: 123 }; Object.defineProperty(fake, Symbol.toStringTag, { value: "ArrayBuffer" });
    expect(requiresLogGraph(fake)).toBe(false);
    expect(fromLogValue(toLogValue(fake, undefined, 5), 5)).toEqual({ data: 123 });
  });
});
