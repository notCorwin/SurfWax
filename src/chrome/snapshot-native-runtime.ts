import { sampleReadableSnapshot } from "./snapshot-readable";
import { PLACEHOLDER_EVIDENCE_SOURCE } from "./snapshot-placeholder";
import { SNAPSHOT_CONTROL_PAINT_SOURCE } from "./snapshot-control-paint";

/** The final read receives live roots, never earlier native strings or states. */
export const NATIVE_OBSERVATION_SOURCE = `function(pageZoom,...nativeRoots){
  /* surf-wax:semantic-native-observation */
  if(this!==document || !this.defaultView || this.readyState!=="complete") return null;
  return (${sampleReadableSnapshot.toString()})(pageZoom,nativeRoots,{
    shadowRoots:nativeRoots,
    placeholder:(${PLACEHOLDER_EVIDENCE_SOURCE}),
    controls:(${SNAPSHOT_CONTROL_PAINT_SOURCE})
  });
}`;

export type NativeControlCandidates = { documentBackendNodeId: number; hosts: number[] };

/** Reuse host identities from the bulk capture without retaining its UI text. */
export function nativeControlCandidates(snapshot: any, frameId: string): NativeControlCandidates | undefined {
  const strings = snapshot?.strings;
  const doc = snapshot?.documents?.find((candidate: any) => strings?.[candidate.frameId] === frameId);
  const nodes = doc?.nodes;
  if (!Array.isArray(strings) || !Array.isArray(nodes?.nodeName) || !Array.isArray(nodes?.backendNodeId)
    || !Array.isArray(nodes?.nodeType) || !Array.isArray(nodes?.parentIndex)
    || [nodes.nodeName, nodes.nodeType, nodes.parentIndex].some((items) => items.length !== nodes.backendNodeId.length)) return undefined;
  const documentIndex = nodes.nodeType.indexOf(9), documentBackendNodeId = nodes.backendNodeId[documentIndex];
  if (!Number.isSafeInteger(documentBackendNodeId) || documentBackendNodeId <= 0) return undefined;
  const uaRoots = new Set<number>();
  const shadow = nodes.shadowRootType;
  if (shadow) {
    if (!Array.isArray(shadow.index) || !Array.isArray(shadow.value) || shadow.index.length !== shadow.value.length) return undefined;
    for (let i = 0; i < shadow.index.length; i++) if (strings[shadow.value[i]] === "user-agent") uaRoots.add(shadow.index[i]);
  }
  const scope = new Map<number, boolean>();
  const userAgentDescendant = (index: number): boolean | undefined => {
    const pending: number[] = [], seen = new Set<number>();
    while (index !== -1 && !scope.has(index)) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length || seen.has(index)) return undefined;
      if (uaRoots.has(index)) { scope.set(index, true); break; }
      seen.add(index); pending.push(index); index = nodes.parentIndex[index];
    }
    const value = index !== -1 && scope.get(index) === true;
    for (const node of pending) scope.set(node, value);
    return value;
  };
  const hosts: number[] = [];
  for (let index = 0; index < nodes.nodeName.length; index++) {
    if (nodes.nodeType[index] !== 1 || !/^(?:input|textarea|select)$/i.test(strings[nodes.nodeName[index]] ?? "")) continue;
    const ua = userAgentDescendant(index);
    if (ua === undefined) return undefined;
    const id = nodes.backendNodeId[index];
    if (!ua && Number.isSafeInteger(id) && id > 0) hosts.push(id);
  }
  return { documentBackendNodeId, hosts };
}
