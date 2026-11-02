/** Bound and sanitize diagnostic text, not page content or application results. */
export function safeDiagnosticText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s"']+/gi, "$1?[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(["'\s:=]+)[^\s,;}"']+/gi, "$1$2[redacted]")
    .slice(0, 8192);
}

/** Copy only diagnostic Error fields; do not serialize provider-specific payloads. */
export function safeDiagnosticError(value: unknown): Error {
  const seen = new Set<unknown>();
  const copy = (item: unknown, depth: number): Error => {
    if (seen.has(item) || depth >= 5) return new Error("[error cause omitted]");
    if (item && typeof item === "object") seen.add(item);
    let message: string;
    try { message = item instanceof Error ? item.message : String(item); } catch { message = "[unprintable error]"; }
    const result = new Error(safeDiagnosticText(message));
    if (item instanceof Error) {
      result.name = safeDiagnosticText(item.name).slice(0, 128);
      if (item.stack) result.stack = safeDiagnosticText(item.stack);
      if (item.cause !== undefined) result.cause = copy(item.cause, depth + 1);
      if (item instanceof AggregateError) Object.assign(result, { errors: item.errors.slice(0, 10).map((error: unknown) => copy(error, depth + 1)) });
      const code = (item as Error & { code?: unknown }).code;
      if (typeof code === "string" || typeof code === "number") Object.assign(result, { code: typeof code === "string" ? safeDiagnosticText(code) : code });
    }
    if (item && typeof item === "object") seen.delete(item);
    return result;
  };
  return copy(value, 0);
}
