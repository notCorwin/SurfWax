const RESULT_SIDECAR_FIELDS = new Set(["resultType", "undefinedPaths", "holePaths", "numberPaths", "bigintPaths", "typePaths", "undefinedCount", "holeCount", "numberCount", "bigintCount", "typeCount", "undefinedPathsAccess", "holePathsAccess", "numberPathsAccess", "bigintPathsAccess", "typePathsAccess", "undefinedPathsOversizedItem", "holePathsOversizedItem", "numberPathsOversizedItem", "bigintPathsOversizedItem", "typePathsOversizedItem", "pathsNote", "envelopeWrapped"]);

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Bound the work and sidecar allocation before walking a result for JSON output. */
export function normalizationExceedsBudget(value: unknown, budget = 65536): boolean {
  const active = new WeakSet<object>();
  const visit = (item: unknown, depth: number, pathCost: number): boolean => {
    if (--budget < 0 || depth > 100) return true;
    if (typeof item === "string") { budget -= item.length; return budget < 0; }
    if (item === undefined || typeof item === "bigint" || typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      budget -= depth + pathCost;
      return budget < 0;
    }
    if (!item || typeof item !== "object") return false;
    if (active.has(item)) return true;
    active.add(item);
    try {
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
        budget -= Math.ceil(item.byteLength * 4 / 3) + depth + pathCost;
        return budget < 0;
      }
      if (item instanceof RegExp) {
        budget -= depth + pathCost + item.source.length + item.flags.length;
        return budget < 0 || visit(item.lastIndex, depth + 1, pathCost + "lastIndex".length);
      }
      if (item instanceof Date) {
        budget -= depth + pathCost;
        return budget < 0;
      }
      if (item instanceof Map) {
        budget -= depth + pathCost;
        if (budget < 0) return true;
        let index = 0;
        for (const [key, value] of item) {
          const nested = pathCost + String(index++).length + 1;
          if (visit(key, depth + 2, nested) || visit(value, depth + 2, nested)) return true;
        }
        return false;
      }
      if (item instanceof Set) {
        budget -= depth + pathCost;
        if (budget < 0) return true;
        let index = 0;
        for (const value of item) if (visit(value, depth + 1, pathCost + String(index++).length)) return true;
        return false;
      }
      if (Array.isArray(item)) {
        // Every position becomes a JSON value, including holes. Do not iterate
        // an enormous sparse length just to discover that it exceeds budget.
        if (item.length > budget) return true;
        for (let i = 0; i < item.length; i++) {
          const nested = pathCost + String(i).length;
          if (!Object.hasOwn(item, i)) { budget -= depth + 1 + nested; if (budget < 0) return true; }
          else if (visit(item[i], depth + 1, nested)) return true;
        }
        return false;
      }
      for (const key in item) if (Object.hasOwn(item, key)) {
        budget -= key.length;
        if (budget < 0 || visit((item as Record<string, unknown>)[key], depth + 1, pathCost + key.length)) return true;
      }
      return false;
    } finally { active.delete(item); }
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
  if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set) return true;
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
    if (value instanceof Date) {
      typePaths.push({ path: [...path], type: "date" });
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (value instanceof RegExp) {
      typePaths.push({ path: [...path], type: "regexp" });
      path.push("lastIndex"); const lastIndex = visit(value.lastIndex, path); path.pop();
      return { source: value.source, flags: value.flags, lastIndex };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      typePaths.push({ path: [...path], type: value instanceof ArrayBuffer ? "array-buffer" : "typed-array", ...(value instanceof ArrayBuffer ? {} : { name: value.constructor.name }) });
      return bytesBase64(bytes);
    }
    if (value instanceof Map) {
      typePaths.push({ path: [...path], type: "map" });
      return Array.from(value, ([key, item], index) => {
        path.push(index, 0); const normalizedKey = visit(key, path); path.pop();
        path.push(1); const normalizedValue = visit(item, path); path.pop(); path.pop();
        return [normalizedKey, normalizedValue];
      });
    }
    if (value instanceof Set) {
      typePaths.push({ path: [...path], type: "set" });
      return Array.from(value, (item, index) => { path.push(index); const normalized = visit(item, path); path.pop(); return normalized; });
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          holePaths.push([...path, index]);
          copy ??= value.slice(); copy[index] = null;
          continue;
        }
        path.push(index);
        const next = visit(value[index], path);
        path.pop();
        if (next !== value[index]) { copy ??= value.slice(); copy[index] = next; }
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
