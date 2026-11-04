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
      if (kind === "string") stringPath ??= next;
      if (kind === "object" && next.length < path.length + 2)
        queue.push({ value, path: next });
    }
  }
  return incomplete ? undefined : stringPath;
}
