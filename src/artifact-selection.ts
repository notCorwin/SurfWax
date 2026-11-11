import { isArrayBuffer, isMap, isSet, viewLayout } from "./log-graph";

export const ARTIFACT_READ_NOTE = "Pass access unchanged to read_artifact for the recommended slice. resultAccess addresses the result value and may include paging. Ordinary objects cannot use offset/limit. All paths start at the stored artifact root.";

export function nativeArtifactPageLimit(value: unknown): number | undefined {
  if (typeof value === "string") return 1000;
  if (Array.isArray(value) || isMap(value) || isSet(value)) return 25;
  if (isArrayBuffer(value)) return 3072;
  if (ArrayBuffer.isView(value)) {
    const { byteLength, length } = viewLayout(value);
    return Math.max(1, Math.floor(3072 / (length ? byteLength / length : 1)));
  }
  return undefined;
}

/** Reuse the bounded search used by pagination errors before an invalid read occurs.
 * Inspect data properties only: describing a result must never execute getters. */
export async function artifactReadSelection(value: unknown, path: readonly (string | number)[]) {
  // HTTP metadata (URL, headers, status text) is not the response payload.
  // Inspect own data properties only, including for worker/native results.
  if (value && typeof value === "object") {
    const body = Object.getOwnPropertyDescriptor(value, "body");
    const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
    if (body && "value" in body && typeof status === "number") {
      value = body.value;
      path = [...path, "body"];
    }
  }
  const selectedPath = nativeArtifactPageLimit(value) !== undefined ? [...path] : await artifactPagePath(value, path, {
    keys: (item) => item && typeof item === "object" ? Object.keys(item) : [],
    field: (item, key) => Object.getOwnPropertyDescriptor(item, key)?.value,
    kind: (item) => typeof item === "string" ? "string" : nativeArtifactPageLimit(item) !== undefined ? "collection"
      : item && typeof item === "object" ? "object" : "scalar",
  });
  if (!selectedPath) return { path: [...path], value };
  for (const key of selectedPath.slice(path.length)) value = Object.getOwnPropertyDescriptor(value, key)?.value;
  return { path: selectedPath, value };
}

/** A pagination error must describe the selected value, never suggest paging
 * an arbitrary first key (often a numeric count such as `total`). */
export function artifactPagingError(
  artifactId: number,
  path: readonly (string | number)[],
  type: string,
  nextPath?: readonly (string | number)[],
  keys: readonly string[] = [],
): Error {
  const selection = { artifactId, path };
  const hint = nextPath
    ? `Page the collection with ${JSON.stringify({ artifactId, path: nextPath, offset: 0, limit: 4000 })}.`
    : type === "object"
      ? `Select a nested collection or string field with path relative to ${JSON.stringify(path)} before paging. Do not request the entire object to discover a page.`
      : `Read this scalar without offset/limit: ${JSON.stringify(selection)}.`;
  return Object.assign(
    new Error(
      `offset/limit requires an array, string, Map, Set, ArrayBuffer or binary view; selected ${type} at path ${JSON.stringify(path)}. ${hint}${keys.length ? ` Available keys: ${keys.map((key) => JSON.stringify(key)).join(", ")}.` : ""}`,
    ),
    { code: "artifact-not-pageable" },
  );
}

/** Bounded metadata-only search, shared by inline and partitioned artifacts.
 * Collections take precedence over status/label strings at every inspected level. */
export async function artifactPagePath<T>(
  root: T,
  path: readonly (string | number)[],
  reader: {
    keys(
      value: T,
    ): readonly (string | null)[] | Promise<readonly (string | null)[]>;
    field(value: T, key: string): T | Promise<T>;
    kind(
      value: T,
    ):
      | "object"
      | "collection"
      | "string"
      | "scalar"
      | Promise<"object" | "collection" | "string" | "scalar">;
  },
): Promise<(string | number)[] | undefined> {
  const queue = [{ value: root, path: [...path] }];
  let stringPath: (string | number)[] | undefined,
    payloadStringPath: (string | number)[] | undefined,
    remaining = 32,
    incomplete = false;
  while (queue.length && remaining > 0) {
    const current = queue.shift()!;
    if ((await reader.kind(current.value)) !== "object") continue;
    const keys = await reader.keys(current.value);
    if (keys.length > 16) incomplete = true;
    for (const key of keys.slice(0, 16)) {
      if (key === null || key.length > 128) {
        incomplete = true;
        continue;
      }
      if (remaining-- <= 0) {
        incomplete = true;
        break;
      }
      const value = await reader.field(current.value, key),
        kind = await reader.kind(value),
        next = [...current.path, key];
      if (kind === "collection") return next;
      if (kind === "string") {
        stringPath ??= next;
        if (["body", "text", "html", "content"].includes(key)) payloadStringPath ??= next;
      }
      if (kind === "object" && next.length < path.length + 2)
        queue.push({ value, path: next });
    }
  }
  return incomplete ? undefined : payloadStringPath ?? stringPath;
}
