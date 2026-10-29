const RESULT_SIDECAR_FIELDS = new Set(["resultType", "undefinedPaths", "holePaths", "numberPaths", "bigintPaths", "undefinedCount", "holeCount", "numberCount", "bigintCount", "undefinedPathsAccess", "holePathsAccess", "numberPathsAccess", "bigintPathsAccess", "undefinedPathsOversizedItem", "holePathsOversizedItem", "numberPathsOversizedItem", "bigintPathsOversizedItem", "pathsNote", "envelopeWrapped"]);

/** Bound the work and sidecar allocation before walking a result for JSON output. */
export function normalizationExceedsBudget(value: unknown, budget = 32768): boolean {
  const active = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 100) return true;
    if (item === undefined || typeof item === "bigint" || typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      budget -= depth;
      return budget < 0;
    }
    if (!item || typeof item !== "object") return false;
    if (active.has(item)) return true;
    active.add(item);
    try {
      if (Array.isArray(item)) {
        // Every position becomes a JSON value, including holes. Do not iterate
        // an enormous sparse length just to discover that it exceeds budget.
        if (item.length > budget) return true;
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) { budget -= depth + 1; if (budget < 0) return true; }
          else if (visit(item[i], depth + 1)) return true;
        }
        return false;
      }
      for (const key in item) if (Object.hasOwn(item, key) && visit((item as Record<string, unknown>)[key], depth + 1)) return true;
      return false;
    } finally { active.delete(item); }
  };
  return visit(value, 0);
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
  const visit = (value: unknown, path: Array<string | number>): unknown => {
    if (value === undefined) { undefinedPaths.push([...path]); return null; }
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
      numberPaths.push({ path: [...path], value: Object.is(value, -0) ? "-0" : String(value) }); return null;
    }
    if (typeof value === "bigint") { bigintPaths.push({ path: [...path], value: String(value) }); return null; }
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
    ...(numberPaths.length ? { numberPaths } : {}), ...(bigintPaths.length ? { bigintPaths } : {}) };
}

/** Normalize only historical outputs containing JavaScript-only values. */
export function normalizeRecoveredToolOutput(value: unknown): unknown {
  if (!hasNonJsonValues(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return normalizeResultEnvelope(value as Record<string, unknown>);
  return normalizeArtifactResult({ result: value, envelopeWrapped: true });
}
