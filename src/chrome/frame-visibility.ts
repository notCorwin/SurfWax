/** Whether an iframe and every embedding iframe can be rendered. */
export type FrameVisibility = "visible" | "hidden" | "unknown";

/**
 * Combine the visibility of each iframe owner with the frame ancestry.
 *
 * A frame owner's visibility applies only within its own document. Checking the
 * full chain also accounts for same-process frames between separate targets.
 * Missing owners, missing ancestry and cycles are unknown, never assumed
 * visible. Results are memoized for this capture only.
 */
export function createFrameVisibility(
  rootFrameId: string,
  parents: ReadonlyMap<string, string | undefined>,
  owners: ReadonlyMap<string, boolean>,
): (frameId: string) => FrameVisibility {
  const memo = new Map<string, FrameVisibility>([[rootFrameId, "visible"]]);
  return (frameId) => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = frameId;
    let result: FrameVisibility;
    while (true) {
      const known = memo.get(current);
      if (known !== undefined) { result = known; break; }
      if (seen.has(current)) { result = "unknown"; break; }
      seen.add(current);
      path.push(current);
      if (!parents.has(current)) { result = "unknown"; break; }
      const parent = parents.get(current);
      if (!parent) { result = "unknown"; break; }
      current = parent;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      const id = path[index]!;
      const owner = owners.get(id);
      if (owner === false || result === "hidden") result = "hidden";
      else if (owner === undefined || result === "unknown") result = "unknown";
      memo.set(id, result);
    }
    return result;
  };
}
