export type PreformattedText = Readonly<{ source: string; text: string }>;
export type PaintedWhitespace = Readonly<{ source: string; text: string; preformatted: boolean }>;

/** Collapse only CSS collapsible whitespace. NBSP and other spaces are text. */
export function normalizeSnapshotText(text: string): string {
  return text.replace(/[\t\n\f\r ]+/g, " ").replace(/^ +| +$/g, "");
}

/** Accept an offset map only when independent character transforms reproduce
 * Chrome's complete layout string. Contextual/locale-specific differences fail
 * closed instead of treating source offsets as transformed-string offsets. */
function transformedOffsets(original: string, text: string, transform: string): Map<number, number> | undefined {
  const fold = transform === "uppercase" ? (value: string) => value.toUpperCase()
    : transform === "lowercase" ? (value: string) => value.toLowerCase() : undefined;
  if (!fold) return undefined;
  const result = new Map<number, number>([[0, 0]]), parts: string[] = [];
  let sourceOffset = 0, layoutOffset = 0;
  for (const char of original) {
    const mapped = fold(char);
    parts.push(mapped); sourceOffset += char.length; layoutOffset += mapped.length;
    result.set(sourceOffset, layoutOffset);
  }
  return parts.join("") === text ? result : undefined;
}

/**
 * Identify text whose whitespace is determined by its captured CSS style.
 * This does not establish visibility: callers must still apply the same
 * visibility and text-paint projection rules as every other text node.
 * A projected or clipped string is not interchangeable with this evidence.
 * The caller must visit each layout row in order and pass whether its node
 * index was already present in the caller's layout index. DOMSnapshot backend
 * IDs must have been validated as unique before collecting.
 */
export function createPreformattedTextCollector(strings: string[], nodes: any, layout: any, textBoxes?: any): {
  readonly result: Map<number, PreformattedText>;
  /** Text whose boundary whitespace is established by DOMSnapshot text boxes. */
  readonly painted: Map<number, PaintedWhitespace>;
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
  const painted = new Map<number, PaintedWhitespace>();
  const pseudoTextRows = new Set<number>();
  const boxesByRow = new Map<number, Array<{ start: number; length: number; bounds: unknown }>>();
  if (Array.isArray(textBoxes?.layoutIndex)) {
    textBoxes.layoutIndex.forEach((row: number, index: number) => {
      const boxes = boxesByRow.get(row) ?? [];
      boxes.push({ start: textBoxes.start?.[index], length: textBoxes.length?.[index], bounds: textBoxes.bounds?.[index] });
      boxesByRow.set(row, boxes);
    });
  }
  let nextRow = 0;
  const observe = (row: number, repeated: boolean): void => {
    if (!Number.isSafeInteger(row) || row !== nextRow || row >= layout.nodeIndex.length || typeof repeated !== "boolean")
      throw new Error("Invalid DOM snapshot layout row");
    nextRow++;
    const index = layout.nodeIndex[row];
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length) throw new Error("Invalid DOM snapshot layout index");
    const pseudo = nodes.nodeType[index] === 1 && /^::(?:before|after|marker|first-letter)$/i.test(strings[nodes.nodeName?.[index]] ?? "");
    if (nodes.nodeType[index] !== 3 && !pseudo) return;
    const backend = nodes.backendNodeId[index];
    if (!Number.isSafeInteger(backend) || backend <= 0) throw new Error("Invalid DOM snapshot text identity");
    const text = strings[layout.text?.[row]];
    // Pseudo elements can have an empty geometry row before the text-bearing
    // row. Two text-bearing rows remain ambiguous, just as for a text node.
    if (pseudo && !text) return;
    if (pseudo ? pseudoTextRows.has(backend) : repeated) { result.delete(backend); painted.delete(backend); return; }
    if (pseudo) pseudoTextRows.add(backend);
    const styles = layout.styles[row];
    if (!Array.isArray(styles)) throw new Error("Invalid DOM snapshot style");
    const original = pseudo ? text : strings[nodes.nodeValue[index]];
    const whiteSpace = strings[styles[32]], transform = strings[styles[25]], security = strings[styles[26]];
    if (typeof original !== "string" || typeof text !== "string" || !text || typeof transform !== "string"
      || security !== "none" || transform === "none" && original !== text) return;
    // Preserve Chrome's transformed layout string, not the raw DOM spelling.
    const source = text, transformed = transform !== "none";
    // Preserving modes emit the captured layout text directly. The caller
    // still checks visibility and excludes clipped/projected strings. This
    // does not interpret transformed text-box offsets as character offsets.
    if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
      result.set(backend, { source, text: source });
      return;
    }
    // A transformed pseudo has no captured untransformed DOM spelling with
    // which to establish the source offset map.
    if (pseudo && transformed) return;
    // CDP starts can index the DOM source while lengths count transformed
    // glyphs. Use a verified source-to-layout map, then require complete text
    // coverage below; unsupported length conventions cannot omit a glyph.
    const offsets = transformed ? transformedOffsets(original, text, transform) : undefined;
    // DOMSnapshot layout.text is often the untouched DOM source. Text boxes
    // identify the portions participating in layout, including a painted
    // boundary space and zero-width preserved line breaks. Never infer this
    // from trim(), or from a node's parent label.
    const capturedBoxes = boxesByRow.get(row);
    const boxes = transformed ? offsets && capturedBoxes?.map((box) => ({ ...box, start: offsets.get(box.start) ?? -1 })) : capturedBoxes;
    if (["normal", "nowrap", "pre-line"].includes(whiteSpace) && boxes?.length && !/[\r\f]/.test(source)) {
      const ordered = [...boxes].sort((a, b) => a.start - b.start);
      let end = 0, valid = true;
      for (const box of ordered) {
        const bounds = box.bounds;
        if (!Number.isSafeInteger(box.start) || !Number.isSafeInteger(box.length) || box.start < end
          || box.length <= 0 || box.start + box.length > source.length || !Array.isArray(bounds)
          || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] < 0 || bounds[3] < 0
          || !/^[\t\n ]*$/.test(source.slice(end, box.start))
          || (bounds[2] === 0 || bounds[3] === 0) && (whiteSpace !== "pre-line" || !/^\n+$/.test(source.slice(box.start, box.start + box.length)))) {
          valid = false; break;
        }
        // A preserved newline missing between boxes cannot be reconstructed.
        if (whiteSpace === "pre-line" && source.slice(end, box.start).includes("\n")) { valid = false; break; }
        end = box.start + box.length;
      }
      if (valid && /^[\t\n ]*$/.test(source.slice(end))
        && (whiteSpace !== "pre-line" || !source.slice(end).includes("\n"))) {
        const first = ordered[0]!.start;
        const slice = source.slice(first, end);
        const collapsed = whiteSpace === "pre-line"
          ? slice.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n")
          : slice.replace(/[\t\n ]+/g, " ");
        painted.set(backend, { source, text: collapsed, preformatted: whiteSpace === "pre-line" && collapsed.includes("\n") });
      }
    }
    // In pre-line, ASCII horizontal whitespace collapses and spaces beside a
    // preserved line break disappear. Adjacent inline nodes can determine
    // whether boundary whitespace paints, so accept only self-contained text
    // with non-whitespace ends. CR/FF normalization has additional rules and
    // stays on the ordinary conservative path.
    // Case conversion can depend on language or word context. Newline
    // semantics do not: use Chrome's captured spelling when transformation
    // preserved every whitespace run. This also rejects transforms such as
    // full-width when they replace an ASCII space with another character.
    const whitespaceRuns = (value: string) => JSON.stringify(value.match(/[ \t\n]+/g));
    if (transformed && whitespaceRuns(original) !== whitespaceRuns(source) || whiteSpace !== "pre-line" || !source.includes("\n") || /[\r\f]/.test(source + original)
      || /^[ \t\n]|[ \t\n]$/.test(source) || /^[ \t\n]|[ \t\n]$/.test(original)) return;
    const collapsed = source.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n");
    result.set(backend, { source, text: collapsed });
  };
  return { result, painted, observe };
}
