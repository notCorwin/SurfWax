import type { SnapshotLine } from "./snapshot-frame-tree";
import { renderSnapshotNode } from "./snapshot-render";

export type ReadableSnapshot = {
  url: string; title: string;
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  rows: Array<{ text: string; depth: number }>;
};

/** One synchronous read: page tasks cannot replace DOM/text between the paint,
 * clipping and viewport reads. Omit uncertain paint instead of trusting AX names.
 * This deliberately conservative projection supplies no controls or action refs. */
export const READABLE_SNAPSHOT_SOURCE = String.raw`function() {
  /* surf-wax:read-only-snapshot */
  if (document.readyState !== 'complete') return null;
  const viewport = { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scale: devicePixelRatio };
  const result = { url: location.href, title: document.title, viewport, rows: [] };
  if (globalThis.CSS?.highlights?.size) return result;
  const styles = new Map(), safe = new Map(), covers = [];
  const style = (element) => { let value = styles.get(element); if (!value) { value = getComputedStyle(element); styles.set(element, value); } return value; };
  const clear = (value) => value === 'transparent' || /^rgba\([^()]*,\s*0(?:\.0*)?\s*\)$/.test(value) || /\/\s*0(?:\.0*)?\s*\)$/.test(value);
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const inViewport = (r) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= viewport.width && r.bottom <= viewport.height;
  const pseudoProperties = ['color', '-webkit-text-fill-color', '-webkit-text-security', 'font-size', 'font-family', 'font-weight', 'text-transform', 'text-shadow', '-webkit-text-stroke-width', 'visibility', 'opacity', 'filter', 'background-clip', 'background-image'];
  const effects = ['transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter', 'perspective', 'clip-path', 'mask-image', '-webkit-mask-box-image-source'];
  const uncomplicated = (element) => {
    if (safe.has(element)) return safe.get(element);
    const s = style(element);
    let value = element.namespaceURI === 'http://www.w3.org/1999/xhtml' && !element.shadowRoot && !element.assignedSlot
      && s.display !== 'none' && s.visibility === 'visible' && s.contentVisibility === 'visible' && s.contain === 'none' && Number(s.opacity) > 0
      && effects.every((key) => !s.getPropertyValue(key) || s.getPropertyValue(key) === 'none')
      && s.clip === 'auto' && s.mixBlendMode === 'normal' && s.display !== 'list-item'
      && (s.overflowX === 'visible' && s.overflowY === 'visible' || /^(?:0(?:px|%)?\s*)+$/.test(s.borderRadius));
    if (value) {
      for (const pseudo of ['::first-line', '::first-letter']) {
        const p = getComputedStyle(element, pseudo);
        if (pseudoProperties.some((key) => p.getPropertyValue(key) !== s.getPropertyValue(key))) { value = false; break; }
      }
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(element, pseudo).content;
        if (content && content !== 'none' && content !== 'normal') { value = false; break; }
      }
    }
    safe.set(element, value); return value;
  };
  const viewportRect = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  for (const element of document.querySelectorAll('*')) {
    const s = style(element), rect = element.getBoundingClientRect();
    if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) continue;
    const pseudoPaint = ['::before', '::after'].some((pseudo) => { const content = getComputedStyle(element, pseudo).content; return content && content !== 'none' && content !== 'normal'; });
    const modal = element.matches(':modal');
    const unbounded = pseudoPaint || modal || s.display === 'list-item' || s.outlineStyle !== 'none' || s.boxShadow !== 'none' || effects.some((key) => s.getPropertyValue(key) && s.getPropertyValue(key) !== 'none');
    if (!unbounded && !overlaps(rect, viewportRect)) continue;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s['border' + side + 'Width']) > 0);
    // Even unverified foreground text can cover another text run. Its own
    // eligibility must not decide whether it is a potential occluder.
    if (unbounded || border || element.textContent?.trim() || !clear(s.backgroundColor) || s.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS|SVG|IFRAME|OBJECT|EMBED)$/i.test(element.tagName))
      covers.push({ element, rect: unbounded ? viewportRect : rect });
  }
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT), candidates = [];
  const selection = getSelection();
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement, text = node.nodeValue;
    if (!parent || !text?.trim()) continue;
    const s = style(parent);
    if (s.textTransform !== 'none' || s.webkitTextSecurity !== 'none' || clear(s.webkitTextFillColor || s.color) || !(parseFloat(s.fontSize) > 0)) continue;
    let depth = 0, valid = true;
    for (let element = parent; element; element = element.parentElement) {
      depth++;
      if (!uncomplicated(element)) { valid = false; break; }
    }
    if (!valid || selection?.rangeCount && selection.containsNode(node, true)) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (!rects.length || !rects.every(inViewport)) continue;
    for (let element = parent; element && valid; element = element.parentElement) {
      const s = style(element), rect = element.getBoundingClientRect();
      const left = rect.left + element.clientLeft, top = rect.top + element.clientTop;
      for (const r of rects) if (s.overflowX !== 'visible' && (r.left < left || r.right > left + element.clientWidth)
        || s.overflowY !== 'visible' && (r.top < top || r.bottom > top + element.clientHeight)) { valid = false; break; }
    }
    if (!valid || covers.some(({ element, rect }) => !element.contains(parent) && rects.some((r) => overlaps(r, rect)))) continue;
    candidates.push({ text, depth, rects });
  }
  // Overlapping foreign text can also obscure characters without a background.
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if (candidates.some((other, j) => j !== i && item.rects.some((a) => other.rects.some((b) => overlaps(a, b))))) continue;
    result.rows.push({ text: item.text, depth: item.depth });
  }
  return result;
}`;

export function readableSnapshot(value: ReadableSnapshot): SnapshotLine[] {
  if (!value || !Array.isArray(value.rows) || typeof value.url !== "string" || typeof value.title !== "string"
    || ![value.viewport?.x, value.viewport?.y, value.viewport?.width, value.viewport?.height, value.viewport?.scale].every(Number.isFinite)
    || value.viewport.width <= 0 || value.viewport.height <= 0 || value.viewport.scale <= 0) throw new Error("Invalid read-only observation");
  return value.rows.map(({ text, depth }, index) => {
    if (typeof text !== "string" || !Number.isSafeInteger(depth) || depth < 0) throw new Error("Invalid read-only text");
    const node = { id: `readonly:${index}`, role: "text", name: text, depth, preserveTextWhitespace: true };
    return { ...renderSnapshotNode(node), node };
  });
}
