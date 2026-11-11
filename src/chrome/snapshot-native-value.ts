/** Prove a complete native value against text accepted in this synchronous paint read. */
export const SNAPSHOT_NATIVE_VALUE_EVALUATOR_SOURCE = `function(doc, requests, texts, painted) {
  const view=doc.defaultView, style=el=>view.getComputedStyle(el);
  const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const finite=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0;
  const inside=(a,b)=>a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;
  const range=doc.createRange(), viewport={x:0,y:0,width:view.innerWidth,height:view.innerHeight};
  const visual=view.visualViewport, visualRect=visual&&{x:visual.offsetLeft,y:visual.offsetTop,width:visual.width,height:visual.height};
  const ordinaryFont=s=>s.fontStyle==='normal'&&s.fontFeatureSettings==='normal'
    &&s.fontVariationSettings==='normal'&&['normal','0px'].includes(s.letterSpacing)&&['normal','0px'].includes(s.wordSpacing);
  if(doc.fonts.size!==0 || doc.getAnimations().some(a=>a.playState!=='idle'))return requests.map(()=>null);
  const values=requests.map((request,index)=>{
      try {
        const expected=request && request.expected, text=texts[index];
        if(typeof expected!=='string' || expected.trim()!==expected || !text || text.nodeType!==3 || !text.isConnected
          || text.ownerDocument!==doc)return null;
        const root=text.getRootNode(),host=root && root.host,inner=text.parentElement;
        if(!host || !inner || root.nodeType!==11 || !['input','textarea'].includes(host.localName) || host.value!==expected
          || host.localName==='input' && !['text','search','email','tel','url'].includes(host.type) || host.ownerDocument!==doc
          || host.getRootNode()!==doc || inner.getRootNode()!==root)return null;
        const multiline=host.localName==='textarea', lines=expected.split(String.fromCharCode(10));
        if(!expected.trim() || !/^[\\x20-\\x7e\\n\\u00a0-\\u024f\\p{Unified_Ideograph}\\u3001-\\u303f]+$/u.test(expected)
          || /[\\p{Default_Ignorable_Code_Point}\\p{Mark}\\p{Bidi_Control}]/u.test(expected)
          || host.selectionStart!==host.selectionEnd)return null;
        const children=[...inner.childNodes];
        if(!multiline && (lines.length!==1 || children.length!==1 || inner.firstChild!==text || text.data!==expected))return null;
        if(multiline && (children.some(child=>child.nodeType!==3 && !(child.nodeType===1 && child.localName==='br' && !child.attributes.length))
          || children.map(child=>child.nodeType===3 ? child.data : String.fromCharCode(10)).join('')!==expected))return null;
        const hs=style(host), ins=style(inner), box=rect(host), clip=rect(inner);
        if(!finite(box) || !finite(clip) || !inside(box,viewport) || (!visualRect || !inside(box,visualRect))
          || !inside(clip,box) || inner.scrollLeft!==0 || inner.scrollTop!==0
          || host.scrollLeft!==0 || host.scrollTop!==0 || multiline && (host.scrollWidth>host.clientWidth || host.scrollHeight>host.clientHeight)
          || hs.direction!=='ltr' || hs.writingMode!=='horizontal-tb' || hs.textTransform!=='none'
          || hs.webkitTextSecurity!=='none' || hs.backgroundClip==='text' || hs.webkitBackgroundClip==='text'
          || hs.backgroundImage!=='none' || !Number.isFinite(parseFloat(hs.fontSize)) || parseFloat(hs.fontSize)<=0
          || !hs.fontFamily.split(',').every(f=>['arial','monospace','sans-serif','serif','system-ui'].includes(f.trim().replace(/^['"]|['"]$/g,'').toLowerCase()))
          || !ordinaryFont(hs) || !ordinaryFont(ins)
          || hs.font!==ins.font || hs.webkitTextFillColor!==ins.webkitTextFillColor
          || ins.textTransform!=='none' || ins.webkitTextSecurity!=='none'
          || multiline && !['pre','pre-wrap','break-spaces'].includes(ins.whiteSpace))return null;
        for(let el=host;el;el=el.parentElement)if(Number(style(el).opacity)!==1)return null;
        const hostClip={x:box.x+host.clientLeft,y:box.y+host.clientTop,width:host.clientWidth,height:host.clientHeight};
        if(!finite(hostClip))return null;
        const segments=[];
        for(const child of children){
          if(child.nodeType===3){if(painted.get(child)!==child.data)return null;range.selectNodeContents(child);}else range.selectNode(child);
          const boxes=[...range.getClientRects()].map(raw=>({x:raw.x,y:raw.y,width:raw.width,height:raw.height}));
          if(!boxes.length || !multiline && boxes.length!==1 || boxes.some(r=>
            ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.height<=0 || r.width<0
            || child.nodeType===3 && r.width===0 || !inside(r,clip) || !inside(r,hostClip)))return null;
          segments.push({kind:child.nodeType===3?'text':'break',value:child.nodeType===3?child.data:'',boxes});
        }
        const textRect=segments[0].boxes[0];
        if(host.value!==expected || !text.isConnected || children.some(child=>child.parentNode!==inner)
          || multiline && [...inner.childNodes].some((child,index)=>child!==children[index]))return null;
        return {text:expected,box,clip,textRect,scrollLeft:inner.scrollLeft,...(multiline?{segments,hostScrollLeft:host.scrollLeft,hostScrollTop:host.scrollTop}: {})};
      }catch{return null;}
    });
  return values;
}`;
