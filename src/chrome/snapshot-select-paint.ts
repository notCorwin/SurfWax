/** Internal evaluator for a closed single-select label and its selected option. */
export const SNAPSHOT_SELECT_PAINT_EVALUATOR_SOURCE = `function(scene, requests, objects) {
  const {doc,view,rect,finite,inside,ordinaryFont,style,safe,range,viewport,visualRect,rgb,luminance}=scene;
  const values=requests.map((request,index)=>{
      try {
        const expected=request && request.expected, text=objects[index*2], option=objects[index*2+1];
        if(typeof expected!=='string' || expected.trim()!==expected || !/^[\\x20-\\x7e]+$/.test(expected)
          || !/[\\x21-\\x7e]/.test(expected) || !text || text.nodeType!==3 || !text.isConnected
          || text.ownerDocument!==doc || text.data!==expected || !option || option.localName!=='option' || !option.isConnected)return null;
        if(scene.painted.get(text)!==expected)return null;
        const root=text.getRootNode(),host=root && root.host,inner=text.parentElement;
        if(!host || !inner || root.nodeType!==11 || host.localName!=='select' || host.ownerDocument!==doc
          || host.getRootNode()!==doc || host.multiple || host.size>1 || host.matches(':open') || doc.activeElement===host
          || inner.parentNode!==root || inner.getAttribute('pseudo')!=='-internal-select-inner-element'
          || inner.childNodes.length!==1 || inner.firstChild!==text || host.selectedOptions.length!==1
          || host.selectedOptions[0]!==option || !option.selected || option.ownerDocument!==doc
          || typeof option.label!=='string' || option.label.trim()!==expected || !Number.isSafeInteger(option.index))return null;
        const hs=style(host), ins=style(inner), box=rect(host), clip=rect(inner);
        if(!finite(box) || !finite(clip) || !inside(box,viewport) || !inside(box,visualRect)
          || !safe(inner,ins) || !inside(clip,box) || inner.scrollLeft!==0 || inner.scrollTop!==0
          || host.scrollLeft!==0 || host.scrollTop!==0 || hs.appearance!=='auto'
          || hs.direction!=='ltr' || hs.writingMode!=='horizontal-tb' || hs.textTransform!=='none'
          || hs.webkitTextSecurity!=='none' || hs.backgroundClip==='text' || hs.webkitBackgroundClip==='text'
          || hs.backgroundImage!=='none' || !Number.isFinite(parseFloat(hs.fontSize)) || parseFloat(hs.fontSize)<=0
          || !hs.fontFamily.split(',').every(f=>['arial','monospace','sans-serif','serif','system-ui'].includes(f.trim().replace(/^['\"]|['\"]$/g,'').toLowerCase()))
          || !ordinaryFont(hs) || !ordinaryFont(ins)
          || ['fontFamily','fontSize','fontWeight','fontStyle','fontStretch','fontKerning'].some(k=>hs[k]!==ins[k])
          || hs.webkitTextFillColor!==ins.webkitTextFillColor || ins.textTransform!=='none' || ins.webkitTextSecurity!=='none')return null;
        const color=rgb(hs.webkitTextFillColor || hs.color),bg=rgb(hs.backgroundColor);
        if(!color || !bg)return null;
        const a=luminance(color),b=luminance(bg);
        if((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)<3)return null;
        for(let el=host;el;el=el.parentElement){
          const s=style(el);
          if(!safe(el,s) || el!==host && (s.overflowX!=='visible' || s.overflowY!=='visible'))return null;
        }
        range.selectNodeContents(text);const all=[...range.getClientRects()];if(all.length!==1)return null;
        const raw=all[0],textRect={x:raw.x,y:raw.y,width:raw.width,height:raw.height};
        const hostClip={x:box.x+host.clientLeft,y:box.y+host.clientTop,width:host.clientWidth,height:host.clientHeight};
        if(!finite(textRect) || !finite(hostClip) || !inside(textRect,clip) || !inside(textRect,hostClip))return null;
        // Inside the horizontal central strip of every rounded corner, text
        // cannot cross an elliptical corner even when it touches top/bottom.
        const radii=[hs.borderTopLeftRadius,hs.borderTopRightRadius,hs.borderBottomLeftRadius,hs.borderBottomRightRadius];
        if(radii.some(v=>!/^\\d+(?:\\.\\d+)?px(?: \\d+(?:\\.\\d+)?px)?$/.test(v)))return null;
        const corners=radii.map(v=>Math.max(...v.split(' ').map(Number.parseFloat)));
        if(textRect.x<box.x+Math.max(corners[0],corners[2]) || textRect.x+textRect.width>box.x+box.width-Math.max(corners[1],corners[3]))return null;
        if(host.selectedOptions.length!==1 || host.selectedOptions[0]!==option || option.label.trim()!==expected
          || text.data!==expected || !text.isConnected)return null;
        return {text:expected,box,clip,textRect,optionIndex:option.index,optionValue:option.value,optionLabel:option.label};
      }catch{return null;}
    });
  return values;
}`;
