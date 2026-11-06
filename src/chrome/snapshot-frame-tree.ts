import type { SnapshotNode } from "./snapshot-render";

export type SnapshotLine = { id: string; line: string; ref?: string; node?: SnapshotNode };
type FrameSnapshot = { frameRef: string; lines: SnapshotLine[] };

/** Nest captured documents under their represented owner without parsing page text. */
export function stitchSnapshotFrames(frames: FrameSnapshot[], rootFrameRef: string | undefined): SnapshotLine[] {
  const remaining = new Map(frames.map((frame) => [frame.frameRef, frame]));
  const result: SnapshotLine[] = [];
  const append = (root: FrameSnapshot, orphan: boolean) => {
    const stack = [{ frame: root, index: 0, offset: 0, orphan }];
    remaining.delete(root.frameRef);
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      if (current.index === current.frame.lines.length) { stack.pop(); continue; }
      const index = current.index++, original = current.frame.lines[index]!;
      const node = original.node && { ...original.node, depth: original.node.depth + current.offset,
        ...(current.orphan && index === 0 ? { ownerUnrepresented: true as const } : {}) };
      const line = `${"  ".repeat(current.offset)}${original.line}${current.orphan && index === 0 ? " [owner=unrepresented]" : ""}`;
      result.push({ ...original, line, ...(node ? { node } : {}) });
      const child = node?.childFrameRef && remaining.get(node.childFrameRef);
      if (child) {
        remaining.delete(child.frameRef);
        stack.push({ frame: child, index: 0, offset: node.depth + 1, orphan: false });
      }
    }
  };
  const root = rootFrameRef && remaining.get(rootFrameRef);
  if (root) append(root, false);
  // When the owner is not represented by AX or the DOM supplement, retain
  // the document and make the missing relationship explicit rather than
  // pretending it belongs under an unrelated node.
  while (remaining.size) append(remaining.values().next().value!, true);
  return result;
}
