/**
 * Conservative live evidence for a placeholder. Unknown never carries the
 * source string: its presence in a DOM attribute is not proof it was painted.
 * Compare two results around the AX/DOM capture; equal results do not rule out
 * an intermediate ABA change.
 */
export type PlaceholderEvidence =
  | Readonly<{ status: "visible"; text: string }>
  | Readonly<{ status: "hidden" }>
  | Readonly<{ status: "unknown" }>;

export function samePlaceholderEvidence(a: PlaceholderEvidence, b: PlaceholderEvidence): boolean {
  return a.status === b.status && (a.status !== "visible" || b.status === "visible" && a.text === b.text);
}

/**
 * Invoke on the live control with the UA-shadow text node as an object
 * argument, and the placeholder value read from D0 as a value argument. This
 * source is self-contained because CDP runs it in the frame's execution world.
 * It does not change the document or the current selection.
 */
export const PLACEHOLDER_EVIDENCE_SOURCE = String.raw`function(text, expected) {
  const unknown = () => ({ status: 'unknown' });
  const hidden = () => ({ status: 'hidden' });
  try {
    const host = this, doc = host && host.ownerDocument, view = doc && doc.defaultView;
    if (!host || !host.isConnected || !view || !['INPUT', 'TEXTAREA'].includes(host.nodeName)
        || typeof host.value !== 'string' || typeof expected !== 'string' || !expected) return unknown();
    if (host.value !== '') return hidden();
    if (!text || text.nodeType !== 3 || !text.isConnected || text.ownerDocument !== doc
        || text.getRootNode()?.host !== host || !text.parentElement
        || text.parentElement.getAttribute('pseudo') !== '-webkit-input-placeholder'
        || text.parentElement.childNodes.length !== 1 || text.parentElement.firstChild !== text
        || text.data !== expected || host.placeholder !== expected) return unknown();
    const parent = text.parentElement, style = view.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return hidden();
    const prop = (s, name) => s.getPropertyValue(name).trim().toLowerCase();
    const noEffect = (s) => prop(s, 'transform') === 'none' && ['none', ''].includes(prop(s, 'translate'))
      && ['none', ''].includes(prop(s, 'rotate')) && ['none', ''].includes(prop(s, 'scale'))
      && prop(s, 'filter') === 'none' && prop(s, 'backdrop-filter') === 'none'
      && prop(s, 'clip-path') === 'none' && prop(s, 'clip') === 'auto'
      && prop(s, 'mask-image') === 'none' && prop(s, '-webkit-mask-box-image-source') === 'none'
      && prop(s, 'perspective') === 'none';
    if (!noEffect(style) || prop(style, 'text-transform') !== 'none'
        || prop(style, '-webkit-text-security') !== 'none' || prop(style, 'text-shadow') !== 'none'
        || prop(style, '-webkit-text-stroke-width') !== '0px' || prop(style, 'background-clip') !== 'border-box'
        || prop(style, 'text-overflow') !== 'clip' || prop(style, '-webkit-line-clamp') !== 'none'
        || !['monospace', 'sans-serif', 'serif', 'system-ui'].includes(prop(style, 'font-family'))
        || !Number.isFinite(parseFloat(style.fontSize)) || parseFloat(style.fontSize) <= 0
        || /[\r\n]/.test(expected) || doc.fonts && doc.fonts.status !== 'loaded') return unknown();
    const fill = prop(style, '-webkit-text-fill-color');
    if (!fill) return unknown();
    if (fill === 'transparent' || /^rgba\([^()]*,\s*0(?:\.0+)?\s*\)$/.test(fill)) return hidden();
    // Color functions with unrecognized alpha are deliberately not guessed.
    if (!/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(fill)) return unknown();
    const selection = doc.getSelection();
    if (!selection || !selection.isCollapsed || view.CSS?.highlights?.size) return unknown();
    const range = doc.createRange(); range.selectNodeContents(text);
    const boxes = Array.from(range.getClientRects());
    if (boxes.length !== 1) return unknown();
    const box = boxes[0];
    if (![box.left, box.right, box.top, box.bottom, view.innerWidth, view.innerHeight].every(Number.isFinite)
        || box.right <= box.left || box.bottom <= box.top || box.left < 0 || box.top < 0
        || box.right > view.innerWidth || box.bottom > view.innerHeight) return unknown();
    // Each clipped ancestor contributes a client box. A clipped rounded corner
    // or complex transform cannot be proven by axis-aligned rectangles.
    for (let element = parent; element; ) {
      const s = view.getComputedStyle(element);
      if (s.display === 'none' || Number(s.opacity) === 0) return hidden();
      if (!noEffect(s) || !Number.isFinite(Number(s.opacity))) return unknown();
      const x = prop(s, 'overflow-x'), y = prop(s, 'overflow-y');
      if (!['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(x)
          || !['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(y)) return unknown();
      if (x !== 'visible' || y !== 'visible') {
        if (prop(s, 'border-top-left-radius') !== '0px' || prop(s, 'border-top-right-radius') !== '0px'
            || prop(s, 'border-bottom-left-radius') !== '0px' || prop(s, 'border-bottom-right-radius') !== '0px') return unknown();
        const rect = element.getBoundingClientRect(), left = rect.left + element.clientLeft, top = rect.top + element.clientTop;
        if (![left, top, element.clientWidth, element.clientHeight].every(Number.isFinite)
            || x !== 'visible' && (box.left < left || box.right > left + element.clientWidth)
            || y !== 'visible' && (box.top < top || box.bottom > top + element.clientHeight)) return unknown();
      }
      const root = element.getRootNode();
      element = element.parentElement || (root && root.host) || null;
    }
    // The UA placeholder box itself clips overflow even when CSS reports
    // overflow:visible; require complete containment independently.
    const rect = parent.getBoundingClientRect(), left = rect.left + parent.clientLeft, top = rect.top + parent.clientTop;
    if (![left, top, parent.clientWidth, parent.clientHeight].every(Number.isFinite)
        || box.left < left || box.right > left + parent.clientWidth || box.top < top || box.bottom > top + parent.clientHeight) return unknown();
    if (host.value !== '' || host.placeholder !== expected || text.data !== expected || !text.isConnected) return unknown();
    return { status: 'visible', text: expected };
  } catch { return unknown(); }
}`;
