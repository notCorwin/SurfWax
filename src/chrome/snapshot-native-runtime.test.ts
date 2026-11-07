import { expect, it } from "vitest";
import { nativeControlCandidates } from "./snapshot-native-runtime";

it("discovers author fields in one document without treating UA-internal controls as author hosts", () => {
  const snapshot = { strings: ["root", "child", "#document", "INPUT", "#document-fragment", "user-agent", "closed", "SELECT"], documents: [
    { frameId: 0, nodes: { backendNodeId: [1, 2, 3, 4, 5, 6, 7], parentIndex: [-1, 0, 1, 2, 0, 4, 5], nodeType: [9, 1, 11, 1, 1, 11, 1],
      nodeName: [2, 3, 4, 3, 3, 4, 7], shadowRootType: { index: [2, 5], value: [5, 6] } } },
    { frameId: 1, nodes: { backendNodeId: [8, 9], parentIndex: [-1, 0], nodeType: [9, 1], nodeName: [2, 3] } },
  ] };
  expect(nativeControlCandidates(snapshot, "root")).toEqual({ documentBackendNodeId: 1, hosts: [2, 5, 7] });
  expect(nativeControlCandidates(snapshot, "child")).toEqual({ documentBackendNodeId: 8, hosts: [9] });
  expect(nativeControlCandidates(snapshot, "missing")).toBeUndefined();
  snapshot.documents[0]!.nodes.parentIndex[6] = 6;
  expect(nativeControlCandidates(snapshot, "root")).toBeUndefined();
});
