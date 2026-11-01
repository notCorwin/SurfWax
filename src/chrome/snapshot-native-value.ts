import { SNAPSHOT_PAINT_SCENE_SOURCE } from "./snapshot-paint-scene";

/** Internal per-candidate evaluator; the scene is shared within one synchronous frame read. */
export const SNAPSHOT_NATIVE_VALUE_EVALUATOR_SOURCE = `function(scene, requests, texts) {
  const {doc,view,rect,finite,inside,overlaps,none,zero,ordinaryFont,style,visible,safe,cells,large,size,range,viewport,visualRect,rgb,luminance}=scene;
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
        const hostClip={x:box.x+host.clientLeft,y:box.y+host.clientTop,width:host.clientWidth,height:host.clientHeight};
        if(!finite(hostClip))return null;
        const segments=[];
        for(const child of children){
          if(child.nodeType===3)range.selectNodeContents(child);else range.selectNode(child);
          const boxes=[...range.getClientRects()].map(raw=>({x:raw.x,y:raw.y,width:raw.width,height:raw.height}));
          if(!boxes.length || !multiline && boxes.length!==1 || boxes.some(r=>
            ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.height<=0 || r.width<0
            || child.nodeType===3 && r.width===0 || !inside(r,clip) || !inside(r,hostClip)))return null;
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
  return values;
}`;

/** Standalone entry for input/textarea proof with independent before/after reads. */
export const SNAPSHOT_NATIVE_VALUE_SOURCE = `function(requests, frameUnobscured, noAuthorShadowRoots, ...texts) {
  if (!Array.isArray(requests)) return null;
  const failures = () => ({scene:null, values:requests.map(() => null)});
  if (texts.length !== requests.length) return failures();
  const scene = (${SNAPSHOT_PAINT_SCENE_SOURCE})(this, frameUnobscured, noAuthorShadowRoots);
  if (!scene) return failures();
  return {scene:scene.fingerprint, values:(${SNAPSHOT_NATIVE_VALUE_EVALUATOR_SOURCE})(scene, requests, texts)};
}`;
