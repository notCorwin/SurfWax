/** Self-contained so the same codec can be installed in the disposable worker. */
export function createProgramCodec(
  encodeSpecial: (value: any, allowSource: boolean) => { value: any } | undefined,
  decodeSpecial: (value: any) => { value: any } | undefined,
) {
  const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
  const isBuffer = (value: unknown): boolean => { try { bufferByteLength.call(value); return true; } catch { return false; } };
  const dateGetTime = Date.prototype.getTime;
  const dateToISOString = Date.prototype.toISOString;
  const mapEntries = Map.prototype.entries;
  const setValues = Set.prototype.values;
  const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!;
  const regexpFlags = [["hasIndices", "d"], ["global", "g"], ["ignoreCase", "i"], ["multiline", "m"], ["dotAll", "s"], ["unicode", "u"], ["unicodeSets", "v"], ["sticky", "y"]]
    .map(([name, flag]) => ({ flag, get: Object.getOwnPropertyDescriptor(RegExp.prototype, name!)?.get }));
  const properties = (value: any): string[] => {
    if (Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol)))
      throw new Error("Program bridge cannot serialize enumerable symbol properties");
    // Enumerating a TypedArray also enumerates every element; Chrome can allocate
    // tens of times its byte length merely to discover named properties. Typed
    // views follow structured-clone semantics for named properties.
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return [];
    const keys: string[] = [];
    for (const key in value) if (Object.hasOwn(value, key)) {
      keys.push(key);
    }
    return keys;
  };
  const encode = (value: any, seen = new WeakMap<object, any>(), allowSource = false): any => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
    if (typeof value === "function") {
      const special = encodeSpecial(value, allowSource);
      if (!special) throw new Error("Program bridge cannot serialize functions as data");
      if (seen.has(value)) return seen.get(value);
      seen.set(value, special.value); return special.value;
    }
    if (seen.has(value)) return seen.get(value);
    const special = encodeSpecial(value, allowSource);
    if (special) { seen.set(value, special.value); return special.value; }
    if (isBuffer(value) || ArrayBuffer.isView(value)) {
      const keys = properties(value);
      if (!keys.length) { seen.set(value, value); return value; }
      const result: any = { $binary: { value, properties: [] } }; seen.set(value, result);
      for (const key of keys) result.$binary.properties.push([key, encode(value[key], seen)]);
      return result;
    }
    let result: any;
    if (value instanceof Date) {
      const time = dateGetTime.call(value);
      result = { $date: { value: Number.isNaN(time) ? null : dateToISOString.call(value), properties: [] } };
      seen.set(value, result); for (const key of properties(value)) result.$date.properties.push([key, encode((value as any)[key], seen)]);
    } else if (value instanceof RegExp) {
      const flags = regexpFlags.filter(({ get }) => get?.call(value)).map(({ flag }) => flag).join("");
      result = { $regexp: { source: regexpSource.call(value), flags, lastIndex: undefined, properties: [] } };
      seen.set(value, result); result.$regexp.lastIndex = encode(value.lastIndex, seen);
      for (const key of properties(value)) result.$regexp.properties.push([key, encode((value as any)[key], seen)]);
    } else if (value instanceof Map) {
      result = { $map: { entries: [], properties: [] } }; seen.set(value, result);
      for (const [key, item] of mapEntries.call(value)) result.$map.entries.push([encode(key, seen), encode(item, seen)]);
      for (const key of properties(value)) result.$map.properties.push([key, encode((value as any)[key], seen)]);
    } else if (value instanceof Set) {
      result = { $set: { entries: [], properties: [] } }; seen.set(value, result);
      for (const item of setValues.call(value)) result.$set.entries.push(encode(item, seen));
      for (const key of properties(value)) result.$set.properties.push([key, encode((value as any)[key], seen)]);
    } else if (value instanceof Error) {
      const kinds = [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];
      const kind = kinds.find((constructor) => Object.getPrototypeOf(value) === constructor.prototype)?.name;
      if (!kind) throw new Error("Program bridge cannot serialize this Error subtype as data");
      result = { $error: { kind, name: undefined, message: undefined, stack: undefined, hasCause: Object.hasOwn(value, "cause"), causeEnumerable: Object.prototype.propertyIsEnumerable.call(value, "cause"), cause: undefined, properties: [] } };
      seen.set(value, result);
      result.$error.name = encode(value.name, seen); result.$error.message = encode(value.message, seen); result.$error.stack = encode(value.stack, seen);
      if (result.$error.hasCause) result.$error.cause = encode((value as any).cause, seen);
      for (const key of properties(value)) if (key !== "cause") result.$error.properties.push([key, encode((value as any)[key], seen)]);
    } else if (Array.isArray(value)) {
      const keys = properties(value);
      const indices = value.length > 32768 ? keys.filter((key) => {
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key;
      }) : undefined;
      if (indices && indices.length < value.length) {
        result = { $sparseArray: { length: value.length, entries: [] } }; seen.set(value, result);
        for (const key of keys) result.$sparseArray.entries.push([key, encode((value as any)[key], seen)]);
      } else {
        result = new Array(value.length); seen.set(value, result);
        for (const key of keys) Object.defineProperty(result, key, { value: encode((value as any)[key], seen), enumerable: true, configurable: true, writable: true });
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Program bridge cannot serialize this object type; convert it to a string or bytes");
      result = { $plainObject: { nullPrototype: prototype === null, entries: [] } }; seen.set(value, result);
      for (const key of properties(value)) result.$plainObject.entries.push([key, encode(value[key], seen)]);
    }
    return result;
  };
  const decode = (value: any, seen = new WeakMap<object, any>()): any => {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (isBuffer(value) || ArrayBuffer.isView(value)) { seen.set(value, value); return value; }
    if (Array.isArray(value)) {
      const result = new Array(value.length); seen.set(value, result);
      for (const key of Object.keys(value)) Object.defineProperty(result, key, { value: decode((value as any)[key], seen), enumerable: true, configurable: true, writable: true });
      return result;
    }
    if ("$sparseArray" in value) {
      const result = new Array(value.$sparseArray.length); seen.set(value, result);
      for (const [key, item] of value.$sparseArray.entries) Object.defineProperty(result, key, { value: decode(item, seen), enumerable: true, configurable: true, writable: true });
      return result;
    }
    if ("$plainObject" in value) {
      const result: Record<string, unknown> = value.$plainObject.nullPrototype ? Object.create(null) : {}; seen.set(value, result);
      for (const [key, item] of value.$plainObject.entries) Object.defineProperty(result, key, { value: decode(item, seen), enumerable: true, configurable: true, writable: true });
      return result;
    }
    const restoreProperties = (target: any, entries: any[]) => {
      for (const [key, item] of entries) Object.defineProperty(target, key, { value: decode(item, seen), enumerable: true, configurable: true, writable: true });
    };
    if ("$binary" in value) {
      const result = value.$binary.value; seen.set(value, result); restoreProperties(result, value.$binary.properties); return result;
    }
    if ("$regexp" in value) {
      const result = new RegExp(value.$regexp.source, value.$regexp.flags); seen.set(value, result);
      result.lastIndex = decode(value.$regexp.lastIndex, seen); restoreProperties(result, value.$regexp.properties); return result;
    }
    if ("$date" in value) {
      const result = value.$date.value === null ? new Date(NaN) : new Date(value.$date.value); seen.set(value, result); restoreProperties(result, value.$date.properties); return result;
    }
    if ("$map" in value) {
      const result = new Map(); seen.set(value, result);
      for (const [key, item] of value.$map.entries) result.set(decode(key, seen), decode(item, seen));
      restoreProperties(result, value.$map.properties);
      return result;
    }
    if ("$set" in value) {
      const result = new Set(); seen.set(value, result);
      for (const item of value.$set.entries) result.add(decode(item, seen));
      restoreProperties(result, value.$set.properties);
      return result;
    }
    if ("$error" in value) {
      const kinds: Record<string, new () => Error> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
      if (!Object.hasOwn(kinds, value.$error.kind)) throw new Error("Invalid program bridge error type");
      const result = new kinds[value.$error.kind]!(); seen.set(value, result);
      result.name = decode(value.$error.name, seen); result.message = decode(value.$error.message, seen); result.stack = decode(value.$error.stack, seen);
      if (value.$error.hasCause) Object.defineProperty(result, "cause", { value: decode(value.$error.cause, seen), enumerable: value.$error.causeEnumerable, configurable: true, writable: true });
      restoreProperties(result, value.$error.properties); return result;
    }
    const special = decodeSpecial(value);
    if (special) { seen.set(value, special.value); return special.value; }
    throw new Error("Invalid program bridge value");
  };
  return { encode, decode };
}
