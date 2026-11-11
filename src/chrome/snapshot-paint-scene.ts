/** Local select geometry guards; painted text comes from the shared synchronous index. */
export const SNAPSHOT_PAINT_SCENE_SOURCE = `function(doc, frameUnobscured, noAuthorShadowRoots, painted) {
  try {
    if (frameUnobscured !== true || noAuthorShadowRoots !== true || !(painted instanceof Map)) return null;
    const view=doc && doc.defaultView;
    if (!view || view.document !== doc || doc.fullscreenElement || doc.querySelector(':popover-open, dialog[open]')
      || typeof doc.getAnimations !== 'function' || doc.getAnimations().some(a => a.playState !== 'idle')
      || !doc.fonts || doc.fonts.status !== 'loaded' || doc.fonts.size !== 0) return null;
    const selection=view.getSelection();
    if (selection && !selection.isCollapsed || view.CSS && view.CSS.highlights && view.CSS.highlights.size) return null;
    const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const finite=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0;
    const inside=(a,b)=>a.x>=b.x && a.y>=b.y && a.x+a.width<=b.x+b.width && a.y+a.height<=b.y+b.height;
    const none=v=>!v || v==='none';
    const zero=v=>typeof v==='string' && v.trim().split(/\\s+/).every(part=>/^(?:0+(?:\\.0*)?|\\.0+)(?:px)?$/.test(part));
    const normalSpacing=v=>v==='normal' || zero(v);
    const ordinaryFont=s=>s.fontStyle==='normal' && (!s.fontFeatureSettings || s.fontFeatureSettings==='normal')
      && (!s.fontVariationSettings || s.fontVariationSettings==='normal') && normalSpacing(s.letterSpacing) && normalSpacing(s.wordSpacing);
    const styles=new Map(), style=el=>{if(!styles.has(el))styles.set(el,view.getComputedStyle(el));return styles.get(el);};
    const visible=s=>s.display!=='none' && !['hidden','collapse'].includes(s.visibility) && Number(s.opacity)!==0;
    const safe=(el,s)=>visible(s) && Number(s.opacity)===1 && none(s.transform) && none(s.perspective)
      && none(s.translate) && none(s.rotate) && none(s.scale)
      && none(s.filter) && none(s.backdropFilter) && none(s.clipPath) && (!s.clip || s.clip==='auto')
      && none(s.maskImage) && none(s.webkitMaskImage) && none(s.webkitMaskBoxImageSource) && none(s.maskBorderSource)
      && (!s.contain || s.contain==='none') && s.borderImageSource==='none' && zero(s.borderImageOutset)
      && (!s.mixBlendMode || s.mixBlendMode==='normal') && (!s.animationName || s.animationName==='none')
      && (s.transitionDuration || '0s').split(',').every(v=>parseFloat(v)===0)
      && (!s.zoom || s.zoom==='1' || s.zoom==='normal') && none(s.boxShadow) && none(s.textShadow)
      && (!s.contentVisibility || s.contentVisibility==='visible')
      && (!s.textDecorationLine || s.textDecorationLine==='none') && (!s.textEmphasisStyle || s.textEmphasisStyle==='none')
      && (!s.webkitTextStrokeWidth || zero(s.webkitTextStrokeWidth))
      && (!s.outlineStyle || s.outlineStyle==='none')
      && (!s.display.includes('list-item') || s.listStyleType==='none' && s.listStyleImage==='none' && view.getComputedStyle(el,'::marker').content==='normal')
      && !el.shadowRoot && !el.localName.includes('-') && !el.hasAttribute('is')
      && el.namespaceURI==='http://www.w3.org/1999/xhtml'
      && ['::before','::after'].every(p=>{const content=view.getComputedStyle(el,p).content;return content==='none' || content==='normal';});
    const range=doc.createRange();
    const visual=view.visualViewport;
    if(!visual || ![visual.offsetLeft,visual.offsetTop,visual.width,visual.height,visual.scale].every(Number.isFinite)
      || visual.width<=0 || visual.height<=0 || visual.scale<=0)return null;
    const viewport={x:0,y:0,width:view.innerWidth,height:view.innerHeight};
    const visualRect={x:visual.offsetLeft,y:visual.offsetTop,width:visual.width,height:visual.height};
    const rgb=value=>{const m=/^rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)$/.exec(value);return m?m.slice(1).map(Number):null;};
    const luminance=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    return {doc,view,rect,finite,inside,ordinaryFont,style,safe,range,viewport,visualRect,rgb,luminance,painted};
  } catch { return null; }
}`;
