import type { JsonValue } from "./types";

/** Self-contained so the same codec can run in a browser page. */
export function createLogGraphCodec(options: { verifyIntrinsics?: boolean } = {}) {
if (options.verifyIntrinsics) {
  // This detects ordinary monkey-patching, not a page that deliberately forges
  // Function.prototype.toString. There is no trusted main-world realm here.
  const g = globalThis as any;
  const fail = (name: string): never => { throw new Error(`Page evaluation cannot start: JavaScript intrinsic ${name} is modified`); };
  for (const name of ["Object", "Array", "ArrayBuffer", "DataView", "Date", "RegExp", "Map", "Set", "Function", "Number", "Uint8Array"])
    if (typeof g[name] !== "function") fail(name);
  const inspect = g.Function.prototype?.toString;
  const check = (name: string, value: unknown) => {
    let source = "";
    try { if (typeof value === "function" && typeof inspect === "function") source = inspect.call(value); } catch { /* Report a single clear error. */ }
    if (!/\{\s*\[native code\]\s*\}/.test(source)) fail(name);
  };
  check("Function.prototype.toString", inspect);
  // The graph walker uses generators to stream entries. A page can otherwise
  // replace their methods and make a successful evaluation silently omit data.
  const generator: any = (function* () {})();
  check("Generator.prototype.next", generator.next);
  check("Generator.prototype[Symbol.iterator]", generator[g.Symbol?.iterator]);
  for (const [name, owner, member] of [
    ["Object.getOwnPropertyDescriptor", g.Object, "getOwnPropertyDescriptor"], ["Object.getPrototypeOf", g.Object, "getPrototypeOf"],
    ["Object.getOwnPropertySymbols", g.Object, "getOwnPropertySymbols"], ["Object.hasOwn", g.Object, "hasOwn"],
    ["Array.isArray", g.Array, "isArray"], ["Array.from", g.Array, "from"], ["ArrayBuffer.isView", g.ArrayBuffer, "isView"],
    ["Array.prototype.map", g.Array.prototype, "map"], ["Array.prototype.filter", g.Array.prototype, "filter"],
    ["Array.prototype.includes", g.Array.prototype, "includes"], ["Array.prototype.find", g.Array.prototype, "find"], ["Array.prototype.push", g.Array.prototype, "push"],
    ["Map.prototype.entries", g.Map.prototype, "entries"], ["Map.prototype.set", g.Map.prototype, "set"],
    ["Set.prototype.values", g.Set.prototype, "values"], ["Set.prototype.add", g.Set.prototype, "add"],
    ["Date.prototype.getTime", g.Date.prototype, "getTime"], ["Date.prototype.toISOString", g.Date.prototype, "toISOString"],
    ["Uint8Array.prototype.subarray", g.Uint8Array.prototype, "subarray"],
  ] as const) check(name, owner?.[member]);
  for (const [name, owner, member] of [
    ["ArrayBuffer.prototype.byteLength", g.ArrayBuffer.prototype, "byteLength"], ["DataView.prototype.byteLength", g.DataView.prototype, "byteLength"],
    ["Map.prototype.size", g.Map.prototype, "size"], ["Set.prototype.size", g.Set.prototype, "size"], ["RegExp.prototype.source", g.RegExp.prototype, "source"],
    ...["hasIndices", "global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky"]
      .filter((key) => g.Object.getOwnPropertyDescriptor(g.RegExp.prototype, key))
      .map((key) => [`RegExp.prototype.${key}`, g.RegExp.prototype, key] as const),
  ] as const) check(name, g.Object.getOwnPropertyDescriptor(owner, member)?.get);
}
const { Object, Array, ArrayBuffer, DataView, Date, RegExp, Map, Set, Function, Number, Uint8Array, Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array } = globalThis;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const arrayFrom = Array.from;
const arrayMap = Array.prototype.map;
const arrayFilter = Array.prototype.filter;
const arrayIncludes = Array.prototype.includes;
const arrayFind = Array.prototype.find;
const arrayPush = Array.prototype.push;
const objectPrototype = Object.prototype;
const mapEntriesMethod = Map.prototype.entries;
const setValuesMethod = Set.prototype.values;
const encodeBase64 = globalThis.btoa.bind(globalThis);
const decodeBase64 = globalThis.atob.bind(globalThis);
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!;
const regexpFlags = ([["hasIndices", "d"], ["global", "g"], ["ignoreCase", "i"], ["multiline", "m"],
  ["dotAll", "s"], ["unicode", "u"], ["unicodeSets", "v"], ["sticky", "y"]] as const)
  .map(([name, flag]) => [getOwnPropertyDescriptor(RegExp.prototype, name)?.get, flag] as const);
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const isDate = (value: unknown): value is Date => { try { dateGetTime.call(value); return true; } catch { return false; } };
const dateValue = (value: Date): number => dateGetTime.call(value);
const dateISOString = (value: Date): string => dateToISOString.call(value);
const isRegExp = (value: unknown): value is RegExp => { try { regexpSourceGetter.call(value); return true; } catch { return false; } };
const regexpSource = (value: RegExp): string => regexpSourceGetter.call(value);
const regexpFlagString = (value: RegExp): string => { let result = ""; for (let i = 0; i < regexpFlags.length; i++) { const [getter, flag] = regexpFlags[i]!; if (getter?.call(value)) result += flag; } return result; };
const isMap = (value: unknown): value is Map<unknown, unknown> => { try { mapSize.call(value); return true; } catch { return false; } };
const mapSizeOf = (value: Map<unknown, unknown>): number => mapSize.call(value);
const mapEntries = (value: Map<unknown, unknown>): IterableIterator<[unknown, unknown]> => mapEntriesMethod.call(value);
const isSet = (value: unknown): value is Set<unknown> => { try { setSize.call(value); return true; } catch { return false; } };
const setSizeOf = (value: Set<unknown>): number => setSize.call(value);
const setValues = (value: Set<unknown>): IterableIterator<unknown> => setValuesMethod.call(value);
const isArrayBuffer = (value: unknown): value is ArrayBuffer => { try { bufferByteLength.call(value); return true; } catch { return false; } };
const arrayBufferLength = (value: ArrayBuffer): number => bufferByteLength.call(value);
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const isResizableBuffer = (value: ArrayBuffer): boolean => bufferResizable ? bufferResizable.call(value) : false;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedSubarray = typedPrototype.subarray;
const typedName = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")!.get!;
const typedBytes = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "length")!.get!;
const dataBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
const dataOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!;
const dataBytes = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;
const isDataView = (value: unknown): value is DataView => { try { dataBytes.call(value); return true; } catch { return false; } };
function arrayViewName(value: ArrayBufferView): string {
  if (isDataView(value)) return "DataView";
  const name = typedName.call(value);
  if (typeof name !== "string") throw new Error("Invalid typed array view");
  return name;
}
function viewLayout(value: ArrayBufferView): { buffer: ArrayBuffer; byteOffset: number; byteLength: number; length: number } {
  if (isDataView(value)) { const byteLength = dataBytes.call(value); return { buffer: dataBuffer.call(value), byteOffset: dataOffset.call(value), byteLength, length: byteLength }; }
  return { buffer: typedBuffer.call(value), byteOffset: typedOffset.call(value), byteLength: typedBytes.call(value), length: typedLength.call(value) };
}
function createArrayView(name: string, buffer: ArrayBuffer, offset: number, length: number): ArrayBufferView {
  if (name === "DataView") return new DataView(buffer, offset, length);
  const constructors: Record<string, new (buffer: ArrayBuffer, offset?: number, length?: number) => ArrayBufferView> = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    ...("Float16Array" in globalThis ? { Float16Array: (globalThis as any).Float16Array } : {}),
  };
  if (!Object.hasOwn(constructors, name)) throw new Error("Invalid graph view type");
  return new constructors[name]!(buffer, offset, length);
}
function assertPlainGraphObject(value: object): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === objectPrototype || prototype === null) return;
  const constructor = getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (getPrototypeOf(prototype) === null && typeof constructor === "function" &&
      Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object)) return;
  throw new Error("Cannot persist this object type; convert it to a string or bytes");
}
function graphProperties(value: any): string[] {
  if (!(value instanceof Error)) for (const symbol of getOwnPropertySymbols(value))
    if (propertyIsEnumerable.call(value, symbol)) throw new Error("Cannot persist enumerable symbol properties in a native object graph");
  // A TypedArray's numeric elements are own enumerable keys. Enumerating them
  // can allocate tens of times the buffer size; named properties follow the
  // structured-clone contract and are not persisted.
  if (isView(value) && !isDataView(value)) return [];
  const keys: string[] = [];
  for (const key in value) if (hasOwn(value, key)) {
    arrayPush.call(keys, key);
  }
  return keys;
}

/** Whether tree encoding would lose identity, cycles, or a binary view's backing buffer. */
function requiresLogGraph(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) return true;
    seen.add(item);
    if (item instanceof Error) return true;
    if (isView(item)) {
      const { buffer, byteOffset, byteLength } = viewLayout(item);
      if (!isArrayBuffer(buffer) || isResizableBuffer(buffer) || byteOffset !== 0 || byteLength !== arrayBufferLength(buffer) || seen.has(buffer) || graphProperties(item).length) return true;
      seen.add(buffer); continue;
    }
    if (isArrayBuffer(item)) { if (isResizableBuffer(item) || graphProperties(item).length) return true; continue; }
    if (isDate(item)) { if (graphProperties(item).length) return true; continue; }
    if (isRegExp(item)) { if (graphProperties(item).length) return true; pending.push(item.lastIndex); continue; }
    if (isMap(item)) { if (graphProperties(item).length) return true; for (const [key, entry] of mapEntries(item)) pending.push(key, entry); continue; }
    if (isSet(item)) { if (graphProperties(item).length) return true; for (const entry of setValues(item)) pending.push(entry); continue; }
    if (!isArray(item)) {
      assertPlainGraphObject(item);
      if (getPrototypeOf(item) === null) return true;
    }
    for (const key of graphProperties(item)) {
      if (isArray(item) && !(Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < item.length && String(Number(key)) === key)) return true;
      pending.push((item as any)[key]);
    }
  }
  return false;
}

const bytesBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...typedSubarray.call(bytes, offset, offset + 0x8000));
  return encodeBase64(binary);
};

/** Visit a V5 graph synchronously. Consumers must exhaust each node's iterables
 * during its callback so token IDs and the input snapshot stay deterministic. */
function visitLogGraph(value: unknown, visitor: {
  root(token: any): void;
  node(id: number, metadata: any, entries?: Iterable<any>, properties?: Iterable<any>): void;
  buffer?(bytes: Uint8Array): unknown;
}): void {
  const ids = new WeakMap<object, number>();
  const pending: object[] = [];
  const token = (item: any): any => {
    if (item === undefined) return [2];
    if (typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) return [3, Object.is(item, -0) ? "-0" : String(item)];
    if (typeof item === "bigint") return [4, String(item)];
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number") return [0, item];
    if (typeof item !== "object") throw new Error("Cannot persist functions or symbols in a native object graph");
    let id = ids.get(item);
    if (id === undefined) { id = pending.length; ids.set(item, id); arrayPush.call(pending, item); }
    return [1, id];
  };
  visitor.root(token(value));
  for (let i = 0; i < pending.length; i++) {
    const item: any = pending[i];
    let node: any, entries: Iterable<any> | undefined;
    if (isArrayBuffer(item)) {
      if (isResizableBuffer(item)) throw new Error("Resizable ArrayBuffer graphs are not supported");
      const bytes = new Uint8Array(item);
      node = { type: "buffer", base64: visitor.buffer ? visitor.buffer(bytes) : bytesBase64(bytes), byteLength: arrayBufferLength(item) };
    } else if (isView(item)) {
      const layout = viewLayout(item);
      if (!isArrayBuffer(layout.buffer) || isResizableBuffer(layout.buffer)) throw new Error("Shared or resizable ArrayBuffer graphs are not supported");
      node = { type: "view", name: arrayViewName(item), buffer: token(layout.buffer), offset: layout.byteOffset, length: layout.length };
    } else if (isDate(item)) node = { type: "date", value: Number.isNaN(dateValue(item)) ? null : dateISOString(item) };
    else if (isRegExp(item)) node = { type: "regexp", source: regexpSource(item), flags: regexpFlagString(item), lastIndex: token(item.lastIndex) };
    else if (isMap(item)) {
      node = { type: "map" };
      entries = (function* () { for (const [key, entry] of mapEntries(item)) yield [token(key), token(entry)]; })();
    } else if (isSet(item)) {
      node = { type: "set" };
      entries = (function* () { for (const entry of setValues(item)) yield token(entry); })();
    }
    else if (item instanceof Error) {
      const kind = arrayFind.call([Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError], (constructor) => getPrototypeOf(item) === constructor.prototype)?.name ?? "Error";
      node = { type: "error", kind, name: token(item.name), message: token(item.message), stack: token(item.stack),
        hasCause: Object.hasOwn(item, "cause"), causeEnumerable: Object.prototype.propertyIsEnumerable.call(item, "cause"),
        cause: Object.hasOwn(item, "cause") ? token(item.cause) : null };
    } else if (isArray(item)) {
      node = { type: "array", length: item.length };
      entries = (function* () { const keys = graphProperties(item); for (let index = 0; index < keys.length; index++) { const key = keys[index]!; yield [key, token((item as any)[key])]; } })();
    } else {
      assertPlainGraphObject(item); node = { type: "object", nullPrototype: getPrototypeOf(item) === null };
      entries = (function* () { const keys = graphProperties(item); for (let index = 0; index < keys.length; index++) { const key = keys[index]!; yield [key, token(item[key])]; } })();
    }
    const properties = node.type === "array" || node.type === "object" ? undefined : (function* () {
      const keys = arrayFilter.call(graphProperties(item), (key) => node.type !== "error" || key !== "cause") as string[];
      if (node.type === "error") for (const key of ["statusCode", "status", "responseBody", "responseText", "headers", "requestId", "data", "providerMetadata"]) {
        try { if (!arrayIncludes.call(keys, key) && item[key] !== undefined) arrayPush.call(keys, key); } catch { /* Provider error getters can throw. */ }
      }
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        const value = item[key];
        yield [key, token(node.type === "error" && key === "headers" && typeof Headers !== "undefined" && value instanceof Headers ? Object.fromEntries(value.entries()) : value)];
      }
    })();
    visitor.node(i, node, entries, properties);
  }
}

/** V5 graph nodes are independent of object property names and can be indexed or chunked later. */
function encodeLogGraph(value: unknown): JsonValue {
  let root: any;
  const nodes: any[] = [];
  visitLogGraph(value, {
    root: (token) => { root = token; },
    node: (id, metadata, entries, properties) => {
      if (entries) metadata.entries = arrayFrom(entries);
      if (properties) metadata.properties = arrayFrom(properties);
      nodes[id] = metadata;
    },
  });
  return { $type: "object-graph", root, nodes } as JsonValue;
}

function decodeLogGraph(value: any): unknown {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3 || !Array.isArray(value.nodes)) throw new Error("Invalid encoded object graph");
  const nodes: any[] = value.nodes;
  const objects: any[] = new Array(nodes.length);
  const read = (entry: any): any => {
    if (!Array.isArray(entry) || !Number.isInteger(entry[0])) throw new Error("Invalid encoded graph token");
    if (entry[0] === 0 && entry.length === 2 && (entry[1] === null || ["string", "boolean", "number"].includes(typeof entry[1]))) return entry[1];
    if (entry[0] === 1 && entry.length === 2 && Number.isSafeInteger(entry[1]) && entry[1] >= 0 && entry[1] < nodes.length && objects[entry[1]] !== undefined) return objects[entry[1]];
    if (entry[0] === 2 && entry.length === 1) return undefined;
    if (entry[0] === 3 && entry.length === 2 && ["NaN", "Infinity", "-Infinity", "-0"].includes(entry[1])) return entry[1] === "-0" ? -0 : Number(entry[1]);
    if (entry[0] === 4 && entry.length === 2 && typeof entry[1] === "string" && /^-?(?:0|[1-9]\d*)$/.test(entry[1])) return BigInt(entry[1]);
    throw new Error("Invalid encoded graph token");
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || typeof node !== "object") throw new Error("Invalid encoded graph node");
    switch (node.type) {
      case "object": objects[i] = node.nullPrototype ? Object.create(null) : {}; break;
      case "array": if (!Number.isInteger(node.length) || node.length < 0 || node.length > 0xffff_ffff) throw new Error("Invalid graph array length"); objects[i] = new Array(node.length); break;
      case "map": objects[i] = new Map(); break;
      case "set": objects[i] = new Set(); break;
      case "date": objects[i] = node.value === null ? new Date(NaN) : new Date(node.value); if (node.value !== null && (typeof node.value !== "string" || !Number.isFinite(objects[i].getTime()) || objects[i].toISOString() !== node.value)) throw new Error("Invalid graph date"); break;
      case "regexp": if (typeof node.source !== "string" || typeof node.flags !== "string") throw new Error("Invalid graph regexp"); objects[i] = new RegExp(node.source, node.flags); break;
      case "error": {
        const kinds: Record<string, new () => Error> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
        if (!Object.hasOwn(kinds, node.kind)) throw new Error("Invalid graph error type");
        objects[i] = new kinds[node.kind]!(); break;
      }
      case "buffer": {
        if (typeof node.base64 !== "string" || !Number.isSafeInteger(node.byteLength) || node.byteLength < 0 || node.base64.length !== Math.ceil(node.byteLength / 3) * 4 || /[^A-Za-z0-9+/=]/.test(node.base64)) throw new Error("Invalid graph buffer");
        const binary = decodeBase64(node.base64); if (binary.length !== node.byteLength) throw new Error("Invalid graph buffer length");
        objects[i] = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer; break;
      }
      case "view": break;
      default: throw new Error("Invalid encoded graph node type");
    }
  }
  for (let i = 0; i < nodes.length; i++) if (nodes[i].type === "view") {
    const node = nodes[i]; const buffer = read(node.buffer);
    if (!isArrayBuffer(buffer) || !Number.isSafeInteger(node.offset) || node.offset < 0 || !Number.isSafeInteger(node.length) || node.length < 0 || typeof node.name !== "string") throw new Error("Invalid graph view");
    objects[i] = createArrayView(node.name, buffer, node.offset, node.length);
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], target = objects[i];
    if (node.type === "regexp") target.lastIndex = read(node.lastIndex);
    if (node.type === "error") {
      target.name = read(node.name); target.message = read(node.message); target.stack = read(node.stack);
      if (node.hasCause) Object.defineProperty(target, "cause", { value: read(node.cause), enumerable: Boolean(node.causeEnumerable), configurable: true, writable: true });
    }
    if (["object", "array", "map", "set"].includes(node.type) && !Array.isArray(node.entries)) throw new Error("Invalid graph entries");
    if (node.type === "object" || node.type === "array") {
      const keys = new Set<string>();
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || keys.has(entry[0]) || node.type === "array" && (entry[0] === "length" || /^(?:0|[1-9]\d*)$/.test(entry[0]) && Number(entry[0]) >= node.length && Number(entry[0]) < 0xffff_ffff)) throw new Error("Invalid graph object entry");
        keys.add(entry[0]); Object.defineProperty(target, entry[0], { value: read(entry[1]), enumerable: true, configurable: true, writable: true });
      }
    } else if (node.type === "map") {
      for (const entry of node.entries) { if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid graph map entry"); target.set(read(entry[0]), read(entry[1])); }
    } else if (node.type === "set") for (const entry of node.entries) target.add(read(entry));
    if (node.properties !== undefined) {
      if (!Array.isArray(node.properties)) throw new Error("Invalid graph properties");
      const keys = new Set<string>();
      for (const entry of node.properties) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || keys.has(entry[0]) || node.type === "error" && entry[0] === "cause") throw new Error("Invalid graph property");
        keys.add(entry[0]); Object.defineProperty(target, entry[0], { value: read(entry[1]), enumerable: true, configurable: true, writable: true });
      }
    }
  }
  return read(value.root);
}

  return { isArrayBuffer, arrayBufferLength, isResizableBuffer, isDataView, arrayViewName, viewLayout, createArrayView, assertPlainGraphObject, graphProperties, isDate, dateValue, dateISOString, isRegExp, regexpSource, regexpFlagString, isMap, mapSizeOf, mapEntries, isSet, setSizeOf, setValues, requiresLogGraph, visitLogGraph, encodeLogGraph, decodeLogGraph };
}

export const { isArrayBuffer, arrayBufferLength, isResizableBuffer, isDataView, arrayViewName, viewLayout, createArrayView, assertPlainGraphObject, graphProperties, isDate, dateValue, dateISOString, isRegExp, regexpSource, regexpFlagString, isMap, mapSizeOf, mapEntries, isSet, setSizeOf, setValues, requiresLogGraph, visitLogGraph, encodeLogGraph, decodeLogGraph } = createLogGraphCodec();
