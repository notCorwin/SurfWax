import { sameTextPaintCandidates } from "./snapshot-text-paint";
import { snapshotVisibility, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

export type SnapshotConsistencyEvidence = Readonly<{
  /** Result derived from the exact left-hand capture. */
  visibility: ReadonlyMap<number, boolean>;
  textPaintCandidates: readonly SnapshotTextPaintCandidate[];
  /** The caller applied live paint projections to candidate visibility. */
  paintAdjusted?: boolean;
}>;

/** Compare two CDP captures by page semantics, not string-table positions or
 * harmless movement of already-visible boxes. False also means malformed or
 * unsupported evidence: callers must not claim a consistent snapshot. Equal
 * endpoints do not prove atomicity or rule out intermediate ABA changes. */
export function sameDOMSnapshot(left: any, right: any, before?: SnapshotConsistencyEvidence): boolean {
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
  const nodes = (a: any, b: any) => {
    if (!known(a, nodeKeys) || !known(b, nodeKeys)
      || !Array.isArray(a.backendNodeId) || !Array.isArray(b.backendNodeId)
      || !Array.isArray(a.parentIndex) || !Array.isArray(b.parentIndex)
      || !Array.isArray(a.nodeType) || !Array.isArray(b.nodeType)
      || !Array.isArray(a.nodeName) || !Array.isArray(b.nodeName)) return false;
    const length = a.backendNodeId.length;
    if ([a.parentIndex, a.nodeType, a.nodeName, b.backendNodeId, b.parentIndex, b.nodeType, b.nodeName].some((items) => items.length !== length)
      || [a.nodeValue, b.nodeValue, a.attributes, b.attributes].some((items) => items !== undefined && (!Array.isArray(items) || items.length !== length))
      || a.nodeType.some((type: unknown) => type === 3) && (!Array.isArray(a.nodeValue) || !Array.isArray(b.nodeValue))) return false;
    return compareFields(a, b, nodeNumbers, numericArray)
      && compareFields(a, b, nodeStrings, stringArray)
      && optional(a.attributes, b.attributes, (x, y) => array(x, y, attributes))
      && nodeRareStrings.every((key) => optional(a[key], b[key], (x, y) => sparse(x, y, "strings")))
      && nodeRareFlags.every((key) => optional(a[key], b[key], (x, y) => sparse(x, y, "none")))
      && optional(a.contentDocumentIndex, b.contentDocumentIndex, (x, y) => sparse(x, y, "numbers"));
  };
  // Text transform and security can change visible text independently of the
  // raw node value. Other styles and geometry are reflected in the visibility
  // map and candidate evidence computed by snapshotVisibility.
  const textStyles = (a: any, b: any) => array(a, b, (x, y) => Array.isArray(x) && Array.isArray(y)
    && x.every((index: unknown) => validString(leftStrings, index)) && y.every((index: unknown) => validString(rightStrings, index))
    && [25, 26].every((index) => optional(x[index], y[index], string)));
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
  const document = (a: any, b: any) => known(a, documentKeys) && known(b, documentKeys)
    && a.frameId !== -1 && b.frameId !== -1 && string(a.frameId, b.frameId) && Boolean(leftStrings[a.frameId]) && Boolean(rightStrings[b.frameId])
    && compareFields(a, b, documentStrings, string)
    && nodes(a.nodes, b.nodes) && layout(a.layout, b.layout) && optional(a.textBoxes, b.textBoxes, textBoxes);
  if (!array(left.documents, right.documents, document)) return false;
  try {
    const computed: SnapshotTextPaintCandidate[] = [], b: SnapshotTextPaintCandidate[] = [];
    const aVisibility = before?.visibility ?? snapshotVisibility(left, { textPaintCandidates: computed });
    const a = before?.textPaintCandidates ?? computed;
    const bVisibility = snapshotVisibility(right, { textPaintCandidates: b });
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
