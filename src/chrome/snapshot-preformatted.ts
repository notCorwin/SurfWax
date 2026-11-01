export type PreformattedText = Readonly<{ source: string; text: string }>;

/**
 * Identify text whose whitespace is determined by its captured CSS style.
 * This does not establish visibility: callers must still apply the same
 * visibility and text-paint projection rules as every other text node.
 * A projected or clipped string is not interchangeable with this evidence.
 * The caller must visit each layout row in order and pass whether its node
 * index was already present in the caller's layout index. DOMSnapshot backend
 * IDs must have been validated as unique before collecting.
 */
export function createPreformattedTextCollector(strings: string[], nodes: any, layout: any): {
  readonly result: Map<number, PreformattedText>;
  observe(row: number, repeated: boolean): void;
} {
  if (!Array.isArray(strings)) throw new Error("Invalid DOM snapshot");
  if (!Array.isArray(nodes?.backendNodeId) || !Array.isArray(nodes.nodeType)
    || nodes.nodeType.length !== nodes.backendNodeId.length
    || nodes.nodeValue !== undefined && (!Array.isArray(nodes.nodeValue) || nodes.nodeValue.length !== nodes.backendNodeId.length)
    || nodes.nodeValue === undefined && nodes.nodeType.some((type: unknown) => type === 3)
    || !Array.isArray(layout?.nodeIndex) || !Array.isArray(layout.styles) || layout.styles.length !== layout.nodeIndex.length
    || layout.text !== undefined && (!Array.isArray(layout.text) || layout.text.length !== layout.nodeIndex.length))
    throw new Error("Invalid DOM snapshot text layout");
  const result = new Map<number, PreformattedText>();
  let nextRow = 0;
  const observe = (row: number, repeated: boolean): void => {
    if (!Number.isSafeInteger(row) || row !== nextRow || row >= layout.nodeIndex.length || typeof repeated !== "boolean")
      throw new Error("Invalid DOM snapshot layout row");
    nextRow++;
    const index = layout.nodeIndex[row];
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length) throw new Error("Invalid DOM snapshot layout index");
    if (nodes.nodeType[index] !== 3) return;
    const backend = nodes.backendNodeId[index];
    if (!Number.isSafeInteger(backend) || backend <= 0) throw new Error("Invalid DOM snapshot text identity");
    // A node with multiple layout rows cannot be proven complete by one row.
    if (repeated) { result.delete(backend); return; }
    const styles = layout.styles[row];
    if (!Array.isArray(styles)) throw new Error("Invalid DOM snapshot style");
    const source = strings[nodes.nodeValue[index]], text = strings[layout.text?.[row]];
    const whiteSpace = strings[styles[32]], transform = strings[styles[25]], security = strings[styles[26]];
    if (typeof source !== "string" || typeof text !== "string" || source !== text || !source
      || transform !== "none" || security !== "none") return;
    if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
      result.set(backend, { source, text: source });
      return;
    }
    // In pre-line, ASCII horizontal whitespace collapses and spaces beside a
    // preserved line break disappear. Adjacent inline nodes can determine
    // whether boundary whitespace paints, so accept only self-contained text
    // with non-whitespace ends. CR/FF normalization has additional rules and
    // stays on the ordinary conservative path.
    if (whiteSpace !== "pre-line" || !source.includes("\n") || /[\r\f]/.test(source)
      || /^[ \t\n]|[ \t\n]$/.test(source)) return;
    const collapsed = source.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n");
    result.set(backend, { source, text: collapsed });
  };
  return { result, observe };
}
