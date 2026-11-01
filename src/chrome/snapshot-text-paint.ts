import type { SnapshotTextPaintCandidate } from "./snapshot-visibility";

/** Offsets are UTF-16 offsets in the original DOM Text node. */
export type TextPaintEvidence = {
  ranges: Array<[number, number]>;
  selection?: { start: number; end: number; text: string };
  language?: string;
  sourceText?: string;
  pseudoUnpainted?: boolean;
  firstLineRisk: boolean;
  firstLineRanges?: Array<[number, number]>;
  firstLetterRisk: boolean;
  unknown: boolean;
};

/** Compare precisely the captured inputs on which text-paint decisions depend. */
export function sameTextPaintCandidates(left: readonly SnapshotTextPaintCandidate[], right: readonly SnapshotTextPaintCandidate[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((a, index) => {
    const b = right[index]!;
    return a.backendNodeId === b.backendNodeId && a.frameId === b.frameId && a.kind === b.kind
      && a.pseudoType === b.pseudoType && a.sourceText === b.sourceText && a.layoutText === b.layoutText
      && a.textTransform === b.textTransform && a.textSecurity === b.textSecurity
      && a.direction === b.direction && a.writingMode === b.writingMode && a.ellipsis === b.ellipsis
      && a.fullyWithinClip === b.fullyWithinClip && a.zeroFont === b.zeroFont && a.basePainted === b.basePainted
      && a.documentFloatRisk === b.documentFloatRisk
      && a.firstLetter === b.firstLetter && a.firstLetterUnknown === b.firstLetterUnknown;
  });
}

/**
 * Runs in a frame's isolated world on a batch of Text nodes. It only reads
 * selections, custom highlights and styles; it does not alter the page.
 */
export const TEXT_PAINT_EVIDENCE_SOURCE = String.raw`function(...rest) {
  const nodes = [this, ...rest];
  const transparent = (value) => {
    const color = String(value || '').trim().toLowerCase();
    return color === 'transparent' || /^rgba\([^()]*,\s*(?:0+(?:\.0*)?|\.0+)%?\s*\)$/.test(color)
      || /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\/\s*(?:0+(?:\.0*)?|\.0+)%?\s*\)$/.test(color);
  };
  const mayPaint = (element, pseudo) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element, pseudo);
    const fill = style.getPropertyValue('-webkit-text-fill-color');
    const shadow = style.getPropertyValue('text-shadow');
    const stroke = style.getPropertyValue('-webkit-text-stroke-width');
    const strokeColor = style.getPropertyValue('-webkit-text-stroke-color');
    if (!fill || !shadow || !stroke || !strokeColor) return null;
    if (!transparent(fill)) return true;
    if (stroke !== '0px' && !transparent(strokeColor)) return null;
    if (shadow !== 'none') {
      // Computed shadows serialize a color per shadow. Only conclude that
      // they cannot paint when every serialized color is explicitly clear.
      const colors = shadow.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\btransparent\b/gi);
      const parts = shadow.split(/,(?![^()]*\))/);
      if (!colors || colors.length !== parts.length || !colors.every(transparent)) return null;
    }
    return false;
  };
  const pseudoProperties = ['color', '-webkit-text-fill-color', 'font-size', 'text-shadow', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'opacity', 'visibility', 'filter', 'background-clip', 'background-image'];
  const pseudoCache = new WeakMap();
  const firstLineCache = new WeakMap();
  const rulesCache = new WeakMap();
  const pseudoChanges = (element) => {
    const cached = pseudoCache.get(element);
    if (cached) return cached;
    const view = element.ownerDocument.defaultView;
    const base = view.getComputedStyle(element);
    const signature = (style) => pseudoProperties.map((name) => style.getPropertyValue(name)).join('\u0000');
    const baseSignature = signature(base);
    const value = { line: signature(view.getComputedStyle(element, '::first-line')) !== baseSignature,
      letter: signature(view.getComputedStyle(element, '::first-letter')) !== baseSignature };
    pseudoCache.set(element, value);
    return value;
  };
  // Prove a first-line prefix only for a simple left-to-right inline flow
  // ending in an explicit break. Do not infer line membership from y alone:
  // superscripts and different font sizes can have disjoint vertical boxes.
  const firstLineRanges = (block) => {
    if (firstLineCache.has(block)) return firstLineCache.get(block);
    const fail = () => { firstLineCache.set(block, null); return null; };
    try {
      const doc = block.ownerDocument, view = doc.defaultView;
      if (!view || block.getRootNode() !== doc) return fail();
      const linePaint = mayPaint(block, '::first-line');
      if (linePaint === null) return fail();
      // Script-created Web Animations do not change computed animation-name.
      // Their effects may override first-line inheritance at any descendant.
      if (typeof block.getAnimations !== 'function' || block.getAnimations({ subtree: true }).length) return fail();
      const blockStyle = view.getComputedStyle(block);
      const lineStyle = view.getComputedStyle(block, '::first-line');
      if (lineStyle.visibility !== 'visible' || lineStyle.opacity !== '1' || lineStyle.filter !== 'none' || lineStyle.fontSize === '0px'
        || lineStyle.textTransform !== blockStyle.textTransform
        || lineStyle.getPropertyValue('-webkit-text-security') !== blockStyle.getPropertyValue('-webkit-text-security')) return fail();
      if (!['block', 'flow-root'].includes(blockStyle.display) || blockStyle.direction !== 'ltr' || blockStyle.writingMode !== 'horizontal-tb'
        || !['start', 'left'].includes(blockStyle.textAlign) || parseFloat(blockStyle.textIndent) !== 0 || blockStyle.columnCount !== 'auto'
        || blockStyle.columnWidth !== 'auto' || !['auto', 'start', 'left'].includes(blockStyle.textAlignLast)
        || !['none', 'normal'].includes(view.getComputedStyle(block, '::before').content)
        || !['none', 'normal'].includes(view.getComputedStyle(block, '::after').content)) return fail();
      const badStyle = (style) => style.direction !== 'ltr' || style.writingMode !== 'horizontal-tb' || style.float !== 'none'
        || style.position !== 'static' || style.transform !== 'none' || style.filter !== 'none' || style.opacity !== '1'
        || style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.clipPath !== 'none'
        || style.getPropertyValue('mask-image') !== 'none' || style.textTransform !== 'none'
        || style.getPropertyValue('-webkit-text-security') !== 'none' || style.textOverflow !== 'clip'
        || style.getPropertyValue('-webkit-line-clamp') !== 'none' || style.animationName !== 'none'
        || style.transitionDuration.split(',').some((part) => parseFloat(part) !== 0)
        || !['normal', '0px'].includes(style.letterSpacing) || !['normal', '0px'].includes(style.wordSpacing)
        || !['normal', 'isolate'].includes(style.unicodeBidi);
      for (let ancestor = block; ancestor; ancestor = ancestor.parentElement)
        if (badStyle(view.getComputedStyle(ancestor)) || typeof ancestor.getAnimations !== 'function' || ancestor.getAnimations().length) return fail();
      let rules = rulesCache.get(doc);
      if (!rules) {
        const sheets = [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])]; rules = [];
        while (sheets.length) {
          const sheet = sheets.pop();
          for (const rule of sheet.cssRules) {
            if (rule.cssRules) sheets.push(rule);
            if (rule.style && rule.selectorText) rules.push(rule);
            if (rule.styleSheet) sheets.push(rule.styleSheet);
          }
        }
        rulesCache.set(doc, rules);
      }
      const affectsMapping = (style) => Array.from(style).some((name) => /^(?:all|text-transform|-webkit-text-security)$/i.test(name));
      const affectsPaint = (style) => affectsMapping(style) || Array.from(style).some((name) => /^(?:all|color|background(?:-.*)?|-webkit-text-fill-color|-webkit-text-stroke(?:-.*)?|text-shadow|opacity|filter|visibility|animation(?:-.*)?|transition(?:-.*)?)$/i.test(name));
      const uncertainSelector = (selector) => /:visited\b/i.test(selector) || selector.includes('\\') && selector.includes(':');
      if (rules.some((rule) => affectsPaint(rule.style) && uncertainSelector(rule.selectorText))) return fail();
      if (rules.some((rule) => affectsMapping(rule.style) && /::?first-line\b/i.test(rule.selectorText))) return fail();
      const checks = (element) => {
        if (element.hasAttribute('color') || element.hasAttribute('dir') || affectsPaint(element.style)) return false;
        for (const rule of rules) {
          if (!affectsPaint(rule.style)) continue;
          // Selector matching intentionally conceals visited-link state. A
          // false match result is therefore not proof of no paint override.
          if (uncertainSelector(rule.selectorText)) return false;
          if (element.matches(rule.selectorText)) return false;
        }
        return true;
      };
      const prefix = new Map(), stack = [...block.childNodes].reverse();
      let broke = false, priorRight = -Infinity, any = false;
      while (stack.length && !broke) {
        const node = stack.pop();
        if (node.nodeType === 1) {
          const style = view.getComputedStyle(node);
          if (style.display === 'none') continue;
          if (node.tagName === 'BR') { broke = true; break; }
          if (style.display !== 'inline' || badStyle(style) || !checks(node)
            || ['margin-left', 'margin-right', 'padding-left', 'padding-right', 'border-left-width', 'border-right-width'].some((name) => parseFloat(style.getPropertyValue(name)) !== 0)
            || !['none', 'normal'].includes(view.getComputedStyle(node, '::before').content)
            || !['none', 'normal'].includes(view.getComputedStyle(node, '::after').content)) return fail();
          for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
        } else if (node.nodeType === 3) {
          const source = node.data;
          // Restrict the proof to scripts with left-to-right text ordering;
          // other scripts and directional controls retain the original AX row.
          if (!/^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{M}\x09\x0a\x0d\x20-\x7e\u3000-\u303f\uff00-\uffef]*$/u.test(source)) return fail();
          const parentStyle = view.getComputedStyle(node.parentElement);
          const preservesNewline = ['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(parentStyle.whiteSpace);
          const breakAt = preservesNewline ? source.search(/[\r\n]/) : -1;
          const end = breakAt < 0 ? source.length : breakAt;
          if (end) {
            const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, end);
            const boxes = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            if (boxes.length !== 1 || boxes[0].width < 1 || boxes[0].height < 1 || boxes[0].left + 0.00001 < priorRight) return fail();
            priorRight = boxes[0].right; any = true; if (linePaint) prefix.set(node, [[0, end]]);
          }
          if (breakAt >= 0) broke = true;
        } else if (node.nodeType !== 8) return fail();
      }
      if (!broke || !any) return fail();
      firstLineCache.set(block, prefix); return prefix;
    } catch { return fail(); }
  };
  return nodes.map((node) => {
    const result = { ranges: [], firstLineRisk: false, firstLetterRisk: false, unknown: false };
    try {
      // CDP exposes pseudo elements as Element in Chrome 138 and as
      // CSSPseudoElement in newer Chrome. Neither form is a DOM Text node.
      const pseudo = node && (node.nodeName === '::before' || node.nodeName === '::after' ? node.nodeName : node.type);
      if (pseudo === '::before' || pseudo === '::after') {
        const host = node.element || node.parentElement;
        if (!host || !host.isConnected || !host.ownerDocument?.defaultView) { result.unknown = true; return result; }
        const doc = host.ownerDocument, view = doc.defaultView, selection = doc.getSelection();
        const highlights = view.CSS && view.CSS.highlights;
        if (!selection || !selection.isCollapsed || highlights && highlights.size > 0) { result.unknown = true; return result; }
        const style = view.getComputedStyle(host, pseudo);
        const fill = style.getPropertyValue('-webkit-text-fill-color'), font = style.getPropertyValue('font-size');
        const shadow = style.getPropertyValue('text-shadow'), stroke = style.getPropertyValue('-webkit-text-stroke-width');
        const filter = style.getPropertyValue('filter'), backgroundClip = style.getPropertyValue('background-clip');
        if (!fill || !font || !shadow || !stroke || !filter || !backgroundClip || filter !== 'none' || /(?:^|,)\s*text\s*(?:,|$)/.test(backgroundClip)) {
          result.unknown = true; return result;
        }
        result.pseudoUnpainted = font === '0px' || transparent(fill) && shadow === 'none' && stroke === '0px';
        for (let element = host; element; ) {
          const changes = pseudoChanges(element);
          result.firstLineRisk ||= changes.line;
          result.firstLetterRisk ||= changes.letter;
          const parent = element.parentElement;
          const containingRoot = !parent && element.getRootNode();
          element = parent || (containingRoot && containingRoot.host) || null;
        }
        return result;
      }
      if (!node || node.nodeType !== 3 || !node.isConnected || !node.ownerDocument || !node.parentElement) { result.unknown = true; return result; }
      const doc = node.ownerDocument, view = doc.defaultView, root = node.getRootNode();
      result.sourceText = node.data;
      if (!view) { result.unknown = true; return result; }
      const add = (source, selectionText) => {
        const startRoot = source.startContainer && source.startContainer.getRootNode();
        const endRoot = source.endContainer && source.endContainer.getRootNode();
        if (!startRoot || !endRoot) { result.unknown = true; return; }
        if (startRoot !== endRoot) { result.unknown = true; return; }
        if (startRoot !== root) return;
        const range = doc.createRange();
        range.setStart(source.startContainer, source.startOffset);
        range.setEnd(source.endContainer, source.endOffset);
        if (range.collapsed || !range.intersectsNode(node)) return;
        const length = node.data.length;
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset : length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > length || start > end) { result.unknown = true; return; }
        if (start < end) {
          if (typeof selectionText === 'string' && range.startContainer === node && range.endContainer === node)
            result.selection = { start, end, text: selectionText };
          else result.ranges.push([start, end]);
        }
      };
      const selection = doc.getSelection();
      if (!selection) result.unknown = true;
      else if (!selection.isCollapsed && selection.rangeCount) {
        const painted = mayPaint(node.parentElement, '::selection');
        if (painted === null) result.unknown = true;
        else if (painted) {
          if (typeof selection.getComposedRanges === 'function') {
            const shadowRoots = [];
            for (let current = root; current && current.host; current = current.host.getRootNode()) shadowRoots.push(current);
            const ranges = selection.getComposedRanges({ shadowRoots });
            for (const range of ranges) add(range, ranges.length === 1 ? selection.toString() : undefined);
          } else if (root !== doc) result.unknown = true;
          else for (let index = 0; index < selection.rangeCount; index++) add(selection.getRangeAt(index), selection.rangeCount === 1 ? selection.toString() : undefined);
        }
      }
      const highlights = view.CSS && view.CSS.highlights;
      if (highlights) {
        for (const [name, highlight] of highlights) {
          if (!view.CSS.escape) { result.unknown = true; break; }
          const painted = mayPaint(node.parentElement, '::highlight(' + view.CSS.escape(name) + ')');
          if (painted === null) { result.unknown = true; continue; }
          if (painted) for (const range of highlight) add(range);
        }
      }
      let firstLineBlock;
      for (let element = node.parentElement; element; ) {
        if (!result.language) result.language = element.getAttribute('lang') || element.getAttribute('xml:lang') || undefined;
        const changes = pseudoChanges(element);
        result.firstLineRisk ||= changes.line;
        if (changes.line && !firstLineBlock) firstLineBlock = element;
        result.firstLetterRisk ||= changes.letter;
        const parent = element.parentElement;
        const containingRoot = !parent && element.getRootNode();
        element = parent || (containingRoot && containingRoot.host) || null;
      }
      if (firstLineBlock) {
        const proven = firstLineRanges(firstLineBlock);
        if (proven) { result.firstLineRisk = false; result.firstLineRanges = proven.get(node) || []; }
      }
    } catch { result.unknown = true; }
    return result;
  });
}`;

/**
 * Cache only weak references to Text wrappers in the frame's isolated world.
 * The token is owned by one FrameDocument; a new document/context starts a
 * fresh cache. Evidence itself is always recomputed for the current capture.
 */
export const TEXT_PAINT_CACHE_LOOKUP_SOURCE = `function(token, ids) {
  if (!this.defaultView || this.defaultView.document !== this) throw new Error('text-paint node detached: frame document no longer active');
  const key = Symbol.for('surf-wax.text-paint-cache.v1');
  let cache = globalThis[key];
  if (!cache || cache.token !== token) cache = globalThis[key] = { token, nodes: new Map() };
  const nodes = [], positions = [], results = ids.map(() => null);
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index], reference = cache.nodes.get(id), node = reference && reference.deref();
    if (!node || node.nodeType !== 3 || !node.isConnected || node.ownerDocument !== this) { cache.nodes.delete(id); continue; }
    cache.nodes.delete(id); cache.nodes.set(id, reference);
    positions.push(index); nodes.push(node);
  }
  if (nodes.length) {
    const analyze = (${TEXT_PAINT_EVIDENCE_SOURCE});
    const values = analyze.call(nodes[0], ...nodes.slice(1));
    for (let index = 0; index < positions.length; index++) results[positions[index]] = values[index];
  }
  return results;
}`;

/** Store only live same-document Text nodes; pseudo nodes remain uncached. */
export const TEXT_PAINT_CACHE_REGISTER_SOURCE = `function(token, ids, ...nodes) {
  if (!this.defaultView || this.defaultView.document !== this) throw new Error('text-paint node detached: frame document no longer active');
  const key = Symbol.for('surf-wax.text-paint-cache.v1');
  let cache = globalThis[key];
  if (!cache || cache.token !== token) cache = globalThis[key] = { token, nodes: new Map() };
  for (const node of nodes) {
    // A backend ID can be resolved in a different frame's execution world;
    // never associate or analyze it until ownership is checked explicitly.
    const target = node && node.nodeType === 3 ? node : node && (node.element || node.parentElement);
    if (!target || !target.isConnected) throw new Error('text-paint node detached');
    if (target.ownerDocument !== this) throw new Error('text-paint node frame mismatch');
  }
  if (typeof WeakRef === 'function') {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index], id = ids[index];
      if (node && node.nodeType === 3 && node.isConnected && node.ownerDocument === this) {
        cache.nodes.delete(id); cache.nodes.set(id, new WeakRef(node));
      }
    }
    while (cache.nodes.size > 8192) cache.nodes.delete(cache.nodes.keys().next().value);
  }
  const analyze = (${TEXT_PAINT_EVIDENCE_SOURCE});
  return nodes.length ? analyze.call(nodes[0], ...nodes.slice(1)) : [];
}`;

/** Undefined means the evidence cannot safely refine the original AX name. */
export function projectTextPaint(candidate: SnapshotTextPaintCandidate, evidence: TextPaintEvidence | undefined): { hidden: boolean; text?: string } | undefined {
  if (!evidence || !Array.isArray(evidence.ranges) || evidence.unknown || evidence.firstLineRisk || candidate.firstLetterUnknown || evidence.firstLetterRisk && !candidate.firstLetter)
    return undefined;
  if (evidence.firstLineRanges && candidate.documentFloatRisk !== false) return undefined;
  if (candidate.kind === "pseudo") return evidence.pseudoUnpainted ? { hidden: true } : undefined;
  if (candidate.basePainted) {
    if (!candidate.fullyWithinClip || typeof candidate.layoutText !== "string" || typeof candidate.sourceText !== "string"
      || evidence.sourceText !== candidate.sourceText) return undefined;
    return { hidden: false, text: (candidate.firstLetter ?? "") + candidate.layoutText };
  }
  const source = candidate.sourceText, layout = candidate.layoutText;
  if (typeof source !== "string" || typeof layout !== "string" || evidence.sourceText !== source) return undefined;
  const firstLetter = candidate.firstLetter ?? "";
  const ranges: Array<[number, number]> = candidate.zeroFont ? [] : evidence.ranges.map((range) => [...range]);
  for (const range of evidence.firstLineRanges ?? []) ranges.push(range);
  const selection = candidate.zeroFont ? undefined : evidence.selection;
  if (selection) ranges.push([selection.start, selection.end]);
  if (firstLetter) ranges.push([0, firstLetter.length]);
  if (ranges.some((range) => range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] > source.length || range[0] >= range[1])) return undefined;
  if (!ranges.length) return { hidden: true };
  if (!candidate.fullyWithinClip) return undefined;
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // Splitting a grapheme can expose only half of a character or combining
  // sequence; retain the original AX observation when boundaries are unsure.
  if (typeof Intl.Segmenter !== "function") return undefined;
  const boundaries = new Set<number>([source.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)) boundaries.add(segment.index);
  if (merged.some(([start, end]) => !boundaries.has(start) || !boundaries.has(end))) return undefined;
  // For a selection contained in this single Text node, Chrome exposes its
  // actually transformed text directly, including text-security glyphs.
  if (selection && !firstLetter && evidence.ranges.length === 0)
    return selection.text ? { hidden: false, text: selection.text } : { hidden: true };
  if (source === firstLetter + layout)
    return { hidden: false, text: merged.map(([start, end]) => source.slice(start, end)).join(" … ") };
  if (firstLetter) return undefined;

  const transform = candidate.textTransform ?? "none";
  const security = candidate.textSecurity ?? "none";
  if (!["none", "uppercase", "lowercase"].includes(transform) || !["none", "disc", "circle", "square"].includes(security)) return undefined;
  const mask = { disc: "•", circle: "◦", square: "■" } as const;
  const render = (part: string) => {
    const text = transform === "uppercase" ? part.toLocaleUpperCase(evidence.language || undefined)
      : transform === "lowercase" ? part.toLocaleLowerCase(evidence.language || undefined) : part;
    return security === "none" ? text : [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(() => mask[security as keyof typeof mask]).join("");
  };
  try {
    const pieces: Array<{ start: number; end: number; text: string }> = [];
    let previous = 0, rebuilt = "";
    for (const [start, end] of merged) {
      rebuilt += render(source.slice(previous, start));
      const text = render(source.slice(start, end));
      rebuilt += text;
      pieces.push({ start, end, text });
      previous = end;
    }
    rebuilt += render(source.slice(previous));
    if (rebuilt !== layout) return undefined;
    return { hidden: false, text: pieces.map(({ text }) => text).join(" … ") };
  } catch { return undefined; }
}
