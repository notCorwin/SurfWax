/** Synchronous frame-local scene shared by all control-value proofs in one capture. */
export const SNAPSHOT_PAINT_SCENE_SOURCE = `function(doc, frameUnobscured, noAuthorShadowRoots) {
  try {
    if (frameUnobscured !== true || noAuthorShadowRoots !== true) return null;
    const view=doc && doc.defaultView;
    if (!view || view.document !== doc || doc.fullscreenElement || doc.querySelector(':popover-open, dialog[open]')
      || typeof doc.getAnimations !== 'function' || doc.getAnimations().some(a => a.playState !== 'idle')
      || !doc.fonts || doc.fonts.status !== 'loaded' || doc.fonts.size !== 0) return null;
    const selection=view.getSelection();
    if (selection && !selection.isCollapsed || view.CSS && view.CSS.highlights && view.CSS.highlights.size) return null;
    const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const finite=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0;
    const inside=(a,b)=>a.x>=b.x && a.y>=b.y && a.x+a.width<=b.x+b.width && a.y+a.height<=b.y+b.height;
    const overlaps=(a,b)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
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
    // Spatial indexing shares the entire document walk and computed styles
    // across candidates; large rectangles are kept in a separate bounded list.
    const cells=new Map(), large=[], size=128;
    const add=(owner,r,isText)=>{
      if (!finite(r)) return;
      const entry={owner,rect:r,isText}, x1=Math.floor(r.x/size), y1=Math.floor(r.y/size),
        x2=Math.floor((r.x+r.width)/size), y2=Math.floor((r.y+r.height)/size);
      if ((x2-x1+1)*(y2-y1+1)>64) { large.push(entry); return; }
      for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++){
        const key=x+','+y, cell=cells.get(key)||[];cell.push(entry);cells.set(key,cell);
      }
    };
    const fingerprint=[];
    for (const el of doc.querySelectorAll('*')) {
      const s=style(el); if(!visible(s)) continue;
      if(!safe(el,s)) return null;
      const r=rect(el); if(finite(r))add(el,r,false);
      fingerprint.push([el.localName,r.x,r.y,r.width,r.height,s.display,s.visibility,s.opacity,s.overflowX,s.overflowY]);
    }
    // Unclipped text has no reliable ink bounds when fallback fonts differ.
    // Record explicit clip boxes once; they are checked against every target.
    const range=doc.createRange(), walker=doc.createTreeWalker(doc,4);
    let other;
    while((other=walker.nextNode())) {
      if(!other.data.trim() || !other.parentElement)continue;
      range.selectNodeContents(other); if(![...range.getClientRects()].length)continue;
      let confined=false;
      for(let el=other.parentElement;el;el=el.parentElement){
        const s=style(el),r=rect(el);
        if(['hidden','clip'].includes(s.overflowX) && ['hidden','clip'].includes(s.overflowY)
          && (!s.overflowClipMargin || zero(s.overflowClipMargin)) && finite(r)){
          add(other,r,true);fingerprint.push(['text-clip',r.x,r.y,r.width,r.height]);confined=true;break;
        }
      }
      if(!confined)return null;
    }
    const visual=view.visualViewport;
    if(!visual || ![visual.offsetLeft,visual.offsetTop,visual.width,visual.height,visual.scale].every(Number.isFinite)
      || visual.width<=0 || visual.height<=0 || visual.scale<=0)return null;
    const viewport={x:0,y:0,width:view.innerWidth,height:view.innerHeight};
    const visualRect={x:visual.offsetLeft,y:visual.offsetTop,width:visual.width,height:visual.height};
    const rgb=value=>{const m=/^rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)$/.exec(value);return m?m.slice(1).map(Number):null;};
    const luminance=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    return {doc,view,rect,finite,inside,overlaps,none,zero,ordinaryFont,style,visible,safe,cells,large,size,range,viewport,visualRect,rgb,luminance,fingerprint};
  } catch { return null; }
}`;
