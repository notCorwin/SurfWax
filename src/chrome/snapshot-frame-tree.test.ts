import { describe, expect, it } from "vitest";
import { stitchSnapshotFrames, type SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode, type SnapshotNode } from "./snapshot-render";
import { compactSnapshot } from "./snapshot-presentation";

function row(id: string, depth: number, role: string, options: Partial<SnapshotNode> = {}): SnapshotLine {
  const node: SnapshotNode = { id, depth, role, ...options };
  return { ...renderSnapshotNode(node), node };
}
function marker(id: string, frameRef: string): SnapshotLine {
  return row(id, 0, "frame-document", { documentFrameRef: frameRef });
}

describe("snapshot frame tree", () => {
  it("places nested documents at the owner, preserving siblings and action references", () => {
    const frames = [
      { frameRef: "root", lines: [row("root", 0, "RootWebArea"), row("main", 1, "main"),
        row("owner", 2, "Iframe", { name: "Workspace", childFrameRef: "workspace" }),
        row("decoy", 2, "button", { name: "Send", ref: "decoy-ref" })] },
      { frameRef: "workspace", lines: [marker("workspace-doc", "workspace"), row("workspace-root", 1, "RootWebArea"),
        row("editor-owner", 3, "Iframe", { name: "Editor", childFrameRef: "editor" })] },
      { frameRef: "editor", lines: [marker("editor-doc", "editor"), row("editor-root", 1, "RootWebArea"),
        row("send", 3, "button", { name: "Send", ref: "send-ref" })] },
    ];
    const result = stitchSnapshotFrames(frames, "root");
    expect(result.map(({ id }) => id)).toEqual(["root", "main", "owner", "workspace-doc", "workspace-root", "editor-owner", "editor-doc", "editor-root", "send", "decoy"]);
    expect(result.map(({ line }) => line)).toEqual([
      "- RootWebArea", "  - main", '    - Iframe "Workspace" [frameRef=workspace]',
      "      - frame-document [frameRef=workspace]", "        - RootWebArea",
      '            - Iframe "Editor" [frameRef=editor]', "              - frame-document [frameRef=editor]",
      "                - RootWebArea", '                    - button "Send" [ref=send-ref]',
      '    - button "Send" [ref=decoy-ref]',
    ]);
    const send = result.find(({ id }) => id === "send")!;
    expect(send.node?.depth).toBe(10);
    expect(renderSnapshotNode(send.node!, { inlineRef: false }).line).toBe('                    - button "Send"');
    expect(send.ref).toBe("send-ref");
  });

  it("treats a scoped frame as the root and explicitly retains unrepresented owners", () => {
    const frames = [
      { frameRef: "scoped", lines: [marker("scoped-doc", "scoped"), row("content", 1, "main")] },
      { frameRef: "unrepresented", lines: [marker("orphan-doc", "unrepresented"), row("orphan-child", 1, "button")] },
    ];
    const result = stitchSnapshotFrames(frames, "scoped");
    expect(result.map(({ line }) => line)).toEqual([
      "- frame-document [frameRef=scoped]", "  - main",
      "- frame-document [frameRef=unrepresented] [owner=unrepresented]", "  - button",
    ]);
  });

  it("reparents document markers and child content with a compacted iframe ancestor", () => {
    const stitched = stitchSnapshotFrames([
      { frameRef: "root", lines: [row("root", 0, "RootWebArea"), row("wrapper", 1, "generic"),
        row("owner", 2, "Iframe", { childFrameRef: "child" })] },
      { frameRef: "child", lines: [marker("document", "child"), row("child-root", 1, "RootWebArea"),
        row("button", 2, "button", { name: "Open" })] },
    ], "root");
    const compacted = compactSnapshot(stitched);
    expect(compacted.map((line) => [line.id, line.node?.depth])).toEqual([
      ["root", 0], ["owner", 1], ["document", 2], ["child-root", 3], ["button", 4],
    ]);
    expect(compacted.find(({ id }) => id === "document")?.line).toBe("    - frame-document [frameRef=child]");
  });
});
