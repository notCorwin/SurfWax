import { EventLogger } from "../logging";

/** Failure diagnostics for background model metadata operations, which may run outside a conversation. */
export type ModelDiagnostic = { operationId: string; operation: string; phase: string; error: DiagnosticError; status?: number };
type DiagnosticError = { name: string; message: string; stack?: string; cause?: DiagnosticError };
type Sink = (diagnostic: ModelDiagnostic) => void;
let logger: EventLogger | undefined;

export function safeDiagnosticText(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|authorization)(["'\s:=]+)[^\s,}"']+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]+/gi, "$1?[redacted]").slice(0, 2048);
}
function describe(error: unknown, depth = 0): DiagnosticError {
  const result: DiagnosticError = { name: error instanceof Error ? error.name : "Error", message: safeDiagnosticText(error instanceof Error ? error.message : String(error)) };
  if (error instanceof Error && error.stack) result.stack = safeDiagnosticText(error.stack);
  if (error instanceof Error && error.cause !== undefined && depth < 3 && error.cause !== error) result.cause = describe(error.cause, depth + 1);
  return result;
}
export function modelDiagnostic(operationId: string, operation: string, phase: string, error: unknown, sink?: Sink, status?: number): void {
  const diagnostic: ModelDiagnostic = { operationId, operation, phase,
    error: describe(error),
    ...(status === undefined ? {} : { status }) };
  if (sink) { sink(diagnostic); return; }
  // Keep a separate signal if the canonical store itself is unavailable.
  console.warn("[Surf Wax] model diagnostic", diagnostic);
  if (typeof indexedDB !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
      logger ??= new EventLogger();
      logger.telemetry({ type: "model.metadata.failed", content: diagnostic });
    } catch (loggingError) {
      console.warn("[Surf Wax] model diagnostic logging failed", describe(loggingError));
    }
  }
}
