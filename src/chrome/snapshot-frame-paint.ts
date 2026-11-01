/**
 * Runs on an iframe/frame owner in its parent document, in an isolated world.
 * Returns a repeatable, conservative proof that the entire owner is painted
 * inside the parent viewport without clipping or competing paint. Callers
 * must validate the frame owner identity and document generation with CDP,
 * repeat the same proof after capture, and do this at every ancestor frame.
 * The `noShadowRoots` argument must come from the captured parent DOMSnapshot,
 * including closed roots. A null result is inconclusive, not proof the owner is hidden.
 */
export const SNAPSHOT_FRAME_PAINT_SOURCE = `function(noShadowRoots) {
  try {
    if (noShadowRoots !== true) return null;
    const owner = this, doc = owner && owner.ownerDocument, view = doc && doc.defaultView;
    if (!view || view.document !== doc || !owner.isConnected || owner.getRootNode() !== doc
      || !['iframe','frame'].includes(owner.localName) || owner.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
    if (doc.fullscreenElement || doc.querySelector(':popover-open, dialog[open]')
      || typeof doc.getAnimations !== 'function' || doc.getAnimations().some(animation => animation.playState !== 'idle')
      || !doc.fonts || doc.fonts.status !== 'loaded') return null;
    const selection = view.getSelection();
    if (selection && !selection.isCollapsed || view.CSS && view.CSS.highlights && view.CSS.highlights.size) return null;
    const finite = r => [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
    const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    const inside = (a,b) => a.x >= b.x && a.y >= b.y && a.x+a.width <= b.x+b.width && a.y+a.height <= b.y+b.height;
    const overlaps = (a,b) => a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
    const none = v => !v || v === 'none';
    const zero = v => typeof v === 'string' && v.trim().split(/\\s+/).every(part => /^(?:0+(?:\\.0*)?|\\.0+)(?:px)?$/.test(part));
    const styles = new Map(), style = el => { if (!styles.has(el)) styles.set(el,view.getComputedStyle(el)); return styles.get(el); };
    const visible = s => s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0;
    const safe = (el,s) => visible(s) && Number(s.opacity) === 1 && none(s.transform) && none(s.perspective)
      && none(s.filter) && none(s.backdropFilter) && none(s.clipPath) && (!s.clip || s.clip === 'auto')
      && none(s.maskImage) && none(s.webkitMaskImage) && none(s.webkitMaskBoxImageSource) && none(s.maskBorderSource)
      && (!s.contain || s.contain === 'none') && s.borderImageSource === 'none' && zero(s.borderImageOutset)
      && (!s.mixBlendMode || s.mixBlendMode === 'normal') && (!s.animationName || s.animationName === 'none')
      && (s.transitionDuration || '0s').split(',').every(v => parseFloat(v) === 0)
      && (!s.zoom || s.zoom === '1' || s.zoom === 'normal') && none(s.boxShadow) && none(s.textShadow)
      && (!s.contentVisibility || s.contentVisibility === 'visible')
      && (!s.textDecorationLine || s.textDecorationLine === 'none') && (!s.textEmphasisStyle || s.textEmphasisStyle === 'none')
      && (!s.webkitTextStrokeWidth || zero(s.webkitTextStrokeWidth))
      && (!s.outlineStyle || s.outlineStyle === 'none') && !s.display.includes('list-item')
      && !el.shadowRoot && !el.localName.includes('-') && !el.hasAttribute('is')
      && el.namespaceURI === 'http://www.w3.org/1999/xhtml'
      && ['::before','::after'].every(p => { const content = view.getComputedStyle(el,p).content; return content === 'none' || content === 'normal'; });
    const target = rect(owner), viewport = {x:0,y:0,width:view.innerWidth,height:view.innerHeight};
    if (!finite(target) || !finite(viewport) || !inside(target,viewport)) return null;
    const ancestors = new Set();
    for (let el=owner; el; el=el.parentElement) {
      ancestors.add(el);
      const s = style(el), r = rect(el);
      if (!safe(el,s)) return null;
      // Rounded clips, ancestor scrolling, transforms, and clipping are not
      // mapped: unknown is safer than assuming the whole child is visible.
      if (el !== owner && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) return null;
      if (el === owner && [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius].some(value => !zero(value))) return null;
      if (![r.x,r.y,r.width,r.height].every(Number.isFinite)) return null;
    }
    const fingerprint = [];
    for (const el of doc.querySelectorAll('*')) {
      const s = style(el);
      if (!visible(s)) continue;
      if (!safe(el,s)) return null;
      const r = rect(el);
      if (!ancestors.has(el) && finite(r) && overlaps(r,target)) return null;
      fingerprint.push([el.localName,r.x,r.y,r.width,r.height,s.display,s.visibility,s.opacity,s.overflowX,s.overflowY]);
    }
    // Unclipped text can have ink outside its layout box, including when a
    // different fallback font is used. Accept only when an explicit ancestor
    // overflow clip confines it to a rectangle disjoint from the iframe.
    const walker = doc.createTreeWalker(doc, 4), range = doc.createRange();
    let node;
    while ((node = walker.nextNode())) {
      if (!node.data.trim() || !node.parentElement) continue;
      range.selectNodeContents(node);
      if (![...range.getClientRects()].length) continue;
      let confined = false;
      for (let el=node.parentElement; el && !ancestors.has(el); el=el.parentElement) {
        const s=style(el), r=rect(el);
        if (['hidden','clip'].includes(s.overflowX) && ['hidden','clip'].includes(s.overflowY)
          && (!s.overflowClipMargin || zero(s.overflowClipMargin)) && finite(r) && !overlaps(r,target)) { confined = true; break; }
      }
      if (!confined) return null;
    }
    return {target,viewport,fingerprint};
  } catch { return null; }
}`;
