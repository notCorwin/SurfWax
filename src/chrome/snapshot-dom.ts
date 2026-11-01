import { createSnapshotDomIndex, type SnapshotDomIndex } from "./snapshot-dom-index";
import { createPreformattedTextCollector, type PreformattedText } from "./snapshot-preformatted";

/** Visible DOM evidence from a single CDP DOMSnapshot capture. IDs are scoped
 * to the frame and debugger target that produced the capture. */
export type SnapshotDomEvidence = Readonly<{
  frameId: string;
  backendNodeId: number;
  parentBackendNodeId?: number;
  /** Node index within this frame’s indexed DOMSnapshot document. */
  nodeIndex: number;
  kind: "text" | "control";
  text?: string;
  tag?: string;
  attributes?: Readonly<Record<string, string>>;
  /** Raw value is private capture evidence for identity checks, not output. */
  value?: string;
  valueVisible?: boolean;
  masked?: boolean;
  clickable?: boolean;
  checked?: boolean;
  selectedOptions?: readonly Readonly<{ label: string; value: string }>[];
}>;

// These explicit roles carry control semantics even when their author has
// omitted a tab stop or uses tabindex=-1. Visibility is proven separately;
// this only requests DOM evidence and does not establish action capability.
const DOM_INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

export type SnapshotDomOptions = Readonly<{
  visibility: ReadonlyMap<number, boolean>;
  textProjections?: ReadonlyMap<number, Readonly<{ full: string; text: string }>>;
  /** AX nodes that actually emitted equivalent content, not merely all AX nodes. */
  covered: ReadonlySet<number>;
  /** Limit evidence to a particular frame in this debugger target. */
  frameId?: string;
}>;

/**
 * Extract additional visible DOM evidence without guessing accessible names or
 * action refs. The caller must merge by frame/backend identity and bind any
 * actionable ref through the existing DOM identity validation. An AX element
 * alone does not imply its descendant text is covered: only pass identities
 * whose equivalent information was actually emitted.
 */
export function snapshotDomSupplement(snapshot: any, options: SnapshotDomOptions): { items: SnapshotDomEvidence[]; indexes: Map<string, SnapshotDomIndex>; preformatted: Map<string, Map<number, PreformattedText>> } {
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) throw new Error("Invalid DOM snapshot");
  const strings: string[] = snapshot.strings;
  const stringAt = (index: unknown): string | undefined => Number.isSafeInteger(index) && Number(index) >= 0 ? strings[Number(index)] : undefined;
  const result: SnapshotDomEvidence[] = [];
  const indexes = new Map<string, SnapshotDomIndex>();
  const preformatted = new Map<string, Map<number, PreformattedText>>();
  for (const document of snapshot.documents) {
    const frameId = stringAt(document.frameId);
    if (!frameId) throw new Error("DOM snapshot missing frame identity");
    if (options.frameId !== undefined && frameId !== options.frameId) continue;
    const nodes = document.nodes, layout = document.layout;
    if (!Array.isArray(nodes?.backendNodeId) || !Array.isArray(nodes?.parentIndex) || !Array.isArray(nodes?.nodeType)
      || !Array.isArray(nodes?.nodeName) || !Array.isArray(layout?.nodeIndex)) throw new Error("Invalid DOM snapshot document");
    if (indexes.has(frameId)) throw new Error("Duplicate DOM snapshot frame");
    const domIndex = createSnapshotDomIndex(nodes);
    indexes.set(frameId, domIndex);
    const layouts = new Map<number, number[]>();
    const collector = createPreformattedTextCollector(strings, nodes, layout);
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const index = layout.nodeIndex[i];
      if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length) throw new Error("Invalid DOM snapshot layout index");
      const existing = layouts.get(index);
      collector.observe(i, existing !== undefined);
      const rows = existing ?? []; rows.push(i); layouts.set(index, rows);
    }
    preformatted.set(frameId, collector.result);
    // Propagate painted descendants upward once, without walking a deep
    // ancestor chain separately for every layout node.
    const hasVisibleLayoutDescendant = new Uint8Array(nodes.backendNodeId.length);
    for (let i = domIndex.preorder.length - 1; i >= 0; i--) {
      const index = domIndex.preorder[i]!, parent = domIndex.parentAt(index);
      if (parent !== undefined && (hasVisibleLayoutDescendant[index] || layouts.has(index) && options.visibility.get(nodes.backendNodeId[index]) === true))
        hasVisibleLayoutDescendant[parent] = 1;
    }
    // Chrome emits ::first-letter as a separate pseudo node whose layout text
    // is omitted from the original text node's layout.text.
    const firstLetters = new Map<number, Array<{ text: string; id: number }>>();
    for (const [index, rows] of layouts) {
      if (stringAt(nodes.nodeName[index])?.toLowerCase() !== "::first-letter") continue;
      const id = nodes.backendNodeId[index];
      if (options.visibility.get(id) !== true) continue;
      const text = rows.map((row) => stringAt(layout.text?.[row]) ?? "").join("");
      if (!text) continue;
      const parent = domIndex.parentAt(index);
      if (parent === undefined || domIndex.backendAt(parent) === undefined) continue;
      const items = firstLetters.get(parent) ?? []; items.push({ text, id }); firstLetters.set(parent, items);
    }
    const rareString = (value: any): Map<number, string> => {
      const result = new Map<number, string>();
      if (value === undefined) return result;
      if (!Array.isArray(value?.index) || !Array.isArray(value?.value) || value.index.length !== value.value.length) throw new Error("Invalid DOM snapshot sparse values");
      value.index.forEach((index: number, offset: number) => { const text = stringAt(value.value[offset]); if (text !== undefined) result.set(index, text); });
      return result;
    };
    const rareBoolean = (value: any): Set<number> => {
      if (value === undefined) return new Set();
      if (!Array.isArray(value?.index)) throw new Error("Invalid DOM snapshot sparse flags");
      return new Set(value.index);
    };
    const values = rareString(nodes.inputValue), textValues = rareString(nodes.textValue), checked = rareBoolean(nodes.inputChecked);
    const selected = rareBoolean(nodes.optionSelected), clickable = rareBoolean(nodes.isClickable);
    const attributesFor = (index: number): Record<string, string> => {
      const attributes: Record<string, string> = Object.create(null);
      const raw = nodes.attributes?.[index] ?? [];
      if (!Array.isArray(raw) || raw.length % 2) throw new Error("Invalid DOM snapshot attributes");
      for (let i = 0; i < raw.length; i += 2) {
        const name = stringAt(raw[i]), value = raw[i + 1] === -1 ? "" : stringAt(raw[i + 1]);
        if (name === undefined || value === undefined) throw new Error("Invalid DOM snapshot attribute string");
        attributes[name.toLowerCase()] = value;
      }
      return attributes;
    };
    // OPTION and SELECT ancestry is computed in two linear passes, including
    // layoutless options and text nested in arbitrary non-option elements.
    const optionIndexes = new Set<number>(), selectIndexes = new Set<number>();
    for (let index = 0; index < nodes.backendNodeId.length; index++) {
      const name = stringAt(nodes.nodeName[index])?.toLowerCase();
      if (name === "option") optionIndexes.add(index);
      else if (name === "select") selectIndexes.add(index);
    }
    const nearestOption = domIndex.nearestMarkedIndexes(optionIndexes);
    const nearestSelect = domIndex.nearestMarkedIndexes(selectIndexes);
    const optionText = new Map<number, string[]>();
    for (let index = 0; index < nodes.backendNodeId.length; index++) if (nodes.nodeType[index] === 3) {
      const parent = nearestOption[index]!;
      if (parent !== -1 && selected.has(parent)) {
        const parts = optionText.get(parent) ?? []; parts.push(stringAt(nodes.nodeValue?.[index]) ?? ""); optionText.set(parent, parts);
      }
    }
    const selections = new Map<number, Array<{ label: string; value: string }>>();
    for (const index of selected) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.backendNodeId.length || !optionIndexes.has(index))
        throw new Error("Invalid selected option identity");
      const parent = nearestSelect[index]!;
      if (parent === -1) continue;
      const attrs = attributesFor(index), text = (optionText.get(index) ?? []).join("").replace(/\s+/g, " ").trim();
      const list = selections.get(parent) ?? [];
      list.push({ label: Object.hasOwn(attrs, "label") ? attrs.label! : text, value: Object.hasOwn(attrs, "value") ? attrs.value! : text });
      selections.set(parent, list);
    }
    // Compute visible first-letter ancestry with a sweep of subtree ranges.
    // Each pseudo node contributes one start/end event, not an array on every descendant.
    const starts = new Map<number, string[]>(), ends = new Map<number, string[]>();
    for (const [parent, letters] of firstLetters) {
      const range = domIndex.subtreeRange(parent);
      if (!range) continue;
      for (const { text } of letters) {
        const opening = starts.get(range.start) ?? []; opening.push(text); starts.set(range.start, opening);
        const closing = ends.get(range.end) ?? []; closing.push(text); ends.set(range.end, closing);
      }
    }
    const projectedPrefix = new Map<number, string>();
    for (const [index, rows] of layouts) {
      const backendNodeId = nodes.backendNodeId[index];
      const projection = options.textProjections?.get(backendNodeId);
      if (!projection || options.covered.has(backendNodeId) || options.visibility.get(backendNodeId) !== true) continue;
      const type = nodes.nodeType[index], nodeName = stringAt(nodes.nodeName[index]);
      if (type !== 3 && !(type === 1 && /^::(?:before|after|marker|first-letter)$/i.test(nodeName ?? ""))) continue;
      const full = rows.map((row) => stringAt(layout.text?.[row])).filter((text): text is string => text !== undefined && text !== "").join("");
      if (full && full !== projection.full && projection.full.endsWith(full)) projectedPrefix.set(index, projection.full.slice(0, -full.length));
    }
    const activeLetters = new Map<string, number>(), matchingFirstLetters = new Map<number, number>();
    for (let position = 0; position < domIndex.preorder.length; position++) {
      for (const text of ends.get(position) ?? []) {
        const count = activeLetters.get(text)! - 1;
        if (count) activeLetters.set(text, count); else activeLetters.delete(text);
      }
      for (const text of starts.get(position) ?? []) activeLetters.set(text, (activeLetters.get(text) ?? 0) + 1);
      const index = domIndex.preorder[position]!, prefix = projectedPrefix.get(index);
      if (prefix) matchingFirstLetters.set(index, activeLetters.get(prefix) ?? 0);
    }
    for (let index = 0; index < nodes.backendNodeId.length; index++) {
      const backendNodeId = nodes.backendNodeId[index];
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
      if (options.covered.has(backendNodeId) || options.visibility.get(backendNodeId) !== true) continue;
      const type = nodes.nodeType[index];
      if (type !== 1 && type !== 3) continue;
      const rows = layouts.get(index);
      // A layoutless element can still be actionable when a descendant paints
      // (notably display:contents). Text requires its own paint evidence.
      if (!rows?.length && (type === 3 || !hasVisibleLayoutDescendant[index])) continue;
      const parentIndex = domIndex.parentAt(index), parentBackendNodeId = parentIndex === undefined ? undefined : domIndex.backendAt(parentIndex);
      const base = { frameId, backendNodeId, nodeIndex: index, ...(parentBackendNodeId === undefined ? {} : { parentBackendNodeId }) };
      const nodeName = stringAt(nodes.nodeName[index]);
      if (type === 3 || type === 1 && /^::(?:before|after|marker|first-letter)$/i.test(nodeName ?? "")) {
        const fragments = (rows ?? []).map((row) => stringAt(layout.text?.[row])).filter((text): text is string => text !== undefined && text !== "");
        // Preserve each rendered fragment, even if adjacent fragments match.
        // Source nodeValue may contain characters that were not painted.
        const full = fragments.join("");
        const projection = options.textProjections?.get(backendNodeId);
        let text = projection?.text ?? full;
        if (projection && full !== projection.full) {
          const prefix = full && projection.full.endsWith(full) ? projection.full.slice(0, -full.length) : "";
          // Only accept a prefix proven by a visible ::first-letter in this
          // node's ancestor chain and by the original DOM text. Emit that
          // pseudo node independently; do not duplicate it in this node.
          const source = stringAt(nodes.nodeValue?.[index]);
          if (!prefix || source !== projection.full || matchingFirstLetters.get(index) !== 1 || !text.startsWith(prefix))
            throw new Error("DOM text paint projection does not match layout text");
          text = text.slice(prefix.length);
        }
        if (text) result.push({ ...base, kind: "text", text });
        continue;
      }
      const tag = nodeName?.toLowerCase();
      if (!tag) continue;
      const attributes = attributesFor(index);
      const isControl = tag === "button" || tag === "select" || tag === "textarea" || tag === "iframe" || tag === "frame" || tag === "input" && (attributes.type ?? "text").toLowerCase() !== "hidden"
        || tag === "a" && Object.hasOwn(attributes, "href") || DOM_INTERACTIVE_ROLES.has(attributes.role?.trim() ?? "") || clickable.has(index)
        || Object.hasOwn(attributes, "contenteditable") && ["", "true", "plaintext-only"].includes(attributes.contenteditable!.trim().toLowerCase());
      if (!isControl) continue;
      const selectedOptions = tag === "select" && nodes.optionSelected !== undefined ? selections.get(index) ?? [] : undefined;
      const value = tag === "textarea" ? textValues.get(index) ?? ""
        : tag === "select" && selectedOptions !== undefined ? selectedOptions[0]?.value ?? "" : values.get(index);
      const layoutRow = rows?.[0];
      const textSecurity = layoutRow === undefined ? undefined : stringAt(layout.styles?.[layoutRow]?.[26]);
      const masked = (tag === "input" && (attributes.type ?? "").toLowerCase() === "password") || ["disc", "circle", "square"].includes(textSecurity ?? "");
      const valueVisible = textSecurity === "none" && !masked;
      result.push({ ...base, kind: "control", tag, attributes,
        ...(value === undefined ? {} : { value, valueVisible }),
        ...(masked ? { masked: true } : {}),
        ...(clickable.has(index) ? { clickable: true } : {}),
        ...(selectedOptions === undefined ? {} : { selectedOptions }),
        ...(tag === "input" && ["checkbox", "radio"].includes((attributes.type ?? "").toLowerCase()) ? { checked: checked.has(index) } : {}),
      });
    }
  }
  return { items: result, indexes, preformatted };
}
