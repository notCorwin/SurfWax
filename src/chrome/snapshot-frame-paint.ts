import { sampleReadableSnapshot } from "./snapshot-readable-source.js";
import { snapshotObservationPrimitives } from "./snapshot-observation-primitives.js";

/** Structural action visibility is independent of text/font paint eligibility.
 * Native pointer hit-testing still proves an actual input point separately. */
export const FRAME_OWNER_VISIBILITY_SOURCE = `function(){
  if(!this.isConnected || !this.checkVisibility({opacityProperty:true,visibilityProperty:true}))return false;
  const own=this.getBoundingClientRect();
  let nonTranslation=false,hasOverflowClip=false;
  for(let element=this;element;element=element.parentElement){
    const style=getComputedStyle(element),matrix=/^matrix\\(([^()]*)\\)$/.exec(style.transform),values=matrix?.[1].split(',').map(Number);
    nonTranslation ||= style.transform!=='none' && !(values?.length===6 && values.every(Number.isFinite) && values[0]===1 && values[1]===0 && values[2]===0 && values[3]===1)
      || !['none','1','1 1'].includes(style.scale) || !['none','0deg'].includes(style.rotate)
      || style.perspective!=='none' || !['1','normal'].includes(style.zoom);
    if(style.clip!=='auto' || style.clipPath!=='none' || style.maskImage!=='none'
      || !['','none'].includes(style.getPropertyValue('-webkit-mask-box-image-source'))
      || style.filter!=='none' || style.backdropFilter!=='none')return false;
    if(element!==this && element!==document.documentElement && element!==document.body
      && ['hidden','clip','scroll','auto'].some(value=>style.overflowX===value || style.overflowY===value)){
      hasOverflowClip=true;
      const r=element.getBoundingClientRect(),left=r.left+element.clientLeft,top=r.top+element.clientTop;
      if(style.overflowX!=='visible' && (own.left<left || own.right>left+element.clientWidth)
        || style.overflowY!=='visible' && (own.top<top || own.bottom>top+element.clientHeight))return false;
    }
  }
  return !(nonTranslation && hasOverflowClip);
}`;

/** Rendered text may be outside the viewport. Reuse the same synchronous
 * clipping and competing-paint engine without snapshot viewport containment.
 * No evidence or reader survives this call; the caller guards each parent. */
export const RENDERED_FRAME_PAINT_SOURCE = `function(nativeProofSupplied,...roots){
  if(document.readyState!=="complete" || document.fonts.status!=="loaded")return false;
  if(typeof globalThis.chrome?.dom?.openOrClosedShadowRoot!=="function" && nativeProofSupplied!==true)return "native-shadow-roots-required";
  (${snapshotObservationPrimitives.toString()})(true);
  let painted=false;
  (${sampleReadableSnapshot.toString()})(NaN,roots,nativeProofSupplied===true?{shadowRoots:roots}:undefined,{frameOwner:this,acceptFrame:value=>painted=value});
  return painted;
}`;

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
