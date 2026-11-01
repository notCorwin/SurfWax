/**
 * Measure native input and textarea values in a single isolated-world call per frame.
 * Called with the frame document as `this`, arguments (requests,
 * frameUnobscured, noAuthorShadowRoots, ...texts). Each request contains an
 * expected value and corresponds to one UA-shadow text object argument.
 * The caller must independently prove each text node's CDP user-agent
 * shadow ancestry and host backend identity, and repeat the whole measurement
 * and DOMSnapshot before publication. A null entry means inconclusive.
 *
 * Range uses Blink's actual layout; it is not a proof of exact glyph ink.
 * This deliberately refuses partial values, effects and uncertain occlusion.
 */
export const SNAPSHOT_NATIVE_VALUE_SOURCE = `function(requests, frameUnobscured, noAuthorShadowRoots, ...texts) {
  if (!Array.isArray(requests)) return null;
  const failures = () => ({scene:null, values:requests.map(() => null)});
  try {
    if (frameUnobscured !== true || noAuthorShadowRoots !== true || texts.length !== requests.length) return failures();
    const doc=this, view=doc && doc.defaultView;
    if (!view || view.document !== doc || doc.fullscreenElement || doc.querySelector(':popover-open, dialog[open]')
      || typeof doc.getAnimations !== 'function' || doc.getAnimations().some(a => a.playState !== 'idle')
      || !doc.fonts || doc.fonts.status !== 'loaded' || doc.fonts.size !== 0) return failures();
    const selection=view.getSelection();
    if (selection && !selection.isCollapsed || view.CSS && view.CSS.highlights && view.CSS.highlights.size) return failures();
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
      if(!safe(el,s)) return failures();
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
      if(!confined)return failures();
    }
    const visual=view.visualViewport;
    if(!visual || ![visual.offsetLeft,visual.offsetTop,visual.width,visual.height,visual.scale].every(Number.isFinite)
      || visual.width<=0 || visual.height<=0 || visual.scale<=0)return failures();
    const viewport={x:0,y:0,width:view.innerWidth,height:view.innerHeight};
    const visualRect={x:visual.offsetLeft,y:visual.offsetTop,width:visual.width,height:visual.height};
    const rgb=value=>{const m=/^rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)$/.exec(value);return m?m.slice(1).map(Number):null;};
    const luminance=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    const values=requests.map((request,index)=>{
      try {
        const expected=request && request.expected, text=texts[index];
        if(typeof expected!=='string' || expected.trim()!==expected || !text || text.nodeType!==3 || !text.isConnected
          || text.ownerDocument!==doc)return null;
        const root=text.getRootNode(),host=root && root.host,inner=text.parentElement;
        if(!host || !inner || root.nodeType!==11 || !['input','textarea'].includes(host.localName) || host.value!==expected
          || host.localName==='input' && !['text','search','email','tel','url'].includes(host.type) || host.ownerDocument!==doc
          || host.getRootNode()!==doc || inner.parentNode!==root || doc.activeElement===host)return null;
        const multiline=host.localName==='textarea', lines=expected.split(String.fromCharCode(10));
        if(!lines.length || lines.some(line=>line && (line.trim()!==line || !/^[\\x20-\\x7e]+$/.test(line)))
          || !lines.some(line=>/[\\x21-\\x7e]/.test(line)))return null;
        const children=[...inner.childNodes];
        if(!multiline && (lines.length!==1 || children.length!==1 || inner.firstChild!==text || text.data!==expected))return null;
        if(multiline && (children.some(child=>child.nodeType!==3 && !(child.nodeType===1 && child.localName==='br' && !child.attributes.length))
          || children.map(child=>child.nodeType===3 ? child.data : String.fromCharCode(10)).join('')!==expected))return null;
        const hs=style(host), ins=style(inner), box=rect(host), clip=rect(inner);
        if(!finite(box) || !finite(clip) || !inside(box,viewport) || !inside(box,visualRect)
          || !safe(inner,ins) || !inside(clip,box) || inner.scrollLeft!==0 || inner.scrollTop!==0
          || host.scrollLeft!==0 || host.scrollTop!==0 || multiline && (host.scrollWidth>host.clientWidth || host.scrollHeight>host.clientHeight)
          || hs.direction!=='ltr' || hs.writingMode!=='horizontal-tb' || hs.textTransform!=='none'
          || hs.webkitTextSecurity!=='none' || hs.backgroundClip==='text' || hs.webkitBackgroundClip==='text'
          || hs.backgroundImage!=='none' || !Number.isFinite(parseFloat(hs.fontSize)) || parseFloat(hs.fontSize)<=0
          || !hs.fontFamily.split(',').every(f=>['arial','monospace','sans-serif','serif','system-ui'].includes(f.trim().replace(/^['"]|['"]$/g,'').toLowerCase()))
          || !ordinaryFont(hs) || !ordinaryFont(ins)
          || hs.font!==ins.font || hs.webkitTextFillColor!==ins.webkitTextFillColor
          || ins.textTransform!=='none' || ins.webkitTextSecurity!=='none'
          || multiline && !['pre','pre-wrap','break-spaces'].includes(ins.whiteSpace))return null;
        const color=rgb(hs.webkitTextFillColor || hs.color),bg=rgb(hs.backgroundColor);
        if(!color || !bg)return null;
        const a=luminance(color),b=luminance(bg);
        if((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)<3)return null;
        const ancestors=new Set();
        for(let el=host;el;el=el.parentElement){
          ancestors.add(el);const s=style(el);
          if(!safe(el,s) || el!==host && (s.overflowX!=='visible' || s.overflowY!=='visible'))return null;
          if(el===host && [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius].some(v=>!zero(v)))return null;
        }
        const segments=[];
        for(const child of children){
          if(child.nodeType===3)range.selectNodeContents(child);else range.selectNode(child);
          const boxes=[...range.getClientRects()].map(raw=>({x:raw.x,y:raw.y,width:raw.width,height:raw.height}));
          if(!boxes.length || !multiline && boxes.length!==1 || boxes.some(r=>
            ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.height<=0 || r.width<0
            || child.nodeType===3 && r.width===0 || !inside(r,clip)))return null;
          segments.push({kind:child.nodeType===3?'text':'break',value:child.nodeType===3?child.data:'',boxes});
        }
        const textRect=segments[0].boxes[0];
        const possible=new Set(large);
        for(let x=Math.floor(box.x/size);x<=Math.floor((box.x+box.width)/size);x++)
          for(let y=Math.floor(box.y/size);y<=Math.floor((box.y+box.height)/size);y++)
            for(const item of cells.get(x+','+y)||[])possible.add(item);
        for(const item of possible)if((item.isText || !ancestors.has(item.owner)) && overlaps(item.rect,box))return null;
        if(host.value!==expected || !text.isConnected || children.some(child=>child.parentNode!==inner)
          || multiline && [...inner.childNodes].some((child,index)=>child!==children[index]))return null;
        return {text:expected,box,clip,textRect,scrollLeft:inner.scrollLeft,...(multiline?{segments,hostScrollLeft:host.scrollLeft,hostScrollTop:host.scrollTop}: {})};
      }catch{return null;}
    });
    return {scene:fingerprint, values};
  }catch{return failures();}
}`;
