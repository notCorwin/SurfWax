import type { EventLogger } from "../logging";
import { artifactPagePath } from "../artifact-selection";
import { normalizationExceedsBudget, normalizeResultEnvelope, TOOL_RESULT_BYTES } from "../tool-result-values";
import { readDiagnosticPagination, SOURCE_PAGINATION_NOTE } from "./job-result";

/** Model-facing paging only. Native artifacts.read continues to return raw values. */
export async function readArtifactPage(logger: EventLogger, input: { artifactId: number; path?: (string | number)[]; offset?: number; limit?: number }, conversationId: string, signal?: AbortSignal, evidenceId?: string, pageSnapshotStatus?: Record<string, unknown>): Promise<unknown> {
  const path = input.path ?? [];
  const read = async <T>(task: () => Promise<T>) => { signal?.throwIfAborted(); const value = await task(); signal?.throwIfAborted(); return value; };
  const metadataCache = new Map<string, ReturnType<EventLogger["resultMetadata"]>>();
  const metadata = (path: (string | number)[]) => {
    const key = JSON.stringify(path);
    let task = metadataCache.get(key);
    if (!task) { task = read(() => logger.resultMetadata(input.artifactId, path, conversationId)); metadataCache.set(key, task); }
    return task;
  };
  const info = await metadata(path);
  const source = { artifactId: input.artifactId, path };
  // Payload field names alone cannot establish a diagnostic source.
  let sourceStatus: Record<string, unknown> = {};
  if (["messages", "requests"].includes(String(path.at(-1)))) {
    const pagination = await readDiagnosticPagination(logger, input.artifactId, path.slice(0, -1), conversationId, signal, String(path.at(-1)));
    if (pagination) sourceStatus = { sourcePagination: pagination, sourcePaginationNote: SOURCE_PAGINATION_NOTE };
  }
  const total = info.total;
  // Preserve ordinary object/scalar pagination errors from the native reader.
  if (total === undefined && (input.offset !== undefined || input.limit !== undefined))
    return read(() => logger.result(input.artifactId, input, conversationId));
  const start = total === undefined ? 0 : Math.min(total, input.offset ?? 0);
  let count = total === undefined ? undefined : Math.min(total - start, input.limit ?? total, info.type === "string" ? 4000 : 50);
  const nextHint = async (narrowPath: (string | number)[]) => artifactPagePath(narrowPath, narrowPath, {
    keys: async value => (await metadata(value)).keys ?? [],
    field: (value, key) => [...value, key],
    kind: async value => { const item = await metadata(value); return item.total !== undefined ? item.type === "string" ? "string" : "collection" : item.keys ? "object" : "scalar"; },
  });
  while (true) {
    const value = await read(() => logger.result(input.artifactId, { path, ...(count === undefined ? {} : { offset: start, limit: count }) }, conversationId));
    const end = start + (count ?? 0);
    const hasMore = total !== undefined && end < total;
    const paging = total === undefined ? {} : { range: { start, endExclusive: end }, total, hasMore, partial: hasMore || start > 0,
      ...(hasMore ? { nextAccess: { ...source, offset: end, limit: Math.max(1, count!) } } : {}) };
    if (!normalizationExceedsBudget(value)) {
      const output = normalizeResultEnvelope({ ok: true, result: value, sourceAccess: source, ...paging, ...sourceStatus, ...(pageSnapshotStatus ? { pageSnapshotStatus } : {}) });
      if (new TextEncoder().encode(JSON.stringify({ ...output, ...(evidenceId === undefined ? {} : { evidenceId }) })).byteLength <= TOOL_RESULT_BYTES) return output;
    }
    if (count !== undefined && count > 1) { count = Math.max(1, Math.floor(count / 2)); continue; }
    const narrowPath = count === 1 && info.type !== "string" ? [...path, start] : path;
    const narrowInfo = await metadata(narrowPath);
    const pagePath = narrowInfo.total !== undefined && narrowPath.length > path.length ? narrowPath : await nextHint(narrowPath);
    const firstKey = pagePath ? undefined : narrowInfo.keys?.[0];
    const nextPath = pagePath ?? (firstKey === undefined ? undefined : [...narrowPath, firstKey]);
    const failureStatus = pageSnapshotStatus ? { ...pageSnapshotStatus, state: "unavailable", reason: "tool-failed", freshness: "unknown",
      guidance: "Use inspect_page for current page state; previous observations may be stale." } : undefined;
    const failure = { ok: false, $ref: input.artifactId, sourceAccess: source, partial: true, ...sourceStatus, ...(failureStatus ? { pageSnapshotStatus: failureStatus } : {}),
      ...(total === undefined ? {} : { range: { start, endExclusive: start }, total, hasMore: start < total }),
      error: { code: "artifact-selection-too-large", message: `Selected data exceeds the response budget; no data was returned. ${nextPath ? "Read the narrower field in access." : "Select a smaller source field instead of repeating this read."} Use offset/limit only on a collection or string.` },
      ...(nextPath ? { access: { artifactId: input.artifactId, path: nextPath, ...(pagePath ? { offset: 0, limit: 1 } : {}) } } : {}) };
    if (new TextEncoder().encode(JSON.stringify({ ...failure, ...(evidenceId === undefined ? {} : { evidenceId }) })).byteLength <= TOOL_RESULT_BYTES) return failure;
    // No data was delivered. Omit oversized advisory paths explicitly rather
    // than returning a truncated path that would address a different value.
    const { sourceAccess: _sourceAccess, access: _access, ...boundedFailure } = failure;
    return { ...boundedFailure, selectionMetadataOmitted: true,
      error: { code: "artifact-selection-too-large", message: "No data was returned. Selection paths exceed the response budget and were omitted; choose a smaller source field using the original artifact and selection." } };
  }
}
