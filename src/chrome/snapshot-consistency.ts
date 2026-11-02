import { sameTextPaintCandidates } from "./snapshot-text-paint";
import { snapshotVisibility, type SnapshotClip, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

export type SnapshotConsistencyEvidence = Readonly<{
  /** Result derived from the exact left-hand capture. */
  visibility: ReadonlyMap<number, boolean>;
  textPaintCandidates: readonly SnapshotTextPaintCandidate[];
  /** The caller applied live paint projections to candidate visibility. */
  paintAdjusted?: boolean;
  frameClips?: ReadonlyMap<string, SnapshotClip>;
}>;

/** Identify parents of changing Text nodes only when the captures otherwise agree,
 * including exact layout geometry. The returned nodes must be rendered as
 * unknown; their values must never be presented as a consistent observation. */
export function changedTextNodes(left: any, right: any, before?: SnapshotConsistencyEvidence): Set<number> | undefined {
  try {
    if (!Array.isArray(left?.documents) || !Array.isArray(right?.documents) || left.documents.length !== right.documents.length
      || !Array.isArray(left.strings) || !Array.isArray(right.strings)) return undefined;
    const normalized = structuredClone(right), changed = new Set<number>();
    const value = (strings: string[], index: unknown): string | undefined => index === -1 ? "" : Number.isSafeInteger(index) && Number(index) >= 0 ? strings[index as number] : undefined;
    for (let d = 0; d < left.documents.length; d++) {
      const a = left.documents[d], b = right.documents[d], copy = normalized.documents[d];
      if (!Array.isArray(a?.nodes?.nodeValue) || !Array.isArray(b?.nodes?.nodeValue)
        || a.nodes.nodeValue.length !== b.nodes.nodeValue.length || !Array.isArray(a.layout?.nodeIndex) || !Array.isArray(b.layout?.nodeIndex)) return undefined;
      // Changes in layout, including text box sizes and positions, may affect
      // unrelated content and cannot be attributed safely to text alone.
      for (const key of ["contentWidth", "contentHeight"]) if (a[key] !== b[key]) return undefined;
      for (const key of ["bounds", "clientRects", "offsetRects", "scrollRects"]) if (JSON.stringify(a.layout[key]) !== JSON.stringify(b.layout[key])) return undefined;
      if (JSON.stringify(a.textBoxes) !== JSON.stringify(b.textBoxes)) return undefined;
      for (let i = 0; i < a.nodes.nodeValue.length; i++) {
        const av = value(left.strings, a.nodes.nodeValue[i]), bv = value(right.strings, b.nodes.nodeValue[i]);
        if (av === undefined || bv === undefined) return undefined;
        if (av === bv && a.nodes.backendNodeId?.[i] === b.nodes.backendNodeId?.[i]) continue;
        const parent = a.nodes.parentIndex?.[i];
        if (a.nodes.nodeType?.[i] !== 3 || b.nodes.nodeType?.[i] !== 3 || !Number.isSafeInteger(parent) || parent < 0
          || parent !== b.nodes.parentIndex?.[i] || a.nodes.backendNodeId?.[parent] !== b.nodes.backendNodeId?.[parent]
          || !Number.isSafeInteger(a.nodes.backendNodeId?.[parent]) || !Number.isSafeInteger(a.nodes.backendNodeId[i])) return undefined;
        changed.add(a.nodes.backendNodeId[parent]);
        copy.nodes.backendNodeId[i] = a.nodes.backendNodeId[i];
        copy.nodes.nodeValue[i] = normalized.strings.push(av) - 1;
        const ai = a.layout.nodeIndex.indexOf(i), bi = b.layout.nodeIndex.indexOf(i);
        if (ai !== bi) return undefined;
        if (ai >= 0) {
          if (!Array.isArray(a.layout.text) || !Array.isArray(b.layout.text)) return undefined;
          const layoutText = value(left.strings, a.layout.text[ai]);
          if (layoutText === undefined || value(right.strings, b.layout.text[bi]) === undefined) return undefined;
          copy.layout.text[bi] = normalized.strings.push(layoutText) - 1;
        }
      }
    }
    return changed.size && sameDOMSnapshot(left, normalized, before) ? changed : undefined;
  } catch { return undefined; }
}

/** Compare two CDP captures by page semantics, not string-table positions or
 * harmless movement of already-visible boxes. False also means malformed or
 * unsupported evidence: callers must not claim a consistent snapshot. Equal
 * endpoints do not prove atomicity or rule out intermediate ABA changes. */
export function sameDOMSnapshot(left: any, right: any, before?: SnapshotConsistencyEvidence, options?: { ignoreUnrenderedText?: boolean }): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
    || Object.keys(left).some((key) => key !== "strings" && key !== "documents") || Object.keys(right).some((key) => key !== "strings" && key !== "documents")
    || !Array.isArray(left.strings) || !Array.isArray(right.strings)
    || !Array.isArray(left.documents) || !Array.isArray(right.documents)
    || left.strings.some((item: unknown) => typeof item !== "string") || right.strings.some((item: unknown) => typeof item !== "string")) return false;
  const leftStrings: string[] = left.strings, rightStrings: string[] = right.strings;
  const validString = (table: string[], index: unknown) => Number.isSafeInteger(index) && (index === -1 || Number(index) >= 0 && Number(index) < table.length);
  const string = (a: unknown, b: unknown) => validString(leftStrings, a) && validString(rightStrings, b)
    && (a === -1 || b === -1 ? a === b : leftStrings[a as number] === rightStrings[b as number]);
  // CDP uses -1 for an empty attribute value (for example `disabled`).
  const attributeValue = (a: unknown, b: unknown) => validString(leftStrings, a) && validString(rightStrings, b)
    && (a === -1 ? "" : leftStrings[a as number]) === (b === -1 ? "" : rightStrings[b as number]);
  const scalar = (a: unknown, b: unknown) => typeof a === "number" && Number.isFinite(a) && Object.is(a, b);
  const optional = (a: any, b: any, compare: (a: any, b: any) => boolean) => a === undefined || b === undefined ? a === b : compare(a, b);
  const array = (a: any, b: any, compare: (a: any, b: any) => boolean) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value: any, index: number) => compare(value, b[index]));
  const known = (value: any, keys: ReadonlySet<string>) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.has(key));
  const compareFields = (a: any, b: any, keys: readonly string[], compare: (a: any, b: any) => boolean) =>
    keys.every((key) => optional(a[key], b[key], compare));
  const numericArray = (a: any, b: any) => array(a, b, scalar);
  const stringArray = (a: any, b: any) => array(a, b, string);
  const sparse = (a: any, b: any, values: "strings" | "numbers" | "none") => {
    const keys = values === "none" ? sparseBooleanKeys : sparseValueKeys;
    if (!known(a, keys) || !known(b, keys) || !numericArray(a.index, b.index)) return false;
    if (values === "none") return true;
    return values === "strings" ? stringArray(a.value, b.value) : numericArray(a.value, b.value);
  };
  // Inline styles may animate position every frame. Visibility and text paint
  // are compared below; all other attributes remain part of the identity.
  const attributes = (a: any, b: any) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length % 2 || b.length % 2) return false;
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      while (i < a.length && validString(leftStrings, a[i]) && leftStrings[a[i]]?.toLowerCase() === "style") {
        if (!validString(leftStrings, a[i + 1])) return false;
        i += 2;
      }
      while (j < b.length && validString(rightStrings, b[j]) && rightStrings[b[j]]?.toLowerCase() === "style") {
        if (!validString(rightStrings, b[j + 1])) return false;
        j += 2;
      }
      if (i === a.length || j === b.length) return i === a.length && j === b.length;
      if (a[i] === -1 || b[j] === -1 || !string(a[i], b[j]) || !attributeValue(a[i + 1], b[j + 1])) return false;
      i += 2; j += 2;
    }
    return true;
  };
  const nodes = (a: any, b: any, leftLayout: any, rightLayout: any) => {
    if (!known(a, nodeKeys) || !known(b, nodeKeys)
      || !Array.isArray(a.backendNodeId) || !Array.isArray(b.backendNodeId)
      || !Array.isArray(a.parentIndex) || !Array.isArray(b.parentIndex)
      || !Array.isArray(a.nodeType) || !Array.isArray(b.nodeType)
      || !Array.isArray(a.nodeName) || !Array.isArray(b.nodeName)) return false;
    const length = a.backendNodeId.length;
    if ([a.parentIndex, a.nodeType, a.nodeName, b.backendNodeId, b.parentIndex, b.nodeType, b.nodeName].some((items) => items.length !== length)
      || [a.nodeValue, b.nodeValue, a.attributes, b.attributes].some((items) => items !== undefined && (!Array.isArray(items) || items.length !== length))
      || a.nodeType.some((type: unknown) => type === 3) && (!Array.isArray(a.nodeValue) || !Array.isArray(b.nodeValue))) return false;
    // This exception is only safe when the caller has independently
    // confirmed the accessibility tree: hidden text can label controls.
    const leftRendered = options?.ignoreUnrenderedText && Array.isArray(leftLayout?.nodeIndex) ? new Set<number>(leftLayout.nodeIndex) : undefined;
    const rightRendered = options?.ignoreUnrenderedText && Array.isArray(rightLayout?.nodeIndex) ? new Set<number>(rightLayout.nodeIndex) : undefined;
    const compareNodeValues = (x: any, y: any) => Array.isArray(x) && Array.isArray(y) && x.length === y.length
      && x.every((value: unknown, index: number) => string(value, y[index]) || Boolean(options?.ignoreUnrenderedText
        && a.nodeType[index] === 3 && b.nodeType[index] === 3
        && leftRendered && rightRendered && !leftRendered.has(index) && !rightRendered.has(index)
        && validString(leftStrings, value) && validString(rightStrings, y[index])));
    return compareFields(a, b, nodeNumbers, numericArray)
      && optional(a.nodeName, b.nodeName, stringArray) && optional(a.nodeValue, b.nodeValue, compareNodeValues)
      && optional(a.attributes, b.attributes, (x, y) => array(x, y, attributes))
      && nodeRareStrings.every((key) => optional(a[key], b[key], (x, y) => sparse(x, y, "strings")))
      && nodeRareFlags.every((key) => optional(a[key], b[key], (x, y) => sparse(x, y, "none")))
      && optional(a.contentDocumentIndex, b.contentDocumentIndex, (x, y) => sparse(x, y, "numbers"));
  };
  // Text transform, security and whitespace can change visible text independently of the
  // raw node value. Other styles and geometry are reflected in the visibility
  // map and candidate evidence computed by snapshotVisibility.
  const textStyles = (a: any, b: any) => array(a, b, (x, y) => Array.isArray(x) && Array.isArray(y)
    && x.every((index: unknown) => validString(leftStrings, index)) && y.every((index: unknown) => validString(rightStrings, index))
    && [25, 26, 32, 33].every((index) => optional(x[index], y[index], string)));
  const layout = (a: any, b: any) => {
    if (!known(a, layoutKeys) || !known(b, layoutKeys) || !Array.isArray(a.nodeIndex) || !Array.isArray(b.nodeIndex)
      || !Array.isArray(a.styles) || !Array.isArray(b.styles) || !Array.isArray(a.bounds) || !Array.isArray(b.bounds)
      || a.nodeIndex.length !== a.styles.length || b.nodeIndex.length !== b.styles.length
      || a.nodeIndex.length !== a.bounds.length || b.nodeIndex.length !== b.bounds.length
      || [a.text, b.text].some((value, index) => value !== undefined && (!Array.isArray(value) || value.length !== (index ? b.nodeIndex : a.nodeIndex).length))
      || [a.bounds, b.bounds].some((rects) => rects.some((rect: unknown) => !Array.isArray(rect) || rect.length !== 4 || rect.some((value) => typeof value !== "number" || !Number.isFinite(value))))) return false;
    return numericArray(a.nodeIndex, b.nodeIndex) && textStyles(a.styles, b.styles)
      && optional(a.text, b.text, stringArray)
      && optional(a.stackingContexts, b.stackingContexts, (x, y) => sparse(x, y, "none"))
      && compareFields(a, b, ["paintOrders", "textColorOpacities"], numericArray)
      && optional(a.blendedBackgroundColors, b.blendedBackgroundColors, stringArray);
  };
  const textBoxes = (a: any, b: any) => known(a, textBoxKeys) && known(b, textBoxKeys)
    && compareFields(a, b, ["layoutIndex", "start", "length"], numericArray);
  const frameGeometry = (a: any, b: any) => {
    const indices = new Set<number>();
    for (let index = 0; index < a.nodes.nodeName.length; index++) {
      const tag = leftStrings[a.nodes.nodeName[index]]?.toUpperCase();
      if (tag !== "IFRAME" && tag !== "FRAME") continue;
      for (let parent = index; parent >= 0 && !indices.has(parent); parent = a.nodes.parentIndex[parent]) indices.add(parent);
    }
    for (const index of indices) {
      const leftIndex = a.layout.nodeIndex.indexOf(index), rightIndex = b.layout.nodeIndex.indexOf(index);
      if (leftIndex !== rightIndex) return false;
      if (leftIndex < 0) continue;
      for (const field of ["bounds", "clientRects", "offsetRects", "scrollRects"]) {
        if (!optional(a.layout[field]?.[leftIndex], b.layout[field]?.[rightIndex], numericArray)) return false;
      }
      const leftStyle = a.layout.styles[leftIndex], rightStyle = b.layout.styles[rightIndex];
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].every((key) => optional(leftStyle?.[key], rightStyle?.[key], string))) return false;
    }
    return true;
  };
  const document = (a: any, b: any) => known(a, documentKeys) && known(b, documentKeys)
    && a.frameId !== -1 && b.frameId !== -1 && string(a.frameId, b.frameId) && Boolean(leftStrings[a.frameId]) && Boolean(rightStrings[b.frameId])
    && compareFields(a, b, ["scrollOffsetX", "scrollOffsetY"], scalar)
    && compareFields(a, b, documentStrings, string)
    && nodes(a.nodes, b.nodes, a.layout, b.layout) && layout(a.layout, b.layout) && frameGeometry(a, b) && optional(a.textBoxes, b.textBoxes, textBoxes);
  if (!array(left.documents, right.documents, document)) return false;
  try {
    const computed: SnapshotTextPaintCandidate[] = [], b: SnapshotTextPaintCandidate[] = [];
    const aVisibility = before?.visibility ?? snapshotVisibility(left, { textPaintCandidates: computed });
    const a = before?.textPaintCandidates ?? computed;
    const bVisibility = snapshotVisibility(right, { textPaintCandidates: b, frameClips: before?.frameClips });
    if (!sameTextPaintCandidates(a, b) || aVisibility.size !== bVisibility.size) return false;
    // The producer may have changed only candidate visibility after live paint
    // analysis. A candidate existed only when it was initially visible.
    const projected = before?.paintAdjusted ? new Set(a.map(({ backendNodeId }) => backendNodeId)) : undefined;
    for (const [id, visible] of aVisibility) {
      const next = bVisibility.get(id);
      if (next !== visible && !(projected?.has(id) && visible === false && next === true)) return false;
    }
    // When live glyph/selection analysis is necessary, box geometry is part of
    // the evidence; ordinary visible text can move without invalidation.
    return a.every((candidate, index) => optional(candidate.textBoxes, b[index]!.textBoxes, (x, y) => array(x, y, (box, other) =>
      box.start === other.start && box.length === other.length && numericArray(box.bounds, other.bounds))));
  } catch {
    return false;
  }
}

const documentStrings = ["documentURL", "title", "baseURL", "contentLanguage", "encodingName", "publicId", "systemId"] as const;
const documentKeys = new Set([...documentStrings, "frameId", "nodes", "layout", "textBoxes", "scrollOffsetX", "scrollOffsetY", "contentWidth", "contentHeight"]);
const nodeNumbers = ["parentIndex", "nodeType", "backendNodeId"] as const;
const nodeStrings = ["nodeName", "nodeValue"] as const;
const nodeRareStrings = ["shadowRootType", "textValue", "inputValue", "pseudoType", "pseudoIdentifier", "currentSourceURL", "originURL"] as const;
const nodeRareFlags = ["inputChecked", "optionSelected", "isClickable"] as const;
const nodeKeys = new Set([...nodeNumbers, ...nodeStrings, ...nodeRareStrings, ...nodeRareFlags, "attributes", "contentDocumentIndex"]);
const layoutKeys = new Set(["nodeIndex", "styles", "bounds", "text", "stackingContexts", "paintOrders", "offsetRects", "scrollRects", "clientRects", "blendedBackgroundColors", "textColorOpacities"]);
const textBoxKeys = new Set(["layoutIndex", "start", "length", "bounds"]);
const sparseBooleanKeys = new Set(["index"]);
const sparseValueKeys = new Set(["index", "value"]);
