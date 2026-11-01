/**
 * Measures AX ellipsis candidates in one call per frame. The caller must also
 * establish frame ownership and visibility, reject unproven text paint, and
 * compare a second measurement before using a proof. In particular this
 * same-document measurement cannot establish occlusion in an ancestor frame.
 *
 * Called with the frame Document as `this` and arguments `(token, requests)`;
 * each request is `{ backendNodeId, prefix, sourceText, frameUnobscured, noShadowRoots, basePainted }`.
 * These booleans require independently verified frame and text-paint evidence; unknown is false. Results align with
 * requests, and null means no proof. Rectangles are viewport CSS pixels.
 */
export const AX_ELLIPSIS_GEOMETRY_SOURCE = `function(token, requests) {
  if (!Array.isArray(requests)) return [];
  const failures = () => requests.map(() => null);
  if (!this.defaultView || this.defaultView.document !== this) return failures();
  const cache = globalThis[Symbol.for('surf-wax.text-paint-cache.v1')];
  if (!cache || cache.token !== token || !(cache.nodes instanceof Map)) return failures();
  const doc = this, view = doc.defaultView;
  // Top-layer backdrops and scripted/view-transition animations can paint
  // outside every ordinary element box, including with pointer-events:none.
  try {
    if (doc.fullscreenElement || doc.querySelector(':popover-open, dialog[open]')
      || typeof doc.getAnimations !== 'function' || doc.getAnimations().some(animation => animation.playState !== 'idle')) return failures();
  } catch { return failures(); }
  const selected = view.getSelection();
  if (selected && !selected.isCollapsed) return failures();
  if (view.CSS && view.CSS.highlights && view.CSS.highlights.size) return failures();
  if (!doc.fonts || doc.fonts.status !== 'loaded') return failures();
  const canvas = doc.createElement('canvas'), context = canvas.getContext('2d');
  if (!context) return failures();
  const asRect = r => ({x:r.x, y:r.y, width:r.width, height:r.height});
  const finiteRect = r => [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  const number = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };
  const zero = s => s === 'normal' || s === '0px' || s === '0';
  const noEffect = s => !s || s === 'none';
  const zeroOutset = value => typeof value === 'string' && value.trim().split(/\\s+/).every(part => /^(?:0+(?:\\.0*)?|\\.0+)(?:px)?$/.test(part));
  const styles = new Map();
  const style = el => { if (!styles.has(el)) styles.set(el, view.getComputedStyle(el)); return styles.get(el); };
  const safeCommon = s => s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) === 1
    && noEffect(s.transform) && noEffect(s.perspective) && noEffect(s.filter) && noEffect(s.backdropFilter)
    && noEffect(s.clipPath) && (s.clip === 'auto' || !s.clip) && noEffect(s.maskImage) && noEffect(s.webkitMaskImage)
    && s.borderImageSource === 'none' && zeroOutset(s.borderImageOutset)
    && (s.mixBlendMode === 'normal' || !s.mixBlendMode) && (s.animationName === 'none' || !s.animationName)
    && (s.transitionDuration || '0s').split(',').every(v => parseFloat(v) === 0);
  const pseudoSafe = el => ['::before','::after'].every(p => {
    const s = view.getComputedStyle(el, p); return s.content === 'none' || s.content === 'normal';
  });
  // list-style:none alone is insufficient: an authored ::marker content
  // still paints outside the list item's box. Only admit an absent default
  // marker, and fail closed if computed pseudo-element evidence is missing.
  const markerSafe = (el, s) => !s.display.includes('list-item') ||
    (s.listStyleType === 'none' && s.listStyleImage === 'none' && view.getComputedStyle(el, '::marker').content === 'normal');
  const elements = [...doc.querySelectorAll('*')];
  const scene = new Map();
  const visual = el => {
    if (scene.has(el)) return scene.get(el);
    const s = style(el), rect = asRect(el.getBoundingClientRect());
    const hidden = s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0;
    const unsafe = !hidden && (!safeCommon(s) || !pseudoSafe(el) || !noEffect(s.boxShadow)
      || !noEffect(s.textShadow) || (s.outlineStyle && s.outlineStyle !== 'none')
      || !markerSafe(el, s)
      || !zero(s.webkitTextStrokeWidth) || (s.textDecorationLine && s.textDecorationLine !== 'none')
      || el.shadowRoot || el.localName.includes('-') || el.hasAttribute('is') || el.namespaceURI !== 'http://www.w3.org/1999/xhtml');
    const value = {hidden,unsafe,rect}; scene.set(el,value); return value;
  };
  let index;
  const sceneIndex = () => {
    if (index) return index;
    const cells = new Map(), large = [], size = 128;
    let unsafe = false;
    const add = (owner, r, isText) => {
      if (!(r.width > 0 && r.height > 0)) return;
      const entry = {owner, rect:r, isText};
      const x1 = Math.floor(r.x / size), y1 = Math.floor(r.y / size);
      const x2 = Math.floor((r.x + r.width) / size), y2 = Math.floor((r.y + r.height) / size);
      if ((x2-x1+1)*(y2-y1+1) > 64) { large.push(entry); return; }
      for (let x=x1; x<=x2; x++) for (let y=y1; y<=y2; y++) {
        const key = x + ',' + y, cell = cells.get(key) || [];
        cell.push(entry); cells.set(key, cell);
      }
    };
    for (const el of elements) {
      const item = visual(el);
      if (item.hidden) continue;
      if (item.unsafe) { unsafe = true; break; }
      add(el, item.rect, false);
    }
    // Element boxes alone omit text overflowing a visible box. Collect each
    // live text node once, in this same frame batch, including conservative ink
    // overhang. Refuse unusual text effects instead of guessing their extent.
    if (!unsafe) {
      const walker = doc.createTreeWalker(doc, 4), range = doc.createRange();
      let node;
      while ((node = walker.nextNode())) {
        if (!node.data.trim() || !node.parentElement || visual(node.parentElement).hidden) continue;
        const s = style(node.parentElement), fontSize = number(s.fontSize);
        // For a block container whose overflow is clipped, its indexed border
        // box already bounds all its own text, regardless of glyph overhang.
        if (['block','inline-block','flow-root','flex','inline-flex','grid','inline-grid'].includes(s.display)
          && ['hidden','clip'].includes(s.overflowX) && ['hidden','clip'].includes(s.overflowY)) continue;
        if (!Number.isFinite(fontSize) || fontSize <= 0 || !s.font || !doc.fonts.check(s.font)
          || s.direction !== 'ltr' || s.writingMode !== 'horizontal-tb' || s.textTransform !== 'none'
          || !zero(s.letterSpacing) || !zero(s.wordSpacing) || (s.fontFeatureSettings && s.fontFeatureSettings !== 'normal')
          || (s.fontVariationSettings && s.fontVariationSettings !== 'normal') || /[\\r\\n]/.test(node.data)) { unsafe = true; break; }
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        if (rects.length < 1 || rects.length > 2) { unsafe = true; break; }
        context.font = s.font;
        if (context.fontKerning !== undefined) context.fontKerning = s.fontKerning;
        const metrics = context.measureText(node.data), full = asRect(rects[0]);
        const ink = [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight,
          metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent];
        if (!ink.every(Number.isFinite) || Math.abs(metrics.width - full.width) > 1) { unsafe = true; break; }
        // Canvas ink extents are measured in the same font. Bound both sides
        // generously, including placement uncertainty within the line box.
        const margin = fontSize * 2 + Math.abs(ink[1]) + Math.max(0, ink[2] - ink[0]) + Math.abs(ink[3]) + Math.abs(ink[4]);
        for (const raw of rects) {
          const r = asRect(raw);
          if (![r.x,r.y,r.width,r.height].every(Number.isFinite)) { unsafe = true; break; }
          if (r.width > 0 && r.height > 0) add(node, {x:r.x-margin,y:r.y-margin,width:r.width+2*margin,height:r.height+2*margin}, true);
        }
        if (unsafe) break;
      }
    }
    return index = {cells, large, unsafe, size};
  };
  return requests.map(request => {
    try {
      if (!request || request.frameUnobscured !== true || request.noShadowRoots !== true || request.basePainted !== true
        || !Number.isSafeInteger(request.backendNodeId) || typeof request.prefix !== 'string'
        || !request.prefix || typeof request.sourceText !== 'string' || !request.sourceText.startsWith(request.prefix)
        || request.prefix.length >= request.sourceText.length) return null;
      const ref = cache.nodes.get(request.backendNodeId), text = ref && ref.deref();
      if (!text || text.nodeType !== 3 || !text.isConnected || text.ownerDocument !== doc || text.data !== request.sourceText) return null;
      const host = text.parentElement;
      if (!host || host.childNodes.length !== 1 || host.firstChild !== text || text.getRootNode() !== doc
        || host.scrollLeft !== 0 || host.scrollTop !== 0) return null;
      const s = style(host);
      if (!['block','inline-block','flow-root','flex','inline-flex','grid','inline-grid'].includes(s.display)
        || !safeCommon(s) || s.direction !== 'ltr' || s.writingMode !== 'horizontal-tb' || s.whiteSpace !== 'nowrap'
        || s.textOverflow !== 'ellipsis' || !['hidden','clip'].includes(s.overflowX) || !['hidden','clip'].includes(s.overflowY)
        || (s.webkitLineClamp && s.webkitLineClamp !== 'none') || s.textTransform !== 'none'
        || (s.webkitTextSecurity && s.webkitTextSecurity !== 'none') || !zero(s.letterSpacing) || !zero(s.wordSpacing)
        || !noEffect(s.textShadow) || !zero(s.webkitTextStrokeWidth) || s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text'
        || (s.fontFeatureSettings && s.fontFeatureSettings !== 'normal') || (s.fontVariationSettings && s.fontVariationSettings !== 'normal')
        || !s.font || number(s.fontSize) <= 0 || !doc.fonts.check(s.font) || !pseudoSafe(host)) return null;
      const rgb = value => {
        const m = /^rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)$/.exec(value);
        return m ? m.slice(1).map(Number) : null;
      };
      const color = rgb(s.webkitTextFillColor || s.color), background = rgb(s.backgroundColor);
      if (!color || !background || s.backgroundImage !== 'none') return null;
      const luminance = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const l1 = luminance(color), l2 = luminance(background);
      if ((Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05) < 3) return null;
      for (let el = host.parentElement; el; el = el.parentElement) {
        const ancestor = style(el);
        if (!safeCommon(ancestor) || !pseudoSafe(el)) return null;
        if (ancestor.overflowX !== 'visible' || ancestor.overflowY !== 'visible') return null;
      }
      const bounds = host.getBoundingClientRect();
      const radii = [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];
      if (radii.some(value => !/^(?:[0-9.]+px)(?: [0-9.]+px)?$/.test(value))) return null;
      const corner = Math.max(...radii.flatMap(value => value.split(' ').map(number)));
      const pl = number(s.paddingLeft), pr = number(s.paddingRight), pt = number(s.paddingTop), pb = number(s.paddingBottom);
      const clip = {x:bounds.x + host.clientLeft + pl, y:bounds.y + host.clientTop + pt,
        width:host.clientWidth - pl - pr - 1, height:host.clientHeight - pt - pb};
      if (!finiteRect(clip)) return null;
      const range = doc.createRange();
      range.setStart(text, 0); range.setEnd(text, request.prefix.length);
      // Blink reports both the full logical run and a second clipped run.
      // For the selected prefix both rectangles must coincide exactly.
      const prefixRects = [...range.getClientRects()].map(asRect);
      if (prefixRects.length !== 2 || JSON.stringify(prefixRects[0]) !== JSON.stringify(prefixRects[1])) return null;
      const prefixBounds = prefixRects[0];
      range.setEnd(text, request.sourceText.length);
      const fullRects = [...range.getClientRects()].map(asRect);
      if (fullRects.length !== 2 || JSON.stringify(fullRects[1]) !== JSON.stringify(prefixBounds)) return null;
      const fullBounds = fullRects[0];
      if (!finiteRect(prefixBounds) || !finiteRect(fullBounds) || fullBounds.width <= clip.width
        || prefixBounds.x < clip.x - 0.01 || prefixBounds.y < clip.y - 0.01
        || prefixBounds.y + prefixBounds.height > clip.y + clip.height + 0.01) return null;
      context.font = s.font;
      if (context.fontKerning !== undefined) context.fontKerning = s.fontKerning;
      const width = context.measureText(request.sourceText).width;
      const ellipsisWidth = context.measureText('…').width + 2;
      if (!Number.isFinite(width) || Math.abs(width - fullBounds.width) > 1 || !Number.isFinite(ellipsisWidth) || ellipsisWidth <= 2
        || prefixBounds.x + prefixBounds.width + ellipsisWidth > clip.x + clip.width) return null;
      const related = new Set();
      for (let el = host; el; el = el.parentElement) related.add(el);
      const right = prefixBounds.x + prefixBounds.width + ellipsisWidth, bottom = prefixBounds.y + prefixBounds.height;
      if (prefixBounds.x < 0 || prefixBounds.y < 0 || right > view.innerWidth || bottom > view.innerHeight) return null;
      if (prefixBounds.x < bounds.x + corner || prefixBounds.y < bounds.y + corner
        || right > bounds.right - corner || bottom > bounds.bottom - corner) return null;
      const spatial = sceneIndex();
      // Effects, pseudo elements and unknown shadow trees may paint outside their boxes.
      if (spatial.unsafe) return null;
      const possible = new Set(spatial.large), size = spatial.size;
      for (let x=Math.floor(prefixBounds.x/size); x<=Math.floor(right/size); x++)
        for (let y=Math.floor(prefixBounds.y/size); y<=Math.floor(bottom/size); y++)
          for (const el of spatial.cells.get(x + ',' + y) || []) possible.add(el);
      for (const item of possible) {
        if (item.isText ? item.owner === text : related.has(item.owner)) continue;
        const r = item.rect;
        if (r.x < right && r.x + r.width > prefixBounds.x && r.y < bottom && r.y + r.height > prefixBounds.y) return null;
      }
      const fingerprint = [s.font,s.fontKerning,s.fontSize,s.fontWeight,s.fontFamily,s.fontStyle,s.fontStretch,
        s.letterSpacing,s.wordSpacing,s.lineHeight,s.color,s.webkitTextFillColor,s.textAlign,s.verticalAlign,
        s.paddingLeft,s.paddingRight,s.paddingTop,s.paddingBottom,s.backgroundColor,s.backgroundImage,...radii,s.textOverflow,s.overflowX,s.overflowY,
        s.direction,s.writingMode,s.whiteSpace,s.fontFeatureSettings,s.fontVariationSettings];
      return {clip,prefixBounds,ellipsisWidth,singleTextNode:true,singleLine:true,paintProven:true,fingerprint,fullBounds};
    } catch { return null; }
  });
}`;
