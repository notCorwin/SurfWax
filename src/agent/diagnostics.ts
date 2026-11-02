import { EventLogger } from "../logging";
import { safeDiagnosticError, safeDiagnosticText as sanitizeText } from "../diagnostic-error";

/** Failure diagnostics for background model metadata operations, which may run outside a conversation. */
export type ModelDiagnostic = { operationId: string; operation: string; phase: string; error: DiagnosticError; status?: number; conversationId?: string; runId?: string };
export type ModelDiagnosticContext = { logger: EventLogger; conversationId: string; runId?: string };
export function modelDiagnosticContext(logger?: EventLogger, conversationId?: string): ModelDiagnosticContext | undefined {
  return logger && conversationId ? { logger, conversationId, runId: logger.toolIdentity(conversationId, "").runId } : undefined;
}
export function linkModelDiagnostic(context: ModelDiagnosticContext | undefined, operationId: string, operation: string): void {
  if (!context) return;
  context.logger.telemetry({ type: "model.metadata.linked", ...(context.runId ? { conversationId: context.conversationId, runId: context.runId } : {}),
    content: { operationId, operation, conversationId: context.conversationId } });
}
type DiagnosticError = { name: string; message: string; stack?: string; cause?: DiagnosticError };
type Sink = (diagnostic: ModelDiagnostic) => void;
let logger: EventLogger | undefined;

export function safeDiagnosticText(value: string): string {
  return sanitizeText(value).slice(0, 2048);
}
function describe(error: unknown, depth = 0): DiagnosticError {
  const safe = safeDiagnosticError(error);
  const result: DiagnosticError = { name: safe.name, message: safeDiagnosticText(safe.message) };
  if (safe.stack) result.stack = safeDiagnosticText(safe.stack);
  if (safe.cause !== undefined && depth < 3) result.cause = describe(safe.cause, depth + 1);
  return result;
}
export function modelDiagnostic(operationId: string, operation: string, phase: string, error: unknown, sink?: Sink, status?: number, context?: ModelDiagnosticContext): void {
  const diagnostic: ModelDiagnostic = { operationId, operation, phase,
    error: describe(error),
    ...(status === undefined ? {} : { status }), ...(context ? { conversationId: context.conversationId, ...(context.runId ? { runId: context.runId } : {}) } : {}) };
  if (sink) { sink(diagnostic); return; }
  // Keep a separate signal if the canonical store itself is unavailable.
  console.warn("[Surf Wax] model diagnostic", diagnostic);
  if (context || typeof indexedDB !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
      const target = context?.logger ?? (logger ??= new EventLogger());
      // If the lookup began outside a run, do not let a later run claim it.
      target.telemetry({ type: "model.metadata.failed", ...(context?.runId ? { conversationId: context.conversationId, runId: context.runId } : {}), content: diagnostic });
    } catch (loggingError) {
      console.warn("[Surf Wax] model diagnostic logging failed", describe(loggingError));
    }
  }
}
