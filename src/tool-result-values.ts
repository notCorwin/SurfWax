import { arrayBufferLength, arrayViewName, assertPlainGraphObject, dateISOString, dateValue, graphProperties, isArrayBuffer, isDate, isMap, isRegExp, isSet, mapEntries, regexpFlagString, regexpSource, setValues, viewLayout } from "./log-graph";
const RESULT_SIDECAR_FIELDS = new Set(["resultType", "undefinedPaths", "holePaths", "numberPaths", "bigintPaths", "typePaths", "undefinedCount", "holeCount", "numberCount", "bigintCount", "typeCount", "undefinedPathsAccess", "holePathsAccess", "numberPathsAccess", "bigintPathsAccess", "typePathsAccess", "undefinedPathsOversizedItem", "holePathsOversizedItem", "numberPathsOversizedItem", "bigintPathsOversizedItem", "typePathsOversizedItem", "pathsNote", "envelopeWrapped"]);

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function copyArray(value: unknown[]): unknown[] {
  const result = new Array(value.length);
  for (let index = 0; index < value.length; index++) if (Object.hasOwn(value, index)) result[index] = value[index];
  return result;
}

/** Bound the work and sidecar allocation before walking a result for JSON output. */
export function normalizationExceedsBudget(value: unknown, budget = 65536): boolean {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number, pathCost: number): boolean => {
    if (--budget < 0 || depth > 100) return true;
    if (typeof item === "string") { budget -= item.length; return budget < 0; }
    if (item === undefined || typeof item === "bigint" || typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      budget -= depth + pathCost;
      return budget < 0;
    }
    if (!item || typeof item !== "object") return false;
    if (seen.has(item)) return true;
    seen.add(item);
      if (isArrayBuffer(item) || ArrayBuffer.isView(item)) {
        if (graphProperties(item).length) return true;
        const size = isArrayBuffer(item) ? arrayBufferLength(item) : viewLayout(item).byteLength;
        if (ArrayBuffer.isView(item)) {
          const layout = viewLayout(item);
          if (!isArrayBuffer(layout.buffer) || layout.byteOffset !== 0 || layout.byteLength !== arrayBufferLength(layout.buffer) || seen.has(layout.buffer)) return true;
          seen.add(layout.buffer);
        }
        budget -= Math.ceil(size * 4 / 3) + depth + pathCost;
        return budget < 0;
      }
      if (isRegExp(item)) {
        if (graphProperties(item).length) return true;
        budget -= depth + pathCost + regexpSource(item).length + regexpFlagString(item).length;
        return budget < 0 || visit(item.lastIndex, depth + 1, pathCost + "lastIndex".length);
      }
      if (isDate(item)) {
        if (graphProperties(item).length) return true;
        budget -= depth + pathCost;
        return budget < 0;
      }
      if (isMap(item)) {
        if (graphProperties(item).length) return true;
        budget -= depth + pathCost;
        if (budget < 0) return true;
        let index = 0;
        for (const [key, value] of mapEntries(item)) {
          const nested = pathCost + String(index++).length + 1;
          if (visit(key, depth + 2, nested) || visit(value, depth + 2, nested)) return true;
        }
        return false;
      }
      if (isSet(item)) {
        if (graphProperties(item).length) return true;
        budget -= depth + pathCost;
        if (budget < 0) return true;
        let index = 0;
        for (const value of setValues(item)) if (visit(value, depth + 1, pathCost + String(index++).length)) return true;
        return false;
      }
      if (item instanceof Error) return true;
      if (Array.isArray(item)) {
        // Every position becomes a JSON value, including holes. Do not iterate
        // an enormous sparse length just to discover that it exceeds budget.
        if (item.length > budget) return true;
        for (const key of graphProperties(item)) if (!(Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < item.length && String(Number(key)) === key)) return true;
        for (let i = 0; i < item.length; i++) {
          const nested = pathCost + String(i).length;
          if (!Object.hasOwn(item, i)) { budget -= depth + 1 + nested; if (budget < 0) return true; }
          else if (visit(item[i], depth + 1, nested)) return true;
        }
        return false;
      }
      assertPlainGraphObject(item);
      if (Object.getPrototypeOf(item) === null) return true;
      if (Object.getOwnPropertySymbols(item).some((symbol) => Object.prototype.propertyIsEnumerable.call(item, symbol))) throw new Error("Cannot serialize enumerable symbol properties");
      for (const key in item) if (Object.hasOwn(item, key)) {
        budget -= key.length;
        if (budget < 0 || visit((item as Record<string, unknown>)[key], depth + 1, pathCost + key.length)) return true;
      }
      return false;
  };
  return visit(value, 0, 0);
}

/** Keep existing outer fields distinct from the result sidecar protocol. */
export function normalizeResultEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  const hasResult = Object.hasOwn(record, "result");
  const needsWrapping = Object.keys(record).some((key) => RESULT_SIDECAR_FIELDS.has(key))
    || Object.entries(record).some(([key, value]) => key !== "result" && hasNonJsonValues(value));
  if (!needsWrapping) return hasResult ? normalizeArtifactResult(record) : record;
  const outer = Object.fromEntries(Object.entries(record).filter(([key]) => !RESULT_SIDECAR_FIELDS.has(key)));
  const safeOuter = normalizeArtifactResult({ result: outer }).result as Record<string, unknown>;
  return normalizeArtifactResult({ ...safeOuter, result: record, envelopeWrapped: true });
}

function hasNonJsonValues(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === "bigint" || typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) return true;
  if (isDate(value) || isRegExp(value) || isArrayBuffer(value) || ArrayBuffer.isView(value) || isMap(value) || isSet(value) || value instanceof Error) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || hasNonJsonValues(value[i], seen)) return true;
    return false;
  }
  return Object.values(value).some((item) => hasNonJsonValues(item, seen));
}

/** Preserve JavaScript-only values in a JSON result using paths relative to the returned slice. */
function normalizeArtifactResult(record: Record<string, unknown>): Record<string, unknown> {
  if (record.result === undefined) return { ...record, result: null, resultType: "undefined" };
  const undefinedPaths: Array<Array<string | number>> = [];
  const holePaths: Array<Array<string | number>> = [];
  const numberPaths: Array<{ path: Array<string | number>; value: string }> = [];
  const bigintPaths: Array<{ path: Array<string | number>; value: string }> = [];
  const typePaths: Array<{ path: Array<string | number>; type: string; name?: string }> = [];
  const visit = (value: unknown, path: Array<string | number>): unknown => {
    if (value === undefined) { undefinedPaths.push([...path]); return null; }
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
      numberPaths.push({ path: [...path], value: Object.is(value, -0) ? "-0" : String(value) }); return null;
    }
    if (typeof value === "bigint") { bigintPaths.push({ path: [...path], value: String(value) }); return null; }
    if (isDate(value)) {
      typePaths.push({ path: [...path], type: "date" });
      return Number.isNaN(dateValue(value)) ? null : dateISOString(value);
    }
    if (isRegExp(value)) {
      typePaths.push({ path: [...path], type: "regexp" });
      path.push("lastIndex"); const lastIndex = visit(value.lastIndex, path); path.pop();
      return { source: regexpSource(value), flags: regexpFlagString(value), lastIndex };
    }
    if (isArrayBuffer(value) || ArrayBuffer.isView(value)) {
      const layout = ArrayBuffer.isView(value) ? viewLayout(value) : undefined;
      const bytes = layout ? new Uint8Array(layout.buffer, layout.byteOffset, layout.byteLength) : new Uint8Array(value as ArrayBuffer);
      typePaths.push({ path: [...path], type: layout ? "typed-array" : "array-buffer", ...(layout ? { name: arrayViewName(value as ArrayBufferView) } : {}) });
      return bytesBase64(bytes);
    }
    if (isMap(value)) {
      typePaths.push({ path: [...path], type: "map" });
      return Array.from(mapEntries(value), ([key, item], index) => {
        path.push(index, 0); const normalizedKey = visit(key, path); path.pop();
        path.push(1); const normalizedValue = visit(item, path); path.pop(); path.pop();
        return [normalizedKey, normalizedValue];
      });
    }
    if (isSet(value)) {
      typePaths.push({ path: [...path], type: "set" });
      return Array.from(setValues(value), (item, index) => { path.push(index); const normalized = visit(item, path); path.pop(); return normalized; });
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          holePaths.push([...path, index]);
          copy ??= copyArray(value); copy[index] = null;
          continue;
        }
        path.push(index);
        const next = visit(value[index], path);
        path.pop();
        if (next !== value[index]) { copy ??= copyArray(value); copy[index] = next; }
      }
      return copy ?? value;
    }
    if (!value || typeof value !== "object") return value;
    let copy: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      path.push(key);
      const next = visit(item, path);
      path.pop();
      if (next !== item) {
        copy ??= { ...value as Record<string, unknown> };
        Object.defineProperty(copy, key, { value: next, enumerable: true, configurable: true, writable: true });
      }
    }
    return copy ?? value;
  };
  const result = visit(record.result, []);
  return { ...record, result, ...(undefinedPaths.length ? { undefinedPaths } : {}), ...(holePaths.length ? { holePaths } : {}),
    ...(numberPaths.length ? { numberPaths } : {}), ...(bigintPaths.length ? { bigintPaths } : {}), ...(typePaths.length ? { typePaths } : {}) };
}

/** Normalize only historical outputs containing JavaScript-only values. */
export function normalizeRecoveredToolOutput(value: unknown): unknown {
  if (!hasNonJsonValues(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return normalizeResultEnvelope(value as Record<string, unknown>);
  return normalizeArtifactResult({ result: value, envelopeWrapped: true });
}
