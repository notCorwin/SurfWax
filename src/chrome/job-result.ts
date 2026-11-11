import { artifactReadSelection, nativeArtifactPageLimit } from "../artifact-selection";
import { normalizationExceedsBudget, normalizeResultEnvelope } from "../tool-result-values";
import type { EventLogger } from "../logging";

export const SOURCE_PAGINATION_FIELDS = ["hasMore", "nextOffset", "nextCursor", "rangeComplete", "integrity", "reason"] as const;
export const SOURCE_PAGINATION_NOTE = "Artifact hasMore/total cover only the stored slice. If sourcePagination.hasMore=true, continue the originating diagnostic tool with its nextOffset or nextCursor after reading this slice. Range completion does not prove complete capture.";
const metadataEncoder = new TextEncoder();

/** Bounded own data properties only; never execute a result's getters. */
export function sourcePaginationOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pagination: Record<string, unknown> = {};
  try {
    for (const key of SOURCE_PAGINATION_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const field = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (key === "hasMore" ? typeof field === "boolean" || field === null
        : key === "rangeComplete" ? typeof field === "boolean"
        : key === "nextOffset" ? Number.isSafeInteger(field) && field >= 0
        : key === "integrity" ? ["complete", "incomplete", "unknown"].includes(field)
        : typeof field === "string" && field.length <= (key === "nextCursor" ? 512 : 256)
          && metadataEncoder.encode(JSON.stringify(field)).byteLength <= (key === "nextCursor" ? 512 : 256)) pagination[key] = field;
    }
  } catch { return undefined; }
  return Object.hasOwn(pagination, "hasMore") || Object.hasOwn(pagination, "rangeComplete") ? pagination : undefined;
}

/** Only the known diagnostic record layouts may contribute harness metadata. */
export async function readDiagnosticPagination(logger: EventLogger, artifactId: number, parentPath: (string | number)[], conversationId: string, signal?: AbortSignal, requestedCollection?: string): Promise<Record<string, unknown> | undefined> {
  if (parentPath.length > 2 || parentPath.some(key => key !== "result")) return undefined;
  const read = async <T>(task: () => Promise<T>) => { signal?.throwIfAborted(); const value = await task(); signal?.throwIfAborted(); return value; };
  const origin = await read(() => logger.resultToolName(artifactId, conversationId));
  if (origin !== "read_console" && origin !== "list_requests" || parentPath.length === 0 && origin !== "read_console") return undefined;
  const root = await read(() => logger.resultMetadata(artifactId, [], conversationId));
  if (parentPath.length === 2 && (!root.keys?.includes("envelopeWrapped")
    || await read(() => logger.result(artifactId, { path: ["envelopeWrapped"] }, conversationId)) !== true)) return undefined;
  const parent = parentPath.length ? await read(() => logger.resultMetadata(artifactId, parentPath, conversationId)) : root;
  const collection = origin === "read_console" ? "messages" : "requests";
  if (requestedCollection !== undefined && requestedCollection !== collection) return undefined;
  if (!parent.keys?.includes(collection) || !parent.keys.includes("hasMore") || !parent.keys.includes("integrity")) return undefined;
  if (parentPath.length === 0 && (!parent.keys.includes("mode")
    || await read(() => logger.result(artifactId, { path: ["mode"] }, conversationId)) !== "retained")) return undefined;
  const fields = await Promise.all(SOURCE_PAGINATION_FIELDS.filter(key => parent.keys!.includes(key)).map(async key => {
    const path = [...parentPath, key];
    const info = await read(() => logger.resultMetadata(artifactId, path, conversationId));
    if (!(["boolean", "number", "string"].includes(info.type) || key === "hasMore" && info.type === "object" && !info.keys)
      || info.total !== undefined && info.total > 512) return [];
    return [[key, await read(() => logger.result(artifactId, { path }, conversationId))]];
  }));
  return sourcePaginationOf(Object.fromEntries(fields.flat()));
}

export type JobResultInfo = { limit?: number; page?: { path: (string | number)[]; limit: number }; error?: Record<string, unknown>; artifact?: Record<string, unknown>; screenshot?: Record<string, unknown>; inlineScreenshot?: boolean; visualContext?: Record<string, unknown> };
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
export async function describeJobResult(value: unknown): Promise<JobResultInfo> {
  const info: JobResultInfo = {};
  const limit = nativeArtifactPageLimit(value);
  if (limit !== undefined) info.limit = limit;
  const selected = await artifactReadSelection(value, ["result"]);
  const pageLimit = nativeArtifactPageLimit(selected.value);
  if (pageLimit !== undefined) info.page = { path: selected.path, limit: pageLimit };
  if (!value || typeof value !== "object" || Array.isArray(value)) return info;
  // Metadata must not invoke user getters or affect whether the completed job succeeds.
  try {
    const own = (object: object, key: string): any => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const errorValue = own(value, "error");
    if (own(value, "ok") === false && errorValue && typeof errorValue === "object") {
      const error: Record<string, unknown> = { retryable: false };
      for (const key of ["code", "message"]) {
        const field = own(errorValue, key);
        if (typeof field === "string") error[key] = field.slice(0, key === "code" ? 128 : 2000);
      }
      if (own(errorValue, "effectUnknown") === true) error.effectUnknown = true;
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
