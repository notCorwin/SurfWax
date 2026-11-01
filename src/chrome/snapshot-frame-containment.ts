/**
 * This proof is intentionally stronger than frame-owner visibility: the entire
 * frame element must fit in its parent's viewport and every ancestor clip. It
 * can therefore be combined with a child-viewport-local full-containment proof
 * without exposing cross-origin frame coordinates or guessing partial overlap.
 *
 * Invoke with the DOM.getFrameOwner node resolved in its *parent* frame's
 * execution context. Repeat around capture while guarding frame/context
 * identity. This proves rectangular CSS containment, not absence of visual
 * occlusion by an unrelated overlapping element. Unhandled effects are unknown.
 */
export type FrameContainmentEvidence = Readonly<{ status: "visible" | "unknown" }>;

export const FRAME_OWNER_FULLY_VISIBLE_SOURCE = String.raw`function() {
  const unknown = () => ({ status: 'unknown' });
  try {
    const owner = this, doc = owner && owner.ownerDocument, view = doc && doc.defaultView;
    const html = 'http://www.w3.org/1999/xhtml';
    // Other frame owner types require their own proof of embedded viewport
    // geometry. SVG ancestors may establish non-CSS viewBox transforms/clips.
    if (!owner || !owner.isConnected || !view || owner.namespaceURI !== html
        || !['iframe', 'frame'].includes(owner.localName?.toLowerCase())) return unknown();
    const box = owner.getBoundingClientRect();
    if (![box.left, box.top, box.right, box.bottom, view.innerWidth, view.innerHeight].every(Number.isFinite)
        || box.right <= box.left || box.bottom <= box.top || view.innerWidth <= 0 || view.innerHeight <= 0
        || box.left < 0 || box.top < 0 || box.right > view.innerWidth || box.bottom > view.innerHeight) return unknown();
    // getBoundingClientRect is relative to the layout viewport. Pinch zoom
    // can make the visible viewport smaller and offset within it.
    const visual = view.visualViewport;
    if (!visual || ![visual.offsetLeft, visual.offsetTop, visual.width, visual.height, visual.scale].every(Number.isFinite)
        || visual.width <= 0 || visual.height <= 0 || visual.scale <= 0
        || box.left < visual.offsetLeft || box.top < visual.offsetTop
        || box.right > visual.offsetLeft + visual.width || box.bottom > visual.offsetTop + visual.height) return unknown();
    const prop = (style, name) => style.getPropertyValue(name).trim().toLowerCase();
    const radiusNames = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'];
    const noRadius = (style) => radiusNames.every((name) => prop(style, name) === '0px');
    const visited = new Set();
    for (let element = owner; element;) {
      if (visited.has(element)) return unknown();
      visited.add(element);
      if (element.namespaceURI !== html || !element.isConnected || element.ownerDocument !== doc) return unknown();
      const style = view.getComputedStyle(element);
      const opacity = Number(style.opacity);
      // Several small ancestor opacities can combine to zero alpha after
      // rasterization. Only fully opaque ancestors give this proof.
      if (style.display === 'none' || style.visibility !== 'visible' || opacity !== 1
          || prop(style, 'mix-blend-mode') !== 'normal'
          || prop(style, 'transform') !== 'none' || !['none', ''].includes(prop(style, 'translate'))
          || !['none', ''].includes(prop(style, 'rotate')) || !['none', ''].includes(prop(style, 'scale'))
          || !['1', 'normal'].includes(prop(style, 'zoom')) || prop(style, 'filter') !== 'none'
          || prop(style, 'backdrop-filter') !== 'none' || prop(style, 'clip-path') !== 'none'
          || prop(style, 'clip') !== 'auto' || prop(style, 'mask-image') !== 'none'
          || prop(style, '-webkit-mask-box-image-source') !== 'none' || prop(style, 'perspective') !== 'none'
          || prop(style, 'contain') !== 'none' || prop(style, 'content-visibility') !== 'visible') return unknown();
      const x = prop(style, 'overflow-x'), y = prop(style, 'overflow-y');
      if (!['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(x)
          || !['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(y)) return unknown();
      // The owner clips its embedded document even when overflow is visible.
      if ((element === owner || x !== 'visible' || y !== 'visible') && !noRadius(style)) return unknown();
      if (element !== owner && (x !== 'visible' || y !== 'visible')) {
        const rect = element.getBoundingClientRect(), left = rect.left + element.clientLeft, top = rect.top + element.clientTop;
        const width = element.clientWidth, height = element.clientHeight;
        if (![left, top, width, height].every(Number.isFinite) || width < 0 || height < 0
            || x !== 'visible' && (box.left < left || box.right > left + width)
            || y !== 'visible' && (box.top < top || box.bottom > top + height)) return unknown();
      }
      const root = element.getRootNode();
      element = element.assignedSlot || element.parentElement || (root && root.host) || null;
    }
    return owner.isConnected && owner.ownerDocument === doc ? { status: 'visible' } : unknown();
  } catch { return unknown(); }
}`;
