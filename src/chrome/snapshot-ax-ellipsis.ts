/**
 * A candidate extracted from Blink's AX inline boxes, not yet evidence that
 * the candidate was painted. Keep it internal until geometry is confirmed.
 */
export type AxEllipsisCandidate = Readonly<{ prefix: string; marker: "…"; end: number }>;

type AxNode = Readonly<{
  nodeId?: unknown; parentId?: unknown; backendDOMNodeId?: unknown; ignored?: unknown;
  role?: { value?: unknown }; name?: { value?: unknown }; childIds?: unknown;
}>;
type TextBox = Readonly<{ start: number; length: number; bounds: readonly number[] }>;
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

// These scripts have left-to-right text order; reject bidi controls, Arabic
// numbers, and unrecognised strong RTL scripts rather than guessing an order.
const safeLtrText = /^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Mark}\p{Punctuation}\p{Symbol}\p{Zs}0-9\u200d]*$/u;
const rtlCharacters = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u;

/**
 * Match only Blink's unambiguous single-line `[full, prefix, …]` pattern.
 * AX includes non-painted text too: this function does not certify visibility.
 */
export function axEllipsisCandidate(input: {
  node: AxNode; nodesById: ReadonlyMap<string, AxNode>;
  frameId: string; expectedFrameId: string; backendNodeId: number;
  sourceText: string; layoutText: string; textBoxes: readonly TextBox[];
  direction: string; writingMode: string; textTransform: string; textSecurity: string;
}): AxEllipsisCandidate | undefined {
  const { node, nodesById, frameId, expectedFrameId, backendNodeId, sourceText, layoutText, textBoxes } = input;
  if (!frameId || frameId !== expectedFrameId || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0
    || node.backendDOMNodeId !== backendNodeId || typeof node.nodeId !== "string" || !node.nodeId || nodesById.get(node.nodeId) !== node
    || node.ignored === true || node.role?.value !== "StaticText" || node.name?.value !== layoutText
    || sourceText !== layoutText || !sourceText || !safeLtrText.test(sourceText) || rtlCharacters.test(sourceText)
    || input.direction !== "ltr" || input.writingMode !== "horizontal-tb" || input.textTransform !== "none" || input.textSecurity !== "none"
    || typeof Intl.Segmenter !== "function" || !Array.isArray(node.childIds) || node.childIds.length !== 3
    || node.childIds.some((id) => typeof id !== "string" || !id) || new Set(node.childIds).size !== 3
    || textBoxes.length !== 1) return undefined;
  const box = textBoxes[0]!;
  if (box.start !== 0 || box.length !== sourceText.length || box.bounds.length !== 4
    || !box.bounds.every(Number.isFinite) || box.bounds[2]! <= 0 || box.bounds[3]! <= 0) return undefined;
  const children = node.childIds.map((id) => nodesById.get(id));
  if (children.some((child) => !child || child.ignored === true || child.role?.value !== "InlineTextBox"
    || child.parentId !== node.nodeId || child.childIds !== undefined && (!Array.isArray(child.childIds) || child.childIds.length !== 0))) return undefined;
  const [full, clipped, marker] = children;
  if (full?.name?.value !== sourceText || typeof clipped?.name?.value !== "string" || marker?.name?.value !== "…") return undefined;
  const prefix = clipped.name.value;
  if (!prefix || prefix.length >= sourceText.length || !sourceText.startsWith(prefix)) return undefined;
  const boundary = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(sourceText)].some((segment) => segment.index === prefix.length);
  return boundary ? { prefix, marker: "…", end: prefix.length } : undefined;
}

/**
 * Confirm a candidate using separately obtained, stable live geometry/paint
 * evidence. `prefixBounds` must be the full Range for the candidate, and
 * `ellipsisWidth` must be a conservative measured width for the rendered
 * marker in the same CSS coordinate system as `clip`. Callers must establish
 * a single text node/line and unchanged, opaque paint independently.
 */
export function confirmAxEllipsis(candidate: AxEllipsisCandidate, proof: {
  clip: Rect; prefixBounds: Rect; ellipsisWidth: number; singleTextNode: boolean; singleLine: boolean; paintProven: boolean;
}): string | undefined {
  const { clip, prefixBounds: text, ellipsisWidth } = proof;
  const valid = (rect: Rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
  if (!proof.singleTextNode || !proof.singleLine || !proof.paintProven || !valid(clip) || !valid(text)
    || !Number.isFinite(ellipsisWidth) || ellipsisWidth <= 0 || text.x < clip.x || text.y < clip.y
    || text.y + text.height > clip.y + clip.height || text.x + text.width + ellipsisWidth > clip.x + clip.width) return undefined;
  return candidate.prefix + candidate.marker;
}
