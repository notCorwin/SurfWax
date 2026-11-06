/** One synchronous, read-only sample in an extension content world. */
export function sampleReadableSnapshot() {
  /* surf-wax:read-only-snapshot */
  if (document.readyState !== "complete" || document.fonts.status !== "loaded" || typeof chrome?.dom?.openOrClosedShadowRoot !== "function")
    return null;
  const viewport = {
    x: scrollX,
    y: scrollY,
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
  };
  const result = {
    url: location.href,
    title: document.title,
    viewport,
    rows: [],
  };
  // View-transition images paint above the live DOM, outside ordinary box
  // stacking. They can hide a newly installed document subtree completely.
  if (
    globalThis.CSS?.highlights?.size ||
    document.documentElement.matches(":active-view-transition") ||
    document.getAnimations().some((animation) => animation.effect?.pseudoElement?.startsWith("::view-transition"))
  )
    return result;

  const styles = new Map(),
    safe = new Map(),
    stacks = new Map(),
    suppressed = new Map(),
    covers = [];
  // Inspect every author shadow tree, including closed roots, in the extension
  // content world. Slotted composition remains deliberately unsupported.
  const elements = [];
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (root.querySelector(":modal, :popover-open, :active-view-transition, slot") || root.fullscreenElement) return result;
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      const shadow = element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null;
      if (shadow) roots.push(shadow);
    }
  }
  const style = (element) => {
    let value = styles.get(element);
    if (!value) {
      value = getComputedStyle(element);
      styles.set(element, value);
    }
    return value;
  };
  const colors = new Map();
  let colorContext;
  const rgba = (value) => {
    if (colors.has(value)) return colors.get(value);
    let color = null;
    if (typeof value === "string" && !/^(?:currentcolor|inherit|initial|unset|revert(?:-layer)?)$|light-dark\(/i.test(value)) {
      // Let Chrome resolve CSS Color 4 as well as rgb(). This is a synthetic
      // color swatch, never a screenshot or a read of the page's pixels.
      colorContext ??= new OffscreenCanvas(1, 1).getContext("2d", {
        willReadFrequently: true,
      });
      if (colorContext) {
        colorContext.fillStyle = "#010203";
        colorContext.fillStyle = value;
        const first = colorContext.fillStyle;
        colorContext.fillStyle = "#040506";
        colorContext.fillStyle = value;
        if (first === colorContext.fillStyle) {
          const serialized = String(colorContext.fillStyle);
          const explicit = /\/\s*([+-]?[\d.eE+-]+%?)\s*\)$/.exec(serialized) ?? /^rgba\(.*?,\s*([+-]?[\d.eE+-]+%?)\s*\)$/.exec(serialized);
          let alpha;
          if (explicit) alpha = parseFloat(explicit[1]) / (explicit[1].endsWith("%") ? 100 : 1);
          else if (/^#[\da-f]{8}$/i.test(serialized)) alpha = parseInt(serialized.slice(-2), 16) / 255;
          else if (/^#[\da-f]{6}$/i.test(serialized) || /^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\([^/]*\)$/i.test(serialized)) alpha = 1;
          // ImageData quantizes alpha. Keep the exact parsed alpha so a tiny
          // nonzero cover never becomes transparent merely by rounding.
          if (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) {
            colorContext.clearRect(0, 0, 1, 1);
            colorContext.fillRect(0, 0, 1, 1);
            color = [...colorContext.getImageData(0, 0, 1, 1).data];
            color[3] = alpha * 255;
          }
        }
      }
    }
    colors.set(value, color);
    return color;
  };
  const clear = (value) => rgba(value)?.[3] === 0;
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const inViewport = (r) =>
    r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= viewport.width && r.bottom <= viewport.height;
  const pseudoProperties = [
    "color",
    "-webkit-text-fill-color",
    "-webkit-text-security",
    "font-size",
    "font-family",
    "font-weight",
    "text-transform",
    "text-shadow",
    "-webkit-text-stroke-width",
    "visibility",
    "opacity",
    "filter",
    "background-clip",
    "background-image",
  ];
  const effects = [
    "transform",
    "translate",
    "rotate",
    "scale",
    "filter",
    "backdrop-filter",
    "perspective",
    "clip-path",
    "mask-image",
    "-webkit-mask-box-image-source",
    "offset-path",
  ];

  const noGeometryEffect = (s, key) => {
    const value = s.getPropertyValue(key);
    if (!value || value === "none") return true;
    const parts = value.split(/\s+/);
    if (key === "translate") return parts.length <= 2 && parts.every((x) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|%)$/.test(x) || x === "0");
    if (key === "scale") return parts.length <= 2 && parts.every((x) => Number(x) === 1);
    if (key === "rotate") return value === "0deg";
    if (key === "transform") {
      const match = /^matrix\(([^()]*)\)$/.exec(value);
      if (!match) return false;
      const n = match[1].split(",").map(Number);
      return n.length === 6 && n.every(Number.isFinite) && n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1;
    }
    return false;
  };
  // Eligibility of a text label is stricter than bounds on foreign paint.
  // Native border/text rectangles already include an ordinary 2D affine
  // transform. Scaling a background dot does not give it viewport-wide ink.
  const planarOwnEffect = (s, key) => {
    if (noGeometryEffect(s, key)) return true;
    if (s.transformStyle !== "flat") return false;
    const value = s.getPropertyValue(key);
    if (key === "transform") {
      const match = /^matrix\(([^()]*)\)$/.exec(value),
        values = match?.[1].split(",").map(Number);
      return values?.length === 6 && values.every(Number.isFinite);
    }
    if (key === "scale") {
      const values = value.split(/\s+/).map(Number);
      return values.length <= 2 && values.every(Number.isFinite);
    }
    if (key === "rotate") return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)$/.test(value);
    return false;
  };
  const emptyPseudo = (p) =>
    p.display === "none" ||
    Number(p.opacity) === 0 ||
    (p.content === '""' &&
      p.display !== "list-item" &&
      clear(p.backgroundColor) &&
      p.backgroundImage === "none" &&
      p.boxShadow === "none" &&
      p.textShadow === "none" &&
      p.outlineStyle === "none" &&
      p.borderImageSource === "none" &&
      p.borderImageOutset === "0" &&
      p.textDecorationLine === "none" &&
      parseFloat(p.webkitTextStrokeWidth) === 0 &&
      p.appearance === "none" &&
      p.mixBlendMode === "normal" &&
      p.getPropertyValue("border-shape") === "none" &&
      ["Top", "Right", "Bottom", "Left"].every(
        (k) => parseFloat(p["border" + k + "Width"]) === 0 || p["border" + k + "Style"] === "none",
      ) &&
      effects.every((k) => !p.getPropertyValue(k) || p.getPropertyValue(k) === "none") &&
      (!p.getPropertyValue("-webkit-box-reflect") || p.getPropertyValue("-webkit-box-reflect") === "none"));
  const uncomplicated = (element) => {
    if (safe.has(element)) return safe.get(element);
    const s = style(element);
    let value =
      element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      !element.shadowRoot &&
      !element.assignedSlot &&
      s.display !== "none" &&
      s.visibility === "visible" &&
      s.contentVisibility === "visible" &&
      s.contain === "none" &&
      Number(s.opacity) > 0 &&
      effects.every((key) => noGeometryEffect(s, key)) &&
      s.clip === "auto" &&
      s.mixBlendMode === "normal" &&
      s.display !== "list-item" &&
      (s.zoom === "1" || s.zoom === "normal") &&
      s.textDecorationLine === "none" &&
      s.textEmphasisStyle === "none" &&
      s.textShadow === "none" &&
      parseFloat(s.webkitTextStrokeWidth) === 0;
    if (value) {
      for (const pseudo of ["::first-line", "::first-letter"]) {
        const p = getComputedStyle(element, pseudo);
        if (pseudoProperties.some((key) => p.getPropertyValue(key) !== s.getPropertyValue(key))) {
          value = false;
          break;
        }
      }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(element, pseudo).content;
        if (content && content !== "none" && content !== "normal" && !emptyPseudo(getComputedStyle(element, pseudo))) {
          value = false;
          break;
        }
      }
    }
    safe.set(element, value);
    return value;
  };
  const viewportRect = {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height,
  };
  const parentOf = (element) => element.parentElement || (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
  const hiddenTree = (element) => {
    const pending = [];
    let current = element;
    while (current && !suppressed.has(current)) {
      pending.push(current);
      current = parentOf(current);
    }
    let value = current ? suppressed.get(current) : false;
    while (pending.length) {
      const item = pending.pop(),
        s = style(item);
      // A clip reduced to a point removes the entire subtree's paint. Do not
      // use this proof if another effect can generate paint beyond the clip.
      const emptyClip =
        s.clipPath === "inset(50%)" &&
        s.outlineStyle === "none" &&
        s.boxShadow === "none" &&
        effects.filter((key) => key !== "clip-path").every((key) => !s.getPropertyValue(key) || s.getPropertyValue(key) === "none");
      value = value || s.display === "none" || Number(s.opacity) === 0 || emptyClip;
      suppressed.set(item, value);
    }
    return value;
  };
  const nonNone = (s, key) => {
    const value = s.getPropertyValue(key);
    return value && value !== "none";
  };
  // Compare only atomic stacking contexts. A null level marks a relationship
  // this sampler cannot prove; an earlier, known context may still bound it.
  const level = (element, s, parent) => {
    const z = s.zIndex,
      parentDisplay = parent ? style(parent).display : "";
    const flexItem = /^(inline-)?(?:flex|grid)$/.test(parentDisplay);
    const positioned = /^(?:absolute|relative|fixed|sticky)$/.test(s.position);
    const uncertain =
      (s.willChange !== "auto" && s.willChange !== "none") ||
      s.containerType !== "normal" ||
      s.contentVisibility !== "visible" ||
      s.transformStyle !== "flat" ||
      nonNone(s, "perspective") ||
      /matrix3d\(/.test(s.transform) ||
      (s.rotate !== "none" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)$/.test(s.rotate)) ||
      (s.translate !== "none" && s.translate.split(/\s+/).length > 2) ||
      s.backfaceVisibility !== "visible" ||
      (parentDisplay === "contents" && z !== "auto") ||
      element.namespaceURI !== "http://www.w3.org/1999/xhtml";
    if (uncertain) return null;
    const zApplies = positioned || flexItem;
    const context =
      /^(?:fixed|sticky)$/.test(s.position) ||
      (z !== "auto" && zApplies) ||
      Number(s.opacity) < 1 ||
      s.mixBlendMode !== "normal" ||
      s.isolation === "isolate" ||
      /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(s.contain) ||
      effects.some((key) => nonNone(s, key));
    if (!context) return undefined;
    const numeric = z !== "auto" && zApplies ? Number(z) : 0;
    return Number.isFinite(numeric) ? numeric : null;
  };
  // A linked context path is shared by all non-context descendants. This
  // avoids copying an ancestor array per node on deep documents.
  const appendContext = (path, owner, value) => ({
    parent: path,
    owner,
    level: value,
    depth: (path?.depth || 0) + 1,
    unknown: (path?.unknown || 0) + (value === null ? 1 : 0),
  });
  const stack = (element) => {
    const pending = [];
    let current = element;
    while (current && !stacks.has(current)) {
      pending.push(current);
      current = parentOf(current);
    }
    let path = current ? stacks.get(current) : null;
    while (pending.length) {
      const item = pending.pop(),
        parent = parentOf(item);
      if (parent) {
        const value = level(item, style(item), parent);
        if (value !== undefined) path = appendContext(path, item, value);
      }
      stacks.set(item, path);
    }
    return path;
  };
  const paintPath = (element, pseudoStyle) => {
    const path = stack(element);
    if (!pseudoStyle) return path;
    const value = level(element, pseudoStyle, element);
    return value === undefined ? path : appendContext(path, pseudoStyle, value);
  };

  const strictlyAbove = (target, foreign) => {
    let a = target,
      b = foreign,
      childA = null,
      childB = null;
    while ((a?.depth || 0) > (b?.depth || 0)) {
      childA = a;
      a = a.parent;
    }
    while ((b?.depth || 0) > (a?.depth || 0)) {
      childB = b;
      b = b.parent;
    }
    while (a !== b) {
      childA = a;
      childB = b;
      a = a.parent;
      b = b.parent;
    }
    if (a?.unknown) return false;
    const upper = childA ? childA.level : 0,
      lower = childB ? childB.level : 0;
    return upper !== null && lower !== null && upper > lower;
  };
  // A CSS gradient mask on a known HTML box composites its complete subtree
  // as one group. The border box is an upper bound for border/padding/content
  // mask-clip, including fixed and generated descendants. Do not infer this
  // for SVG mask references, 3D transforms, zoom or outer expanding effects.
  const clips = new Map(),
    clipSafe = new Map();
  const intersect = (a, b) => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const safeClipChain = (s) =>
    ["transform", "translate", "rotate", "scale"].every((key) => noGeometryEffect(s, key)) &&
    s.transformStyle === "flat" &&
    !nonNone(s, "perspective") &&
    !nonNone(s, "filter") &&
    !nonNone(s, "backdrop-filter") &&
    !nonNone(s, "-webkit-box-reflect") &&
    (s.zoom === "1" || s.zoom === "normal");
  const groupClip = (element) => {
    const pending = [];
    let current = element;
    while (current && !clips.has(current)) {
      pending.push(current);
      current = parentOf(current);
    }
    let clip = current ? clips.get(current) : null,
      safeOuter = current ? clipSafe.get(current) : true;
    while (pending.length) {
      const item = pending.pop(),
        s = style(item);
      safeOuter = safeOuter && safeClipChain(s);
      const mask = s.maskImage,
        maskClips = s.maskClip.split(",").map((value) => value.trim());
      if (
        safeOuter &&
        item.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        /^(?:block|flow-root|flex|grid|inline-block|inline-flex|inline-grid)$/.test(s.display) &&
        /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(mask) &&
        !/url\(/i.test(mask) &&
        maskClips.every((value) => /^(?:border|padding|content)-box$/.test(value)) &&
        !nonNone(s, "-webkit-mask-box-image-source") &&
        !nonNone(s, "mask-border-source")
      ) {
        const rect = item.getBoundingClientRect();
        clip = clip ? intersect(clip, rect) : rect;
      }
      clips.set(item, clip);
      clipSafe.set(item, safeOuter);
    }
    return clip;
  };
  const addCover = (cover) => {
    if (
      cover.element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      (cover.directText !== undefined || cover.foregroundEffect || cover.pseudoStyle)
    ) {
      const ancestorClip = paintAncestorClip(cover.element, cover.pseudoStyle);
      if (ancestorClip) cover.rect = intersect(cover.rect, ancestorClip);
    }
    const clip = groupClip(cover.element);
    if (clip) cover.rect = intersect(cover.rect, clip);
    if (cover.rect.right > cover.rect.left && cover.rect.bottom > cover.rect.top && overlaps(cover.rect, viewportRect)) covers.push(cover);
  };
  // An SVG viewport clips its graphics, including transformed descendants.
  // Foreign HTML, visible overflow and effects on the root have no such proof.
  const clippedSvg = (element, s) =>
    element.namespaceURI === "http://www.w3.org/2000/svg" &&
    element.localName === "svg" &&
    !element.querySelector("foreignObject") &&
    s.overflowX === "hidden" &&
    s.overflowY === "hidden" &&
    s.outlineStyle === "none" &&
    s.boxShadow === "none" &&
    s.borderImageOutset === "0" &&
    !nonNone(s, "-webkit-box-reflect") &&
    effects.every((key) => !nonNone(s, key)) &&
    ["::before", "::after"].every((pseudo) => {
      const content = getComputedStyle(element, pseudo).content;
      return !content || content === "none" || content === "normal";
    });

  const splitTop = (value, commas) => {
    let depth = 0,
      token = "",
      out = [];
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")" && --depth < 0) return null;
      if (char === '"' || char === "'" || char === "\\") return null;
      const separator = depth === 0 && (commas ? char === "," : /\s/.test(char));
      if (separator) {
        if (token) out.push(token);
        token = "";
      } else token += char;
    }
    if (depth !== 0) return null;
    if (token) out.push(token);
    return out;
  };
  // Chrome Blink ShadowData::RectOutsets uses ceil(3 * sigma) + spread,
  // with sigma = CSS blur radius / 2 (verified against Chrome 156 source).
  // Include the original box and allow for layout and device-pixel snapping.
  // Negative spreads never shrink this upper bound; other effects stay unknown.
  const shadowBounds = (e, s, r) => {
    if (
      !(e instanceof HTMLElement) ||
      s.getPropertyValue("border-shape") !== "none" ||
      s.outlineStyle !== "none" ||
      s.borderImageOutset !== "0" ||
      nonNone(s, "-webkit-box-reflect")
    )
      return null;
    for (let p = e; p; p = p.parentElement) {
      const v = style(p);
      if (!safeClipChain(v) || effects.some((k) => !noGeometryEffect(v, k))) return null;
    }
    const parts = splitTop(s.boxShadow, true);
    if (!parts?.length) return null;
    const result = {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    };
    for (const part of parts) {
      const tokens = splitTop(part.trim(), false);
      if (!tokens) return null;
      const nums = [],
        colors = [];
      let inset = false;
      for (const token of tokens) {
        if (token === "inset") {
          if (inset) return null;
          inset = true;
        } else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?px$/i.test(token)) nums.push(Number(token.slice(0, -2)));
        else colors.push(token);
      }
      if (nums.length < 2 || nums.length > 4 || !nums.every(Number.isFinite) || colors.length !== 1 || !CSS.supports("color", colors[0]))
        return null;
      const [x, y, blur = 0, spread = 0] = nums;
      if (blur < 0) return null;
      if (inset) continue;
      const extent = Math.ceil(1.5 * blur) + Math.max(0, spread);
      result.left = Math.min(result.left, r.left + x - extent);
      result.right = Math.max(result.right, r.right + x + extent);
      result.top = Math.min(result.top, r.top + y - extent);
      result.bottom = Math.max(result.bottom, r.bottom + y + extent);
    }
    const margin = 2 * Math.max(1, 1 / viewport.scale);
    return {
      left: result.left - margin,
      top: result.top - margin,
      right: result.right + margin,
      bottom: result.bottom + margin,
    };
  };

  // Descendant painting is clipped after its own effects. A positioned
  // ancestor contains intervening absolute boxes; fixed escape remains
  // unknown. Clipping never bounds that ancestor's own shadow or outline.
  const paintAncestorClip = (root, pseudoStyle) => {
    const escapes = (s) =>
      s.position === "fixed" ||
      s.transformStyle !== "flat" ||
      s.perspective !== "none" ||
      /matrix3d/.test(s.transform) ||
      (s.translate !== "none" && s.translate.split(/\s+/).length > 2) ||
      (s.scale !== "none" && s.scale.split(/\s+/).length > 2) ||
      (s.rotate !== "none" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)$/.test(s.rotate));
    if (pseudoStyle && escapes(pseudoStyle)) return null;
    let clip = null;
    for (let p = root; p; p = parentOf(p)) {
      const s = style(p);
      if (escapes(s)) return null;
      // Overflow clips descendants before this ancestor's filter/reflect.
      // Native viewport border bounds already include planar transforms.
      if (
        (p !== root || pseudoStyle) &&
        p instanceof HTMLElement &&
        /^(?:block|flow-root|flex|grid|inline-block|inline-flex|inline-grid)$/.test(s.display) &&
        /^(?:relative|absolute|sticky)$/.test(s.position) &&
        s.overflowX === "hidden" &&
        s.overflowY === "hidden" &&
        s.getPropertyValue("border-shape") === "none"
      ) {
        const box = p.getBoundingClientRect();
        clip = clip ? intersect(clip, box) : box;
      }
      // Masks and clip paths only remove paint. An expanding effect loses
      // the inner bound, but a farther outer overflow can establish a new one.
      if (nonNone(s, "filter") || nonNone(s, "backdrop-filter") || nonNone(s, "-webkit-box-reflect")) clip = null;
    }
    return clip;
  };
  const svgAncestorClip = (root) => {
    if (!(root instanceof SVGSVGElement) || root.querySelector("foreignObject,use")) return null;
    for (const node of [root, ...root.querySelectorAll("*")]) {
      const s = style(node);
      if (
        node.namespaceURI !== "http://www.w3.org/2000/svg" ||
        /^(?:absolute|fixed|sticky)$/.test(s.position) ||
        s.outlineStyle !== "none" ||
        s.transformStyle !== "flat" ||
        s.perspective !== "none" ||
        /matrix3d/.test(s.transform)
      )
        return null;
      for (const pseudo of ["::before", "::after"]) {
        const p = getComputedStyle(node, pseudo);
        if (p.content && p.content !== "none" && p.content !== "normal" && !emptyPseudo(p)) return null;
      }
    }
    return paintAncestorClip(root);
  };
  const clippedSvgs = new Set();
  for (const element of elements) {
    if (element.namespaceURI === "http://www.w3.org/2000/svg") {
      let ancestor = element.parentElement,
        enclosed = false;
      while (ancestor) {
        if (clippedSvgs.has(ancestor)) {
          enclosed = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (enclosed) continue;
    }
    const s = style(element),
      rect = element.getBoundingClientRect();
    if (hiddenTree(element) || s.visibility !== "visible") continue;

    // Prefer the SVG's own proven viewport clip to a coarser ancestor clip.
    if (clippedSvg(element, s)) {
      clippedSvgs.add(element);
      if (overlaps(rect, viewportRect)) addCover({ element, rect, path: paintPath(element) });
      continue;
    }
    const svgClip = svgAncestorClip(element);
    if (svgClip) {
      clippedSvgs.add(element);
      if (overlaps(svgClip, viewportRect)) addCover({ element, rect: svgClip, path: paintPath(element) });
      continue;
    }
    const pseudos = ["::before", "::after"]
      .map((pseudo) => getComputedStyle(element, pseudo))
      .filter(
        (p) =>
          p.content &&
          p.content !== "none" &&
          p.content !== "normal" &&
          p.display !== "none" &&
          p.visibility === "visible" &&
          Number(p.opacity) !== 0 &&
          !emptyPseudo(p),
      );
    for (const p of pseudos)
      addCover({
        element,
        rect: viewportRect,
        path: paintPath(element, p),
        pseudoStyle: p,
      });

    const textNodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim());
    const directText = textNodes.length > 0;
    const textRects = [];
    for (const node of textNodes) {
      const range = document.createRange();
      range.selectNodeContents(node);
      textRects.push(...range.getClientRects());
    }
    const foregroundEffect = s.outlineStyle !== "none",
      shadowEffect = s.boxShadow !== "none";
    const shadowRect = shadowEffect ? shadowBounds(element, s, rect) : null;
    const unbounded =
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      s.display === "list-item" ||
      foregroundEffect ||
      (shadowEffect && !shadowRect) ||
      nonNone(s, "-webkit-box-reflect") ||
      s.borderImageOutset !== "0" ||
      s.textDecorationLine !== "none" ||
      s.textEmphasisStyle !== "none" ||
      (directText && (s.textShadow !== "none" || parseFloat(s.webkitTextStrokeWidth) > 0 || s.textDecorationLine !== "none")) ||
      effects.some((key) => !planarOwnEffect(s, key));

    const border = ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(s["border" + side + "Width"]) > 0);
    // Even unverified foreground text can cover another text run. Its own
    // eligibility must not decide whether it is a potential occluder.
    if (s.outlineStyle !== "none") {
      // CSS leaves some outline paint order unspecified. Only a distinct,
      // enclosing lower context can bound it; never assume ordinary level 0.
      const parent = parentOf(element);
      addCover({
        element,
        rect: viewportRect,
        path: appendContext(parent ? stack(parent) : null, element, null),
        foregroundEffect: true,
      });
    }
    const path = paintPath(element);
    if (unbounded) {
      addCover({ element, rect: viewportRect, path, foregroundEffect, directText });
    } else {
      // Background/border paint is behind descendants; direct text can be
      // their foreground occluder. Never substitute a parent's entire box
      // for its own text, or bridge a child between separate text fragments.
      if (
        shadowEffect ||
        border ||
        !clear(s.backgroundColor) ||
        s.backgroundImage !== "none" ||
        /^(IMG|VIDEO|CANVAS|SVG|IFRAME|OBJECT|EMBED)$/i.test(element.tagName)
      )
        addCover({ element, rect: shadowRect || rect, path, directText: false });
      for (const textRect of textRects) addCover({ element, rect: textRect, path, directText: true });
    }
  }
  // Collapsible ASCII whitespace has to be measured in this same read: DOM
  // indentation and actual inter-word boundary spaces otherwise look alike.
  const renderedWhitespace = (node, text, s) => {
    const mode = s.whiteSpaceCollapse;
    if (mode === "preserve" || mode === "break-spaces") return text;
    if (mode !== "collapse" && mode !== "preserve-breaks") return null;
    if (mode === "preserve-breaks" && /[\n\r\f]/.test(text)) return null;
    const range = document.createRange(),
      runs = /[\t\n\f\r ]+/g;
    let output = "",
      last = 0,
      match;
    while ((match = runs.exec(text))) {
      output += text.slice(last, match.index);
      range.setStart(node, match.index);
      range.setEnd(node, runs.lastIndex);
      const painted = [...range.getClientRects()].some((r) => r.width > 0 && r.height > 0);
      if (painted) output += " ";
      else if (match.index > 0 && runs.lastIndex < text.length) return null;
      last = runs.lastIndex;
    }
    return output + text.slice(last);
  };
  // CSS scales overlapping corner radii to fit the border box. The padding
  // edge subtracts each adjacent border. A rounded rectangle is convex, so
  // checking the four corners proves containment of a complete text box.
  const paddingShape = (s, box) => {
    const corner = s.getPropertyValue("corner-shape");
    if (
      (corner && corner !== "round" && corner !== "superellipse(1)") ||
      (s.getPropertyValue("border-shape") && s.getPropertyValue("border-shape") !== "none")
    )
      return null;
    const pairs = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"].map((key) =>
      s[key].split(/\s+/),
    );
    const length = (value, size) =>
      /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)$/.test(value) ? parseFloat(value) * (value.endsWith("%") ? size / 100 : 1) : NaN;
    if (pairs.some((pair) => pair.length < 1 || pair.length > 2)) return null;
    const x = pairs.map((pair) => length(pair[0], box.width)),
      y = pairs.map((pair) => length(pair[1] || pair[0], box.height));
    const borders = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].map((key) => length(s[key], 0));
    if (![...x, ...y, ...borders].every(Number.isFinite) || !(box.width > 0 && box.height > 0)) return null;
    const scale = Math.min(1, box.width / (x[0] + x[1]), box.width / (x[3] + x[2]), box.height / (y[0] + y[3]), box.height / (y[1] + y[2]));
    const [bt, br, bb, bl] = borders;
    const shape = {
      left: box.left + bl,
      right: box.right - br,
      top: box.top + bt,
      bottom: box.bottom - bb,
      x: x.map((value, index) => Math.max(0, value * scale - (index === 0 || index === 3 ? bl : br))),
      y: y.map((value, index) => Math.max(0, value * scale - (index < 2 ? bt : bb))),
    };
    const width = shape.right - shape.left,
      height = shape.bottom - shape.top;
    if (
      shape.x[0] + shape.x[1] > width ||
      shape.x[3] + shape.x[2] > width ||
      shape.y[0] + shape.y[3] > height ||
      shape.y[1] + shape.y[2] > height
    )
      return null;
    return shape;
  };
  const insideShape = (rect, shape) => {
    if (!shape || rect.left < shape.left || rect.right > shape.right || rect.top < shape.top || rect.bottom > shape.bottom) return false;
    return [
      [rect.left, rect.top],
      [rect.right, rect.top],
      [rect.right, rect.bottom],
      [rect.left, rect.bottom],
    ].every(([px, py]) =>
      shape.x.every((rx, index) => {
        const ry = shape.y[index];
        if (rx === 0 || ry === 0) return true;
        const left = index === 0 || index === 3,
          top = index < 2;
        const cx = left ? shape.left + rx : shape.right - rx,
          cy = top ? shape.top + ry : shape.bottom - ry;
        return !(left ? px < cx : px > cx) || !(top ? py < cy : py > cy) || ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 < 1;
      }),
    );
  };
  const roundedInterior = (element, s, rect) => {
    if (s.overflowX === "visible" && s.overflowY === "visible") return null;
    if (/^(?:0(?:px|%)?\s*)+$/.test(s.borderRadius)) return null;
    if (s.overflowX === "visible" || s.overflowY === "visible") return false;
    if ([s.overflowX, s.overflowY].every((value) => value === "hidden" || value === "clip") && s.scrollbarGutter === "auto")
      return paddingShape(s, rect) || false;
    const bl = parseFloat(s.borderLeftWidth),
      br = parseFloat(s.borderRightWidth),
      bt = parseFloat(s.borderTopWidth),
      bb = parseFloat(s.borderBottomWidth);
    if (
      element.clientLeft !== bl ||
      element.clientTop !== bt ||
      Math.abs(rect.width - element.clientWidth - bl - br) > 0.01 ||
      Math.abs(rect.height - element.clientHeight - bt - bb) > 0.01
    )
      return false;
    return paddingShape(s, rect) || false;
  };
  // Nontransparent glyphs can still disappear against an equal background.
  // Establish solid background layers under every text fragment, then let
  // Chrome composite their CSS colors. Images and uncertain background
  // clipping remain unproven; a translucent solid layer is not an image.
  const composites = new Map();
  const composite = (layers) => {
    const key = JSON.stringify(layers);
    if (composites.has(key)) return composites.get(key);
    let color = null;
    if (layers.every((value) => rgba(value))) {
      colorContext.clearRect(0, 0, 1, 1);
      for (const value of layers) {
        colorContext.fillStyle = value;
        colorContext.fillRect(0, 0, 1, 1);
      }
      const channels = [...colorContext.getImageData(0, 0, 1, 1).data];
      if (channels[3] === 255) color = channels.slice(0, 3);
    }
    composites.set(key, color);
    return color;
  };
  const background = (parent, rects) => {
    const layers = [];
    for (let element = parent; element; element = element.parentElement) {
      const s = style(element);
      if (Number(s.opacity) !== 1 || s.backgroundImage !== "none") return null;
      if (s.boxShadow.includes("inset")) return null;
      const border = ["Top", "Right", "Bottom", "Left"].some(
        (side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none",
      );
      const transparent = clear(s.backgroundColor);
      if (transparent && !border && s.boxShadow === "none") continue;
      const boxes = [...element.getClientRects()].map((box) => paddingShape(s, box));
      if (!rects.every((r) => boxes.some((box) => insideShape(r, box)))) return null;
      if (transparent) continue;
      const color = rgba(s.backgroundColor);
      if (!color || s.backgroundClip !== "border-box") return null;
      layers.push(s.backgroundColor);
      if (color[3] === 255) return layers.reverse();
    }
    // The normal/light HTML canvas is white when neither root nor body
    // supplies a background. Other UA color schemes have no proof here.
    return /^(?:normal|light)$/.test(style(document.documentElement).colorScheme) ? ["white", ...layers.reverse()] : null;
  };
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT),
    candidates = [];
  const selection = getSelection();
  while (walker.nextNode()) {
    const node = walker.currentNode,
      parent = node.parentElement,
      rawText = node.nodeValue;
    if (!parent || !rawText) continue;
    const s = style(parent);
    if (
      s.textTransform !== "none" ||
      s.webkitTextSecurity !== "none" ||
      clear(s.webkitTextFillColor || s.color) ||
      !(parseFloat(s.fontSize) > 0)
    )
      continue;
    let depth = 0,
      valid = true;
    for (let element = parent; element; element = element.parentElement) {
      depth++;
      if (!uncomplicated(element)) {
        valid = false;
        break;
      }
    }
    if (!valid || (selection?.rangeCount && selection.containsNode(node, true))) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length || !rects.every(inViewport)) continue;
    const layers = background(parent, rects),
      ground = layers && composite(layers);
    const ink = layers && composite([...layers, s.webkitTextFillColor || s.color]);
    if (!ink || !ground || !ink.some((channel, index) => Math.abs(channel - ground[index]) >= 1)) continue;
    for (let element = parent; element && valid; element = element.parentElement) {
      const s = style(element),
        rect = element.getBoundingClientRect();
      // clientWidth/Height are integers. Hidden/clip overflow with no reserved
      // scrollbar uses the native fractional padding edge, so a fitting label
      // is not rejected merely because its width rounds down.
      const left = rect.left + parseFloat(s.borderLeftWidth),
        top = rect.top + parseFloat(s.borderTopWidth);
      const right = rect.right - parseFloat(s.borderRightWidth),
        bottom = rect.bottom - parseFloat(s.borderBottomWidth);
      const exactX = (s.overflowX === "hidden" || s.overflowX === "clip") && s.scrollbarGutter === "auto";
      const exactY = (s.overflowY === "hidden" || s.overflowY === "clip") && s.scrollbarGutter === "auto";
      const clipRight = exactX ? right : Math.min(right, rect.left + element.clientLeft + element.clientWidth);
      const clipBottom = exactY ? bottom : Math.min(bottom, rect.top + element.clientTop + element.clientHeight);
      if ((s.overflowX === "clip" || s.overflowY === "clip") && s.overflowClipMargin !== "0px") {
        valid = false;
        break;
      }
      const interior = roundedInterior(element, s, rect);
      if (interior === false) {
        valid = false;
        break;
      }
      for (const r of rects)
        if (
          (s.overflowX !== "visible" && (r.left < left || r.right > clipRight)) ||
          (s.overflowY !== "visible" && (r.top < top || r.bottom > clipBottom)) ||
          (interior && !insideShape(r, interior))
        ) {
          valid = false;
          break;
        }
    }
    const text = renderedWhitespace(node, rawText, s);
    if (
      !text ||
      !valid ||
      covers.some(
        ({ element, rect, path, foregroundEffect, directText }) =>
          (!element.contains(parent) || foregroundEffect || (directText && element !== parent)) &&
          rects.some((r) => overlaps(r, rect)) &&
          !strictlyAbove(stack(parent), path),
      )
    )
      continue;
    candidates.push({ text, depth, rects });
  }
  // Overlapping foreign text can also obscure characters without a background.
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if (candidates.some((other, j) => j !== i && item.rects.some((a) => other.rects.some((b) => overlaps(a, b))))) continue;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const rect of item.rects) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    result.rows.push({
      text: item.text,
      depth: item.depth,
      bounds: [left, top, right - left, bottom - top],
    });
  }
  return result;
}
