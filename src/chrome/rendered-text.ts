/** Scoped synchronous rendering evidence. No viewport intersection is required:
 * scrollable text remains addressable. null means no complete text evidence.
 * innerText is used only for browser whitespace/layout serialization after every
 * contributing text node has independent rendering evidence.
 */
export function readRenderedText(this: Element): string | null {
  const root = this, view = root.ownerDocument?.defaultView;
  if (!root.isConnected || !view) return null;
  const parent = (node: Node): Element | null => node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => { let s = styles.get(el); if (!s) { s = view.getComputedStyle(el); styles.set(el, s); } return s; };
  const rendered = (el: Element) => {
    for (let p: Element | null = el; p; p = parent(p)) {
      const s = style(p);
      if (s.display === 'none' || s.contentVisibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return style(el).visibility === 'visible';
  };
  if (!rendered(root)) return null;
  let unknown = false, excluded = false, complexSerialization = false, hasBox = root.getClientRects().length > 0;
  const walk = (el: Element): string => {
    if (!rendered(el)) return '';
    // A shadow host's light tree is not its rendered tree. Do not guess at
    // slot distribution (or substitute accessible names for displayed text).
    if (el.shadowRoot || el.localName === 'slot') { unknown = true; return ''; }
    const s = style(el);
    if (!['normal', 'nowrap'].includes(s.whiteSpace)) complexSerialization = true;
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(el, pseudo).content;
      if (!['none', 'normal', '""'].includes(content)) unknown = true;
    }
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 1) {
        const element = child as Element;
        if (!rendered(element)) { excluded = true; continue; }
        if (element.localName === 'br') { out += '\n'; continue; }
        const text = walk(element), display = style(element).display;
        const block = !['inline', 'contents', 'inline-block', 'inline-flex', 'inline-grid', 'none'].includes(display);
        if (block && text) complexSerialization = true;
        out += block && text ? '\n' + text + '\n' : text;
      } else if (child.nodeType === 3 && child.nodeValue) {
        const range = root.ownerDocument.createRange(); range.selectNodeContents(child);
        const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (!rects.length) { if (child.nodeValue.trim()) unknown = true; continue; }
        hasBox = true;
        for (let p: Element | null = el; p; p = parent(p)) {
          const ps = style(p), box = p.getBoundingClientRect();
          // Unsupported clipping/paint must not certify the original string.
          if (ps.clipPath !== 'none' || ps.clip !== 'auto' || ps.maskImage !== 'none' || ps.filter !== 'none'
            || ps.transform !== 'none' || ps.getPropertyValue('-webkit-text-fill-color') === 'rgba(0, 0, 0, 0)'
            || ps.getPropertyValue('-webkit-text-security') !== 'none'
            || ps.getPropertyValue('-webkit-line-clamp') !== 'none'
            || /(?:^|\s)transparent(?:$|\s)/.test(ps.color) || ps.color === 'rgba(0, 0, 0, 0)') unknown = true;
          if (['hidden', 'clip'].includes(ps.overflowX) && rects.some(r => r.left < box.left || r.right > box.right)
            || ['hidden', 'clip'].includes(ps.overflowY) && rects.some(r => r.top < box.top || r.bottom > box.bottom)) unknown = true;
        }
        out += s.whiteSpace.startsWith('pre') || s.whiteSpace === 'break-spaces'
          ? child.nodeValue : child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
        if (s.textTransform !== 'none') unknown = true;
      }
    }
    return out;
  };
  const text = walk(root).replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!root.isConnected || !hasBox || unknown || excluded && complexSerialization) return null;
  return !excluded && root instanceof view.HTMLElement ? root.innerText : text;
}
export const RENDERED_TEXT_SOURCE = readRenderedText.toString();
