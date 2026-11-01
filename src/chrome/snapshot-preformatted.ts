/**
 * Identify text whose whitespace is preserved by its captured CSS style.
 * This does not establish visibility: callers must still apply the same
 * visibility and text-paint projection rules as every other text node.
 * A projected or clipped string is not interchangeable with this evidence.
 */
export function snapshotPreformattedText(snapshot: any, frameId: string): Map<number, string> {
  if (!Array.isArray(snapshot?.strings) || !Array.isArray(snapshot?.documents)) throw new Error("Invalid DOM snapshot");
  const strings: string[] = snapshot.strings;
  const documents = snapshot.documents.filter((document: any) => strings[document.frameId] === frameId);
  if (documents.length !== 1) throw new Error("Invalid DOM snapshot frame");
  const { nodes, layout } = documents[0];
  if (!Array.isArray(nodes?.backendNodeId) || !Array.isArray(nodes.nodeType)
    || nodes.nodeType.length !== nodes.backendNodeId.length
    || nodes.nodeValue !== undefined && (!Array.isArray(nodes.nodeValue) || nodes.nodeValue.length !== nodes.backendNodeId.length)
    || nodes.nodeValue === undefined && nodes.nodeType.some((type: unknown) => type === 3)
    || !Array.isArray(layout?.nodeIndex) || !Array.isArray(layout.styles) || layout.styles.length !== layout.nodeIndex.length
    || layout.text !== undefined && (!Array.isArray(layout.text) || layout.text.length !== layout.nodeIndex.length))
    throw new Error("Invalid DOM snapshot text layout");
  const result = new Map<number, string>(), seen = new Set<number>();
  for (let row = 0; row < layout.nodeIndex.length; row++) {
    const index = layout.nodeIndex[row];
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length) throw new Error("Invalid DOM snapshot layout index");
    if (nodes.nodeType[index] !== 3) continue;
    const backend = nodes.backendNodeId[index];
    if (!Number.isSafeInteger(backend) || backend <= 0) throw new Error("Invalid DOM snapshot text identity");
    // A node with multiple layout rows cannot be proven complete by one row.
    if (seen.has(backend)) { result.delete(backend); continue; }
    seen.add(backend);
    const styles = layout.styles[row];
    if (!Array.isArray(styles)) throw new Error("Invalid DOM snapshot style");
    const source = strings[nodes.nodeValue[index]], text = strings[layout.text?.[row]];
    const whiteSpace = strings[styles[32]], transform = strings[styles[25]], security = strings[styles[26]];
    if (typeof source !== "string" || typeof text !== "string" || source !== text || !source
      || !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace) || transform !== "none" || security !== "none") continue;
    result.set(backend, source);
  }
  return result;
}
