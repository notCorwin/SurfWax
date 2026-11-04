import { sameTextPaintCandidates } from "./snapshot-text-paint";
import { snapshotVisibility, type SnapshotClip, type SnapshotTextPaintCandidate } from "./snapshot-visibility";

export type SnapshotConsistencyEvidence = Readonly<{
  /** Result derived from the exact left-hand capture. */
  visibility: ReadonlyMap<number, boolean>;
  textPaintCandidates: readonly SnapshotTextPaintCandidate[];
  /** The caller applied live paint projections to candidate visibility. */
  paintAdjusted?: boolean;
  frameClips?: ReadonlyMap<string, SnapshotClip>;
  hiddenFrames?: ReadonlySet<string>;
}>;

/** Identify changing text only when its effects on the rest of the page are
 * bounded. A geometrically changing text node is allowed solely inside a
 * stationary, clipped and non-overlapping container. */
export function changedTextNodes(left: any, right: any, before?: SnapshotConsistencyEvidence): Set<number> | undefined {
  try {
    if (!Array.isArray(left?.documents) || !Array.isArray(right?.documents) || left.documents.length !== right.documents.length
      || !Array.isArray(left.strings) || !Array.isArray(right.strings)) return undefined;
    const normalized = structuredClone(right), changed = new Set<number>();
    const uncertainLeft = new Set<number>(), uncertainRight = new Set<number>();
    const value = (strings: string[], index: unknown): string | undefined => index === -1 ? "" : Number.isSafeInteger(index) && Number(index) >= 0 ? strings[index as number] : undefined;
    let geometryChanged = false;
    for (let d = 0; d < left.documents.length; d++) {
      const a = left.documents[d], b = right.documents[d], copy = normalized.documents[d];
      if (!Array.isArray(a?.nodes?.nodeValue) || !Array.isArray(b?.nodes?.nodeValue)
        || a.nodes.nodeValue.length !== b.nodes.nodeValue.length || !Array.isArray(a.layout?.nodeIndex) || !Array.isArray(b.layout?.nodeIndex)) return undefined;
      const dynamicLayouts = new Set<number>(), parents = new Set<number>();
      for (let i = 0; i < a.nodes.nodeValue.length; i++) {
        const av = value(left.strings, a.nodes.nodeValue[i]), bv = value(right.strings, b.nodes.nodeValue[i]);
        if (av === undefined || bv === undefined) return undefined;
        if (av === bv && a.nodes.backendNodeId?.[i] === b.nodes.backendNodeId?.[i]) continue;
        const parent = a.nodes.parentIndex?.[i];
        if (a.nodes.nodeType?.[i] !== 3 || b.nodes.nodeType?.[i] !== 3 || !Number.isSafeInteger(parent) || parent < 0
          || parent !== b.nodes.parentIndex?.[i] || a.nodes.backendNodeId?.[parent] !== b.nodes.backendNodeId?.[parent]
          || !Number.isSafeInteger(a.nodes.backendNodeId?.[parent]) || !Number.isSafeInteger(a.nodes.backendNodeId[i])) return undefined;
        changed.add(a.nodes.backendNodeId[parent]); parents.add(parent);
        uncertainLeft.add(a.nodes.backendNodeId[i]); uncertainRight.add(b.nodes.backendNodeId[i]);
        copy.nodes.backendNodeId[i] = a.nodes.backendNodeId[i];
        copy.nodes.nodeValue[i] = normalized.strings.push(av) - 1;
        const ai = a.layout.nodeIndex.indexOf(i), bi = b.layout.nodeIndex.indexOf(i);
        if (ai !== bi) return undefined;
        if (ai >= 0) {
          dynamicLayouts.add(ai);
          if (!Array.isArray(a.layout.text) || !Array.isArray(b.layout.text)) return undefined;
          const layoutText = value(left.strings, a.layout.text[ai]);
          if (layoutText === undefined || value(right.strings, b.layout.text[bi]) === undefined) return undefined;
          copy.layout.text[bi] = normalized.strings.push(layoutText) - 1;
        }
      }
      for (const key of ["contentWidth", "contentHeight"]) if (a[key] !== b[key]) return undefined;
      const geometryKeys = ["bounds", "clientRects", "offsetRects", "scrollRects"];
      const changedGeometry = geometryKeys.some((key) => JSON.stringify(a.layout[key]) !== JSON.stringify(b.layout[key]))
        || JSON.stringify(a.textBoxes) !== JSON.stringify(b.textBoxes);
      if (!changedGeometry) continue;
      geometryChanged = true;
      if (!parents.size || left.documents.length !== 1 || before?.frameClips?.has(left.strings[a.frameId])) return undefined;
      // Reject missing geometry, effects, transforms, or external frame content:
      // they make the clipped container insufficient proof of paint isolation.
      const styleValue = (doc: any, strings: string[], li: number, index: number) => strings[doc.layout.styles?.[li]?.[index]];
      const safeStyle = (doc: any, strings: string[], li: number) => [6, 7, 8, 11, 12, 13, 14, 15, 22, 29, 30, 37, 38].every((index) => styleValue(doc, strings, li, index) === "none")
        && styleValue(doc, strings, li, 16) === "auto" && styleValue(doc, strings, li, 23) === "0px" && styleValue(doc, strings, li, 36) === "normal";
      const rect = (r: any): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) && r[2] >= 0 && r[3] >= 0;
      const inside = (r: number[], p: number[]) => r[0]! >= p[0]! && r[1]! >= p[1]! && r[0]! + r[2]! <= p[0]! + p[2]! && r[1]! + r[3]! <= p[1]! + p[3]!;
      const overlaps = (x: number[], y: number[]) => x[0]! < y[0]! + y[2]! && y[0]! < x[0]! + x[2]! && x[1]! < y[1]! + y[3]! && y[1]! < x[1]! + x[3]!;
      if (!Array.isArray(a.layout.bounds) || !Array.isArray(b.layout.bounds) || a.layout.bounds.length !== a.layout.nodeIndex.length || b.layout.bounds.length !== b.layout.nodeIndex.length) return undefined;
      // SVG paint and strokes can escape their layout bounds.
      if (a.nodes.nodeName.some((name: number) => left.strings[name]?.toLowerCase() === "svg")) return undefined;
      // Geometry bounds do not include shadows, outlines or transformed
      // effects. Require them absent for every other painted layout node.
      for (let li = 0; li < a.layout.nodeIndex.length; li++)
        if (a.nodes.nodeType[a.layout.nodeIndex[li]] !== 9 && (!safeStyle(a, left.strings, li) || !safeStyle(b, right.strings, li))) return undefined;
      for (const parent of parents) {
        const parentLayout = a.layout.nodeIndex.indexOf(parent);
        if (parentLayout < 0 || parentLayout !== b.layout.nodeIndex.indexOf(parent)) return undefined;
        const container = a.layout.bounds[parentLayout];
        if (!rect(container) || JSON.stringify(container) !== JSON.stringify(b.layout.bounds[parentLayout])) return undefined;
        if (!["hidden", "clip"].includes(styleValue(a, left.strings, parentLayout, 1)) || !["hidden", "clip"].includes(styleValue(a, left.strings, parentLayout, 2))
          || styleValue(a, left.strings, parentLayout, 1) !== styleValue(b, right.strings, parentLayout, 1)
          || styleValue(a, left.strings, parentLayout, 2) !== styleValue(b, right.strings, parentLayout, 2)) return undefined;
        const ancestors = new Set<number>();
        for (let n = parent; n >= 0; n = a.nodes.parentIndex[n]) {
          if (ancestors.has(n)) return undefined;
          ancestors.add(n);
          const li = a.layout.nodeIndex.indexOf(n);
          if (li >= 0 && a.nodes.nodeType[n] !== 9 && (!safeStyle(a, left.strings, li) || !safeStyle(b, right.strings, li))) return undefined;
        }
        for (let i = 0; i < a.nodes.parentIndex.length; i++) if (a.nodes.parentIndex[i] === parent && a.nodes.nodeType[i] !== 3) return undefined;
        for (let li = 0; li < a.layout.nodeIndex.length; li++) {
          const node = a.layout.nodeIndex[li];
          if (ancestors.has(node) || a.nodes.parentIndex[node] === parent && dynamicLayouts.has(li)) continue;
          const bounds = a.layout.bounds[li];
          if (!rect(bounds) || overlaps(container, bounds)) return undefined;
        }
        for (const li of dynamicLayouts) if (a.nodes.parentIndex[a.layout.nodeIndex[li]] === parent) {
          if (!rect(a.layout.bounds[li]) || !rect(b.layout.bounds[li]) || !inside(a.layout.bounds[li], container) || !inside(b.layout.bounds[li], container)) return undefined;
        }
      }
      for (const key of geometryKeys) {
        const x = a.layout[key], y = b.layout[key];
        if (x === undefined && y === undefined) continue;
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length !== a.layout.nodeIndex.length) return undefined;
        for (let i = 0; i < x.length; i++) if (!dynamicLayouts.has(i) && JSON.stringify(x[i]) !== JSON.stringify(y[i])) return undefined;
        copy.layout[key] = structuredClone(x);
      }
      const stableBoxes = (boxes: any) => {
        if (!boxes || !Array.isArray(boxes.layoutIndex) || !Array.isArray(boxes.start) || !Array.isArray(boxes.length) || !Array.isArray(boxes.bounds)
          || [boxes.start, boxes.length, boxes.bounds].some((x) => x.length !== boxes.layoutIndex.length)) return undefined;
        return boxes.layoutIndex.flatMap((index: number, i: number) => dynamicLayouts.has(index) ? [] : [[index, boxes.start[i], boxes.length[i], boxes.bounds[i]]]);
      };
      const boxA = stableBoxes(a.textBoxes), boxB = stableBoxes(b.textBoxes);
      if (!boxA || !boxB || JSON.stringify(boxA) !== JSON.stringify(boxB)) return undefined;
      copy.textBoxes = structuredClone(a.textBoxes);
    }
    if (!changed.size || !sameDOMSnapshot(left, normalized, before)) return undefined;
    if (geometryChanged) {
      const candidates: SnapshotTextPaintCandidate[] = [];
      const actualVisibility = snapshotVisibility(right, { textPaintCandidates: candidates, frameClips: before?.frameClips, hiddenFrames: before?.hiddenFrames });
      const originalCandidates: SnapshotTextPaintCandidate[] = [];
      const originalVisibility = before?.visibility ?? snapshotVisibility(left, { textPaintCandidates: originalCandidates });
      const sourceCandidates = before?.textPaintCandidates ?? originalCandidates;
      const projected = before?.paintAdjusted ? new Set(sourceCandidates.map(({ backendNodeId }) => backendNodeId)) : undefined;
      for (const [id, visible] of originalVisibility) {
        if (uncertainLeft.has(id)) continue;
        const next = actualVisibility.get(id);
        if (next !== visible && !(projected?.has(id) && visible === false && next === true)) return undefined;
      }
      for (const id of actualVisibility.keys()) if (!uncertainRight.has(id) && !originalVisibility.has(id)) return undefined;
      if (!sameTextPaintCandidates(sourceCandidates.filter(({ backendNodeId }) => !uncertainLeft.has(backendNodeId)),
        candidates.filter(({ backendNodeId }) => !uncertainRight.has(backendNodeId)))) return undefined;
    }
    return changed;
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
    const bVisibility = snapshotVisibility(right, { textPaintCandidates: b, frameClips: before?.frameClips, hiddenFrames: before?.hiddenFrames });
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
