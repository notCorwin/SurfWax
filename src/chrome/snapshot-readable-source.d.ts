import type { NativeSnapshotProofs, ReadableSnapshot } from "./snapshot-readable";
export function sampleReadableSnapshot(pageZoom?: number, nativeRoots?: readonly ShadowRoot[], nativeProofs?: NativeSnapshotProofs, textEvidence?: { scope: Element; accept: (nodes: Set<Text>, unknown: Set<Element>, items: Array<{ node: Text; text: string }>) => void }): ReadableSnapshot | null;
