import { isArrayBuffer, isMap, isSet, viewLayout } from "../log-graph";
import { normalizationExceedsBudget, normalizeResultEnvelope } from "../tool-result-values";

export type JobResultInfo = { limit?: number; error?: Record<string, unknown>; artifact?: Record<string, unknown>; screenshot?: Record<string, unknown>; inlineScreenshot?: boolean; visualContext?: Record<string, unknown> };

const UNDISPATCHED_CODES = new Set(["not-found", "strict-mode", "intercepted", "stale-ref", "stale-observation", "prior-action-failed"]);
const UNDISPATCHED_NEXT: Record<string, string> = {
  "not-found": "Nothing was dispatched. Inspect the page and choose a different element.",
  "strict-mode": "Nothing was dispatched. Narrow the locator to one element, then retry.",
  "intercepted": "Nothing was dispatched. Dismiss what covers the target or choose another element, then retry.",
  "stale-ref": "Nothing was dispatched. Re-observe the page and use a fresh ref.",
  "stale-observation": "Nothing was dispatched. Call inspect_page again and continue from the new snapshot.",
  "prior-action-failed": "Nothing was dispatched. An earlier call in this step failed. Inspect the page and try a different action.",
};

/** Classify a tool failure for the model: whether it can continue, and whether input was sent. */
export function toolErrorSemantics(input: { code?: unknown; effectUnknown?: unknown; dispatchState?: unknown } | undefined): { retryable: boolean; recoverable: boolean; dispatched: boolean; nextStep: string } {
  const code = typeof input?.code === "string" && input.code ? input.code : "tool-error";
  if (input?.effectUnknown === true) return {
    retryable: false, recoverable: false, dispatched: true,
    nextStep: "The action may have changed the page. Inspect it and do not repeat the action until you know the outcome.",
  };
  if (input?.dispatchState === "not-dispatched" || UNDISPATCHED_CODES.has(code)) return {
    retryable: true, recoverable: true, dispatched: false,
    nextStep: UNDISPATCHED_NEXT[code] ?? "Nothing was dispatched. Inspect the page and try a different approach.",
  };
  if (code === "timeout") return {
    retryable: true, recoverable: true, dispatched: false,
    nextStep: "The wait ended before an effect was confirmed. Inspect the page, then retry with a bounded wait if it is still missing.",
  };
  if (code === "aborted") return {
    retryable: false, recoverable: false, dispatched: false,
    nextStep: "The action was interrupted before it was dispatched.",
  };
  return {
    retryable: false, recoverable: false, dispatched: false,
    nextStep: "Inspect the page before choosing a different action. Do not repeat this call unchanged.",
  };
}
const references = new WeakMap<object, { id: number; info: JobResultInfo }>();
export function jobResultReference(id: number, info: JobResultInfo): object {
  const reference = Object.freeze({});
  references.set(reference, { id, info });
  return reference;
}
export function jobResultReferenceInfo(value: unknown): { id: number; info: JobResultInfo } | undefined {
  return value && typeof value === "object" ? references.get(value) : undefined;
}
/** Reserve room for status and receipts alongside the result. */
export function shouldStoreJobResult(value: unknown): boolean {
  const envelope = { result: value };
  if (normalizationExceedsBudget(envelope)) return true;
  const serialized = JSON.stringify(normalizeResultEnvelope(envelope));
  return serialized !== undefined && new TextEncoder().encode(serialized).byteLength > 6 * 1024;
}
export function describeJobResult(value: unknown): JobResultInfo {
  const info: JobResultInfo = {};
  if (typeof value === "string") info.limit = 1000;
  else if (Array.isArray(value) || isMap(value) || isSet(value)) info.limit = 25;
  else if (isArrayBuffer(value)) info.limit = 3072;
  else if (ArrayBuffer.isView(value)) {
    const { byteLength, length } = viewLayout(value);
    info.limit = Math.max(1, Math.floor(3072 / (length ? byteLength / length : 1)));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return info;
  // Metadata must not invoke user getters or affect whether the completed job succeeds.
  try {
    const own = (object: object, key: string): any => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const errorValue = own(value, "error");
    if (own(value, "ok") === false && errorValue && typeof errorValue === "object") {
      const code = own(errorValue, "code");
      const message = own(errorValue, "message");
      const effectUnknown = own(errorValue, "effectUnknown") === true;
      const error: Record<string, unknown> = {
        ...toolErrorSemantics({ code, effectUnknown, dispatchState: own(errorValue, "dispatchState") }),
        ...(typeof code === "string" ? { code: code.slice(0, 128) } : {}),
        ...(typeof message === "string" ? { message: message.slice(0, 2000) } : {}),
        ...(effectUnknown ? { effectUnknown: true } : {}),
      };
      info.error = error;
      const source = own(value, "artifact");
      if (source && typeof source === "object") {
        const artifact: Record<string, unknown> = {};
        for (const key of ["id", "byteLength", "downloadId"]) { const field = own(source, key); if (Number.isSafeInteger(field) && field >= 0) artifact[key] = field; }
        for (const key of ["filename", "mimeType"]) { const field = own(source, key); if (typeof field === "string") artifact[key] = field.slice(0, 512); }
        const saved = own(source, "saved"); if (typeof saved === "boolean") artifact.saved = saved;
        info.artifact = artifact;
      }
    }
    const image = own(value, "screenshot");
    if (image && typeof image === "object") {
      const artifactId = own(image, "artifactId");
      const data = own(image, "data");
      if (typeof data === "string" && data.length > 0 || Number.isSafeInteger(artifactId) && artifactId > 0) {
        const inlineScreenshot = typeof data === "string" && data.length > 0;
        const screenshot: Record<string, unknown> = inlineScreenshot ? {} : { artifactId };
        const mediaType = own(image, "mediaType"); if (typeof mediaType === "string" && mediaType.length <= 128) screenshot.mediaType = mediaType;
        for (const key of ["width", "height", "scale"]) { const field = own(image, key); if (typeof field === "number" && Number.isFinite(field)) screenshot[key] = field; }
        const origin = own(image, "origin");
        if (origin && typeof origin === "object") { const x = own(origin, "x"), y = own(origin, "y"); if (Number.isFinite(x) && Number.isFinite(y)) screenshot.origin = { x, y }; }
        info.screenshot = screenshot;
        if (inlineScreenshot) info.inlineScreenshot = true;
        const visual: Record<string, unknown> = {};
        const observationId = own(value, "observationId");
        if (typeof observationId === "string" && observationId.length <= 512) visual.observationId = observationId;
        for (const key of ["tabId", "documentId"]) { const field = own(value, key); if (Number.isSafeInteger(field) && field >= 0) visual[key] = field; }
        const viewport = own(value, "viewport");
        if (viewport && typeof viewport === "object") {
          const geometry: Record<string, number> = {};
          for (const key of ["x", "y", "width", "height", "scale"]) { const field = own(viewport, key); if (typeof field === "number" && Number.isFinite(field)) geometry[key] = field; }
          visual.viewport = geometry;
        }
        const page = own(value, "page");
        if (page && typeof page === "object") {
          const details: Record<string, string> = {};
          for (const key of ["url", "title"]) { const field = own(page, key); if (typeof field === "string") details[key] = field.slice(0, key === "url" ? 1024 : 512); }
          visual.page = details;
        }
        info.visualContext = visual;
      }
    }
  } catch { /* Unavailable metadata never changes the job result. */ }
  return info;
}
