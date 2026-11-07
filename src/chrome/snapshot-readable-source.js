/** One synchronous, read-only sample in an extension content world. */
export function sampleReadableSnapshot(pageZoom = NaN, nativeRoots = [], nativeProofs) {
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
    gaps: [],
  };
  const identitiesKey = Symbol.for("surf-wax.snapshot-observation-identities.v1");
  let identities = globalThis[identitiesKey];
  if (!identities || identities.document !== document) {
    identities = { document, nodes: new WeakMap(), next: 1 };
    globalThis[identitiesKey] = identities;
  }
  const keyFor = (node) => {
    let key = identities.nodes.get(node);
    if (key === undefined) {
      key = identities.next++;
      identities.nodes.set(node, key);
    }
    return key;
  };
  const primitives = globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")];
  const nativeOwners = new WeakMap(), nativeTextNodes = new Map(), nativeUncertain = new Set();
  const gapKeys = new Map(),
    uncertainLabels = new Set(), uncertainText = new Map();
  const gap = (reason, element, rect, role) => {
    let reasons = gapKeys.get(element);
    if (!reasons) {
      reasons = new Set();
      gapKeys.set(element, reasons);
    }
    if (reasons.has(reason)) return;
    reasons.add(reason);
    if (
      [
        "text-paint",
        "text-background",
        "text-whitespace",
        "text-overlap",
        "paint-occlusion",
        "clip-coverage",
        "effect-coverage",
        "generated-content",
        "shadow-content",
        "slotted-content",
      ].includes(reason)
    ) {
      // Text identity remains private. Unknown regions never expose the DOM
      // string; labels are tainted through their actual composed parent.
      const textNode = element.nodeType === Node.TEXT_NODE;
      const nativeHost = nativeOwners.get(element);
      if (nativeHost) nativeUncertain.add(nativeHost);
      else {
        uncertainLabels.add(textNode ? composedParent(element) : element);
        if (textNode && element.nodeValue?.trim() && rect?.width > 0 && rect?.height > 0) uncertainText.set(element, rect);
      }
    }
    result.gaps.push({
      reason,
      ...(rect && rect.width > 0 && rect.height > 0 ? { bounds: [rect.left, rect.top, rect.width, rect.height] } : {}),
      ...(role ? { role } : {}),
      count: 1,
    });
  };
  // View-transition images paint above the live DOM, outside ordinary box
  // stacking. They can hide a newly installed document subtree completely.
  if (
    globalThis.CSS?.highlights?.size ||
    document.documentElement.matches(":active-view-transition") ||
    document.getAnimations().some((animation) => animation.effect?.pseudoElement?.startsWith("::view-transition"))
  ) {
    gap("document-overlay", document.documentElement, document.documentElement.getBoundingClientRect());
    return result;
  }

  const styles = new Map(),
    safe = new Map(),
    stacks = new Map(),
    suppressed = new Map(),
    covers = [];
  // Discover author and pre-resolved native roots, then traverse the composed
  // tree. UA roots are real objects resolved before this task; their strings,
  // styles and children are read only now. ShadowRoot.mode is never read.
  const shadowRoots = new Map(), topLayers = [], unsupportedSlots = [];
  const nativeRootByHost = new Map(), conflictingNativeHosts = new Set();
  for (const root of Array.isArray(nativeRoots) ? nativeRoots : []) {
    try {
      const host = root?.host;
      if (!(host instanceof HTMLElement) || !/^(?:input|textarea|select)$/.test(host.localName)
        || root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !root.isConnected || !host.isConnected
        || root.ownerDocument !== document || host.ownerDocument !== document || root.getRootNode({ composed: true }) !== document) continue;
      if (nativeRootByHost.has(host) && nativeRootByHost.get(host) !== root) {
        nativeRootByHost.delete(host); conflictingNativeHosts.add(host);
      } else if (!conflictingNativeHosts.has(host)) nativeRootByHost.set(host, root);
    } catch {}
  }
  let hasAuthorShadowRoots = false;
  const authorHosts = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    topLayers.push(...root.querySelectorAll(":modal, :popover-open"));
    if (root.fullscreenElement) topLayers.push(root.fullscreenElement);
    for (const element of root.querySelectorAll("*")) {
      // Native field roots still use the shared local text and field proofs.
      const authorHost = element instanceof HTMLElement && (element.localName.includes("-") || authorHosts.has(element.localName));
      const authorRoot = authorHost ? chrome.dom.openOrClosedShadowRoot(element) : null;
      if (authorRoot) hasAuthorShadowRoots = true;
      const shadow = nativeRootByHost.get(element) || authorRoot;
      if (shadow) {
        roots.push(shadow);
        shadowRoots.set(element, shadow);
      }
    }
  }
  const elements = [], textNodes = [], composedParents = new WeakMap(), childLists = new WeakMap(), composedOrder = new Map();
  const pendingNodes = [...document.childNodes].reverse().map((node) => ({ node, parent: null, nativeHost: null }));
  while (pendingNodes.length) {
    const { node, parent, nativeHost } = pendingNodes.pop();
    if (composedOrder.has(node)) continue;
    composedParents.set(node, parent); composedOrder.set(node, composedOrder.size);
    if (nativeHost) {
      nativeOwners.set(node, nativeHost);
      if (node.nodeType === Node.TEXT_NODE) {
        const nodes = nativeTextNodes.get(nativeHost) || [];
        nodes.push(node); nativeTextNodes.set(nativeHost, nodes);
      }
    }
    if (node.nodeType === Node.ELEMENT_NODE) elements.push(node);
    else if (node.nodeType === Node.TEXT_NODE) textNodes.push(node);
    let children;
    if (shadowRoots.has(node)) children = [...shadowRoots.get(node).childNodes];
    else if (node instanceof HTMLSlotElement) {
      try {
        // Recursing direct assignments preserves nested slot style/clip
        // ancestry while producing the same de-duplicated flattened leaves.
        const assigned = node.assignedNodes();
        children = assigned.length ? assigned : [...node.childNodes];
      } catch { unsupportedSlots.push(node); children = []; }
    } else children = [...node.childNodes];
    childLists.set(node, children);
    const nextParent = node.nodeType === Node.ELEMENT_NODE ? node : parent;
    const childNativeHost = nativeHost || (nativeRootByHost.has(node) && shadowRoots.get(node) === nativeRootByHost.get(node) ? node : null);
    for (let index = children.length - 1; index >= 0; index--) pendingNodes.push({ node: children[index], parent: nextParent, nativeHost: childNativeHost });
  }
  const composedChildren = (node) => childLists.get(node) || [];
  const composedParent = (node) => composedParents.get(node) || null;
  const composedContains = (ancestor, descendant) => {
    if (ancestor === document) return composedOrder.has(descendant);
    for (let node = descendant; node; node = composedParent(node)) if (node === ancestor) return true;
    return false;
  };
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
      !p.display.split(/\s+/).includes("list-item") &&
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
  const markerPaint = (element, s) => {
    if (!s.display.split(/\s+/).includes("list-item")) return false;
    const content = getComputedStyle(element, "::marker").content;
    return content && !["none", "normal", '""'].includes(content)
      || content === "normal" && (s.listStyleType !== "none" || s.listStyleImage !== "none");
  };
  const uncomplicated = (element) => {
    if (safe.has(element)) return safe.get(element);
    const s = style(element);
    let value =
      element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      composedOrder.has(element) &&
      s.display !== "none" &&
      s.visibility === "visible" &&
      s.contentVisibility === "visible" &&
      s.contain === "none" &&
      Number(s.opacity) > 0 &&
      effects.every((key) => key === "mask-image" || key === "clip-path" || noGeometryEffect(s, key)) &&
      s.clip === "auto" &&
      s.mixBlendMode === "normal" &&
      !markerPaint(element, s) &&
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
  // Top-layer boxes paint outside their DOM ancestors' clip/effect groups.
  // Computed inherited properties still come from Chrome's actual styles.
  const topLayerSet = new Set(topLayers);
  const parentOf = (element) => topLayerSet.has(element) ? null : composedParent(element);
  const paintContains = (ancestor, descendant) => {
    for (let current = descendant; current; current = parentOf(current)) if (current === ancestor) return true;
    return false;
  };
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
        s.clipPath !== "none" && primitives?.clipIsEmpty?.(s, item.getBoundingClientRect()) &&
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
    // HTML-embedded SVG roots paint atomically with respect to HTML siblings.
    // This says nothing about ordering inside that SVG or equal outer levels.
    const outerSvg = element.namespaceURI === "http://www.w3.org/2000/svg" && element.localName === "svg"
      && parent?.namespaceURI === "http://www.w3.org/1999/xhtml";
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
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" && !outerSvg;
    if (uncertain) return null;
    const zApplies = positioned || flexItem;
    const context =
      outerSvg ||
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
    topLayer: path?.topLayer || null,
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
      if (topLayers.includes(item)) {
        path = appendContext(null, item, 0);
        path.topLayer = item;
      } else if (parent) {
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
    if (target?.topLayer !== foreign?.topLayer && (target?.topLayer || foreign?.topLayer))
      return !!target?.topLayer && !foreign?.topLayer;
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
    effects.every((key) => planarOwnEffect(s, key)) &&
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
  const insetShadowRisk = (value) => {
    if (value === "none") return false;
    const layers = splitTop(value, true);
    if (!layers) return true;
    return layers.some((layer) => {
      const tokens = splitTop(layer, false);
      if (!tokens) return true;
      if (!tokens.includes("inset")) return false;
      const colors = tokens.filter((token) => token !== "inset" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?px$/i.test(token));
      return colors.length !== 1 || !clear(colors[0]);
    });
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
    for (let p = e; p; p = parentOf(p)) {
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
  // Bound supported SVG paint rather than treating visible overflow as ink
  // everywhere in the viewport. Chrome's getBBox() exposes object bounds;
  // its stroke/markers options are not implemented. Read each graphic in its
  // own coordinates and apply its native screen matrix after stroke expansion.
  const svgTextPseudoSafe = (element, s) => ["::first-line", "::first-letter"].every((pseudo) => {
    const p = getComputedStyle(element, pseudo);
    return [...pseudoProperties, "fill", "fill-opacity", "stroke", "stroke-width", "background-color", "text-decoration-line", "text-emphasis-style"]
      .every((key) => p.getPropertyValue(key) === s.getPropertyValue(key));
  });
  const svgPaintEvidence = new Map();
  const svgPaintBounds = (root) => {
    if (!(root instanceof SVGSVGElement) || root.querySelector("foreignObject,use,image")) return null;
    const selected = getSelection();
    // Selection can add opaque background paint even to transparent text.
    // An independent viewport clip may still bound this unsupported source.
    if (selected?.rangeCount && selected.containsNode(root, true)) return null;
    const planar = (s) => s.transformStyle === "flat" && s.perspective === "none"
      && ["transform", "translate", "rotate", "scale"].every((key) => planarOwnEffect(s, key))
      && !nonNone(s, "offset-path") && ["1", "normal"].includes(s.zoom);
    for (let ancestor = root; ancestor; ancestor = parentOf(ancestor)) {
      const s = style(ancestor);
      if (!planar(s) || nonNone(s, "filter") || nonNone(s, "backdrop-filter")
        || nonNone(s, "-webkit-box-reflect")) return null;
    }
    const frame = root.getBoundingClientRect();
    if (![frame.left, frame.top, frame.right, frame.bottom].every(Number.isFinite)) return null;
    const pieces = [];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const graphic = /^(?:path|rect|circle|ellipse|line|polyline|polygon|text|tspan)$/;
    const container = /^(?:svg|g|a|switch)$/;
    const definition = /^(?:defs|symbol|clipPath|mask|filter|marker|linearGradient|radialGradient|pattern|title|desc|metadata|style|script|animate|animateMotion|animateTransform|set|mpath)$/;
    const pending = [root];
    while (pending.length) {
      const element = pending.pop(), tag = element.localName;
      if (element.namespaceURI !== "http://www.w3.org/2000/svg") return null;
      if (definition.test(tag)) continue;
      if (!graphic.test(tag) && !container.test(tag)) return null;
      const s = style(element);
      if (s.display === "none" || Number(s.opacity) === 0) continue;
      // Visibility can be restored by descendants; never prune its subtree.
      // Masks/clips remove source paint. Filters, markers, foreign HTML and
      // CSS foreground decorations can introduce paint beyond object bounds.
      if (!planar(s) || markerPaint(element, s) || s.vectorEffect !== "none" || s.filter !== "none"
        || nonNone(s, "backdrop-filter") || nonNone(s, "-webkit-box-reflect")
        || s.boxShadow !== "none" || s.outlineStyle !== "none"
        || s.borderImageSource !== "none" || s.borderImageOutset !== "0"
        || nonNone(s, "border-shape") || s.backgroundImage !== "none"
        || s.textShadow !== "none" || s.textDecorationLine !== "none"
        || s.textEmphasisStyle !== "none" || parseFloat(s.webkitTextStrokeWidth) !== 0
        || [s.markerStart, s.markerMid, s.markerEnd].some((value) => value !== "none")) return null;
      for (const pseudo of ["::before", "::after"]) {
        const p = getComputedStyle(element, pseudo);
        if (p.content && !["none", "normal"].includes(p.content) && !emptyPseudo(p)) return null;
      }
      for (let i = element.children.length - 1; i >= 0; i--) pending.push(element.children[i]);
      const cssBoxPaint = !clear(s.backgroundColor) || ["Top", "Right", "Bottom", "Left"].some((side) =>
        parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none");
      if (cssBoxPaint) {
        const box = element.getBoundingClientRect();
        if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) return null;
        pieces.push({ element, css: true, rect: box });
        left = Math.min(left, box.left); top = Math.min(top, box.top);
        right = Math.max(right, box.right); bottom = Math.max(bottom, box.bottom);
      }
      if (!graphic.test(tag)) continue;
      // A differing pseudo style leaves the source paint unproven even if
      // the element's own fill is transparent. Do not prune that uncertainty.
      if (/^(?:text|tspan)$/.test(tag) && !svgTextPseudoSafe(element, s)) return null;
      const noFill = s.fill === "none" || clear(s.fill) || Number(s.fillOpacity) === 0;
      const noStroke = s.stroke === "none" || clear(s.stroke) || Number(s.strokeOpacity) === 0 || parseFloat(s.strokeWidth) === 0;
      if ((tag === "line" || noFill) && noStroke) continue;
      let box, matrix;
      try { box = element.getBBox(); matrix = element.getScreenCTM(); } catch { return null; }
      // Chrome 156 SVG text object bounds union TextInkBounds with the text
      // cell in FragmentItem::ObjectBoundingBox; the upstream LayoutSVGText
      // comment about omitting ink overflow does not describe that leaf code.
      // Legacy SVGMatrix lacks is2D, so the full ancestor checks above matter.
      if (!matrix || matrix.is2D === false
        || ![box.x, box.y, box.width, box.height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)
        || box.width < 0 || box.height < 0) return null;
      let extent = 0;
      if (!noStroke) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)px$/.test(s.strokeWidth)
          || !/^(?:miter|miter-clip|round|bevel)$/.test(s.strokeLinejoin)
          || !/^(?:butt|round|square)$/.test(s.strokeLinecap)) return null;
        const width = parseFloat(s.strokeWidth), miter = Number(s.strokeMiterlimit);
        if (!Number.isFinite(width) || width < 0 || !Number.isFinite(miter) || miter < 1) return null;
        // A line has caps but no joins. Other paths retain the conservative
        // full-width miter bound; dashes cannot enlarge an undashed stroke.
        extent = tag === "line" ? width / 2 * (s.strokeLinecap === "square" ? Math.SQRT2 : 1) : width * Math.max(1, miter);
      }
      const piece = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const [x, y] of [
        [box.x - extent, box.y - extent], [box.x + box.width + extent, box.y - extent],
        [box.x - extent, box.y + box.height + extent], [box.x + box.width + extent, box.y + box.height + extent],
      ]) {
        const px = matrix.a * x + matrix.c * y + matrix.e,
          py = matrix.b * x + matrix.d * y + matrix.f;
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        piece.left = Math.min(piece.left, px); piece.top = Math.min(piece.top, py);
        piece.right = Math.max(piece.right, px); piece.bottom = Math.max(piece.bottom, py);
        left = Math.min(left, px); top = Math.min(top, py);
        right = Math.max(right, px); bottom = Math.max(bottom, py);
      }
      pieces.push({ element, css: false, rect: piece, matrix });
    }
    svgPaintEvidence.set(root, pieces);
    if (left === Infinity) return { left: frame.left, top: frame.top, right: frame.left, bottom: frame.top };
    const margin = 2 * Math.max(1, 1 / viewport.scale);
    return { left: left - margin, top: top - margin, right: right + margin, bottom: bottom + margin };
  };
  // TextMetrics uses the primary font even for an empty string. Its top
  // and bottom baselines bracket raw ascent without trusting an OpenType
  // BASE table: top = ascent - normalizedAscent, bottom = ascent +
  // normalizedDescent. Both normalized terms are nonnegative in Blink.
  const decorationFonts = new Map();
  // These settings can select/scale a different primary font or are not
  // represented by the supported Canvas description. Shaping features and
  // numeric variants are deliberately absent: Blink applies them to glyph
  // runs after selecting SimpleFontData, not to its primary font metrics.
  const decorationMetricDefaults = [
    ["font-size-adjust", "none"], ["font-optical-sizing", "auto"], ["font-palette", "normal"],
    ["font-variation-settings", "normal"], ["font-language-override", "normal"], ["font-kerning", "auto"],
    ["font-variant-caps", "normal"], ["font-variant-position", "normal"], ["font-variant-emoji", "normal"],
    ["font-variant-east-asian", "normal"], ["font-variant-ligatures", "normal"], ["font-variant-alternates", "normal"],
    ["font-synthesis-weight", "auto"], ["font-synthesis-style", "auto"], ["font-synthesis-small-caps", "auto"],
  ];
  const decorationFontProperties = [
    "font-family", "font-size", "font-weight", "font-stretch", "font-style", "-webkit-locale", "text-rendering",
    ...decorationMetricDefaults.map(([key]) => key),
  ];
  const decorationAscent = (element, s) => {
    if (pageZoom !== 1 || element.getRootNode() !== document
      || !["normal", "italic"].includes(s.fontStyle)
      || decorationMetricDefaults.some(([key, value]) => s.getPropertyValue(key) !== value)) return null;
    // CSS text serialization rounds numbers (e.g. 16.123456 -> 16.1235).
    // Typed OM retains the used float values needed for a matching Font.
    const typed = element.computedStyleMap(), size = typed.get("font-size"),
      weight = typed.get("font-weight"), stretch = typed.get("font-stretch");
    if (size?.unit !== "px" || weight?.unit !== "number" || stretch?.unit !== "percent"
      || ![size.value, weight.value, stretch.value].every(Number.isFinite)) return null;
    const stretches = { 50: "ultra-condensed", 62.5: "extra-condensed", 75: "condensed", 87.5: "semi-condensed", 100: "normal",
      112.5: "semi-expanded", 125: "expanded", 150: "extra-expanded", 200: "ultra-expanded" },
      stretchName = stretches[stretch.value];
    if (!stretchName) return null;
    const font = `${s.fontStyle} ${weight.value}${stretchName === "normal" ? "" : " " + stretchName} ${size.value}px ${s.fontFamily}`,
      locale = s.getPropertyValue("-webkit-locale"), key = JSON.stringify([font, locale, s.textRendering]);
    if (decorationFonts.has(key)) return decorationFonts.get(key);
    decorationFonts.set(key, null);
    let bounds = null;
    try {
      // A detached HTML canvas uses this document's FontSelector. The
      // explicit metric description above stays valid when glyph-only
      // feature settings make the CSS font shorthand empty.
      // FontFaceSet.check scans every listed family, including unloaded
      // fallbacks that primary selection never reaches. Measure the native
      // primary font instead; a load started here synchronously changes the
      // FontFaceSet status and invalidates the metric proof below.
      if (!CSS.supports("font", font)) return null;
      const context = document.createElement("canvas").getContext("2d");
      if (!context || !("lang" in context)) return null;
      if (locale === "auto") context.lang = "inherit";
      else {
        const language = JSON.parse(locale);
        if (typeof language !== "string") return null;
        context.lang = language;
      }
      context.font = font;
      context.textRendering = s.textRendering;
      context.textBaseline = "top";
      const top = context.measureText("");
      context.textBaseline = "bottom";
      const bottom = context.measureText("");
      const lower = top.fontBoundingBoxAscent, upper = bottom.fontBoundingBoxAscent;
      if ([lower, upper, top.fontBoundingBoxDescent, bottom.fontBoundingBoxDescent].every(Number.isFinite)
        && upper > lower && Math.max(Math.abs(lower), Math.abs(upper)) < 2 ** 23
        && document.fonts.status === "loaded") {
        // Canvas alone keeps fractional metrics for tiny fonts. DOM rounds
        // by <= .5px; platform ascent borrowing / the macOS family adjustment
        // can add one further pixel. Outward float32 subtraction error is
        // included before converting to the integer metrics used by HTML.
        const floatError = (value) => Math.max(2 ** -150, 2 ** (Math.floor(Math.log2(Math.abs(value))) - 24));
        bounds = {
          size: size.value,
          lower: Math.floor(lower - floatError(lower) - 1.5),
          upper: Math.ceil(upper + floatError(upper) + 1.5),
        };
      }
    } catch { /* A font description without a matching metric proof stays unknown. */ }
    decorationFonts.set(key, bounds);
    return bounds;
  };
  // Solid underlines have finite inline support. A proved primary-font
  // interval also bounds their vertical position; otherwise keep only the
  // horizontal strip, rather than inventing viewport-wide ink.
  const decorationStrips = (element, s) => {
    const selected = getSelection();
    if (selected && !selected.isCollapsed && selected.containsNode(element, true)) return null;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || s.textDecorationLine !== "underline"
      || s.textDecorationStyle !== "solid" || s.writingMode !== "horizontal-tb"
      || !["inline", "inline-block", "block"].includes(s.display)
      || s.verticalAlign !== "baseline" || s.dominantBaseline !== "auto"
      || composedChildren(element).some((node) => node.nodeType === Node.ELEMENT_NODE)) return null;
    const inset = s.getPropertyValue("text-decoration-inset");
    if (inset && inset !== "auto" && !inset.split(/\s+/).every((value) => /^(?:\d+(?:\.\d*)?|\.\d+)(?:px|%)?$/.test(value))) return null;
    for (let ancestor = element; ancestor; ancestor = parentOf(ancestor)) {
      const a = style(ancestor);
      if (effects.some((key) => nonNone(a, key)) || a.transformStyle !== "flat"
        || !["1", "normal"].includes(a.zoom) || a.textEmphasisStyle !== "none"
        || a.textShadow !== "none" || parseFloat(a.webkitTextStrokeWidth) > 0
        || a.writingMode !== "horizontal-tb" || a.dominantBaseline !== "auto"
        || !["", "none"].includes(a.getPropertyValue("text-fit"))
        || !["", "none"].includes(a.getPropertyValue("text-box-trim"))
        || !["", "normal"].includes(a.getPropertyValue("initial-letter"))
        || a.textCombineUpright !== "none" || a.textOverflow !== "clip"
        || ancestor !== element && a.textDecorationLine !== "none") return null;
      for (const pseudo of ["::first-line", "::first-letter"]) {
        const p = getComputedStyle(ancestor, pseudo);
        if (p.textDecorationLine !== "none" || [...decorationFontProperties, ...effects, "text-underline-offset", "text-decoration-thickness",
          "vertical-align", "text-shadow", "text-emphasis-style", "-webkit-text-stroke-width", "outline-style", "outline-width",
          "outline-offset", "box-shadow", "initial-letter", "text-box-trim", "text-fit", "dominant-baseline"]
          .some((key) => p.getPropertyValue(key) !== a.getPropertyValue(key))) return null;
      }
    }
    for (const pseudo of ["::before", "::after"]) {
      const p = getComputedStyle(element, pseudo);
      if (p.content && !["none", "normal"].includes(p.content) && !emptyPseudo(p)) return null;
    }
    const rects = [];
    for (const node of composedChildren(element)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.length) continue;
      // Generated discretionary hyphens can extend a selected DOM run.
      if (node.nodeValue.includes("\u00ad") || s.hyphens === "auto") return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
    }
    // One LayoutUnit and one device pixel bound layout conversion and the
    // raster cells touched by an otherwise untransformed solid rectangle.
    const pixel = 1 / viewport.scale, inlineMargin = 1 / 64 + pixel;
    const strips = rects.map((rect) => ({ left: rect.left - inlineMargin, right: rect.right + inlineMargin, top: 0, bottom: viewport.height }));
    const typed = element.computedStyleMap(), offset = typed.get("text-underline-offset"),
      thickness = typed.get("text-decoration-thickness"),
      autoOffset = offset?.value === "auto", autoThickness = thickness?.value === "auto";
    if (s.textUnderlinePosition !== "auto" || !autoOffset && offset?.unit !== "px"
      || !autoThickness && thickness?.unit !== "px") return strips;
    const ascent = decorationAscent(element, s);
    if (!ascent) return strips;
    const roundAway = (value) => value < 0 ? -Math.round(-value) : Math.round(value),
      resolvedThickness = Math.max(1, autoThickness ? Math.fround(ascent.size / 10) : roundAway(Math.fround(thickness.value))),
      lineOffset = autoOffset ? Math.max(1, Math.ceil(resolvedThickness / 2)) : roundAway(Math.fround(offset.value));
    // Stay inside float32 pixel precision and the renderer's integer offset
    // domain; clamped/overflowing metrics cannot certify a finite rectangle.
    if (![lineOffset, resolvedThickness, ...rects.flatMap((rect) => [rect.top, rect.bottom, rect.left, rect.right])]
      .every((value) => Number.isFinite(value) && Math.abs(value) < 2 ** 23)
      || Math.max(Math.abs(ascent.lower + lineOffset), Math.abs(ascent.upper + lineOffset)) >= 2 ** 23) return strips;
    // Decorating-box fixed ascent vs integer text ascent differs by <= .5px
    // plus one LayoutUnit. Text painting can align its line origin by another
    // .5px. These are renderer rounding bounds, not font-size heuristics.
    const blockMargin = 1 + 1 / 64 + pixel;
    return rects.map((rect) => ({
      left: rect.left - inlineMargin,
      right: rect.right + inlineMargin,
      top: Math.floor(rect.top + ascent.lower + lineOffset + .5) - blockMargin,
      bottom: Math.floor(rect.top + ascent.upper + lineOffset + .5) + Math.max(1, Math.floor(resolvedThickness)) + blockMargin,
    }));
  };
  const decorationContent = new Map();
  const hasDecorationContent = (element) => {
    if (decorationContent.has(element)) return decorationContent.get(element);
    const pending = [element];
    let found = false;
    while (pending.length && !found) {
      const current = pending.pop();
      // HTML line decoration does not propagate through replaced content.
      // That content's own painting remains independently represented below.
      if (current !== element && (current.namespaceURI === "http://www.w3.org/2000/svg" && current.localName === "svg"
        || current.namespaceURI === "http://www.w3.org/1999/xhtml" && /^(?:img|input|textarea|select|canvas|video|audio|iframe|object|embed)$/.test(current.localName))) continue;
      if (current.namespaceURI !== "http://www.w3.org/1999/xhtml" || markerPaint(current, style(current))) { found = true; break; }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(current, pseudo).content;
        if (content && !["none", "normal", '""'].includes(content)) { found = true; break; }
      }
      for (const child of composedChildren(current)) {
        if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.length) { found = true; break; }
        if (child.nodeType === Node.ELEMENT_NODE) pending.push(child);
      }
    }
    decorationContent.set(element, found);
    return found;
  };
  const clippedSvgs = new Set();
  for (const element of elements) {
    if (element.namespaceURI === "http://www.w3.org/2000/svg") {
      let ancestor = composedParent(element),
        enclosed = false;
      while (ancestor) {
        if (clippedSvgs.has(ancestor)) {
          enclosed = true;
          break;
        }
        ancestor = composedParent(ancestor);
      }
      if (enclosed) continue;
    }
    const s = style(element),
      rect = element.getBoundingClientRect();
    if (hiddenTree(element) || s.visibility !== "visible") continue;

    const svgInk = svgPaintBounds(element);
    if (svgInk) {
      clippedSvgs.add(element);
      const ancestorClip = paintAncestorClip(element);
      let paintRect = clippedSvg(element, s) ? intersect(svgInk, rect) : svgInk;
      if (ancestorClip) paintRect = intersect(paintRect, ancestorClip);
      if (overlaps(paintRect, viewportRect)) addCover({ element, rect: paintRect, path: paintPath(element) });
      continue;
    }
    // An independently proven viewport clip also bounds unsupported SVG ink.
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

    const directTextNodes = composedChildren(element).filter((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim());
    const directText = directTextNodes.length > 0;
    const textRects = [];
    for (const node of directTextNodes) {
      const range = document.createRange();
      range.selectNodeContents(node);
      textRects.push(...range.getClientRects());
    }
    const foregroundEffect = s.outlineStyle !== "none",
      shadowEffect = s.boxShadow !== "none";
    const shadowRect = shadowEffect ? shadowBounds(element, s, rect) : null;
    const decorated = s.textDecorationLine !== "none" && hasDecorationContent(element);
    const underline = decorated ? decorationStrips(element, s) : null;
    const unknownDecoration = decorated && !underline;
    const unbounded =
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      markerPaint(element, s) ||
      foregroundEffect ||
      (shadowEffect && !shadowRect) ||
      nonNone(s, "-webkit-box-reflect") ||
      s.borderImageOutset !== "0" ||
      unknownDecoration ||
      s.textEmphasisStyle !== "none" ||
      (directText && (s.textShadow !== "none" || parseFloat(s.webkitTextStrokeWidth) > 0 || unknownDecoration)) ||
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
      addCover({
        element,
        rect: viewportRect,
        path,
        foregroundEffect,
        directText,
      });
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
        addCover({
          element,
          rect: shadowRect || rect,
          path,
          directText: false,
        });
      for (const textRect of textRects) addCover({ element, rect: textRect, path, directText: true });
      for (const line of underline || []) addCover({ element, rect: line, path, foregroundEffect: true });
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
      /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|%)$/i.test(value) ? parseFloat(value) * (value.endsWith("%") ? size / 100 : 1) : NaN;
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
  // An opaque fill cuts off earlier background colors, but not the opacity
  // of the group containing that fill and its glyphs. Cache the complete
  // painting-ancestor chain before allowing the color lookup to stop early.
  const backgroundGroups = new Map();
  const backgroundGroup = (parent) => {
    const pending = [];
    let current = parent;
    while (current && !backgroundGroups.has(current)) { pending.push(current); current = parentOf(current); }
    let proof = current ? backgroundGroups.get(current) : { unattenuated: true, unclipped: true };
    while (pending.length) {
      const element = pending.pop(), s = style(element);
      proof = {
        unattenuated: proof.unattenuated && Number(s.opacity) === 1 && s.mixBlendMode === "normal",
        unclipped: proof.unclipped && s.overflowX === "visible" && s.overflowY === "visible"
          && s.clip === "auto" && s.clipPath === "none" && s.maskImage === "none"
          && s.getPropertyValue("-webkit-mask-box-image-source") === "none",
      };
      backgroundGroups.set(element, proof);
    }
    return proof;
  };
  const background = (parent, rects) => {
    if (!backgroundGroup(parent).unattenuated) return null;
    // A negative context paints before ordinary ancestor backgrounds, but
    // after its own context owner's background. Index the glyph's context
    // path once; a higher descendant cannot escape an enclosing negative
    // context to turn those later backgrounds into an earlier backdrop.
    const glyphScopes = new Map();
    let child = null;
    for (let path = stack(parent); path; path = path.parent) {
      glyphScopes.set(path, child);
      child = path;
    }
    glyphScopes.set(null, child);
    const layers = [];
    const rootStyle = style(document.documentElement);
    const bodyCanvas = rootStyle.backgroundImage === "none" && clear(rootStyle.backgroundColor);
    for (let element = parent; element; element = parentOf(element)) {
      const s = style(element);
      if (s.backgroundImage !== "none" || s.borderImageSource !== "none") return null;
      if (insetShadowRisk(s.boxShadow)) return null;
      const border = ["Top", "Right", "Bottom", "Left"].some(
        (side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none",
      );
      const transparent = clear(s.backgroundColor);
      if (transparent && !border && s.boxShadow === "none") continue;
      // HTML root backgrounds paint the document canvas. When the root has
      // no background, the body background is propagated to that canvas.
      // Other boxes do not paint outside their own border rectangles.
      const canvas = element === document.documentElement || element === document.body && bodyCanvas;
      if (!canvas) {
        const borders = [...element.getClientRects()];
        if (s.boxShadow === "none" && rects.every((r) => borders.every((box) => !overlaps(r, box)))) continue;
        const boxes = borders.map((box) => paddingShape(s, box));
        if (!rects.every((r) => boxes.some((box) => insideShape(r, box)))) return null;
      }
      if (transparent) continue;
      const color = rgba(s.backgroundColor);
      if (!color || s.backgroundClip !== "border-box") return null;
      if (!canvas) {
        const scope = stack(element), glyph = glyphScopes.get(scope);
        if (!glyphScopes.has(scope) || glyph && glyph.level !== null && glyph.level < 0 && element !== scope?.owner) return null;
      }
      // The glyph may escape an overflow clip that still removes this
      // static background. Verify the background's own painting path, not
      // the descendant glyph's path, before treating it as known ground.
      // Its own overflow does not clip its fill; ancestor clips still do.
      if (!canvas && !backgroundGroups.get(element).unclipped && clippedRects(element, rects, true)) return null;
      layers.push(s.backgroundColor);
      if (color[3] === 255) return layers.reverse();
    }
    for (let element = parent; element; element = parentOf(element)) if (topLayerSet.has(element)) return null;
    // The normal/light HTML canvas is white when neither root nor body
    // supplies a background. Other UA color schemes have no proof here.
    return /^(?:normal|light)$/.test(style(document.documentElement).colorScheme) ? ["white", ...layers.reverse()] : null;
  };
  const effectCoverage = (s, rect, rects) => {
    if (primitives?.version === 2 && typeof primitives.effectCoverage === "function") return primitives.effectCoverage(s, rect, rects);
    return ["mask-image", "clip-path"].every((key) => !s.getPropertyValue(key) || s.getPropertyValue(key) === "none")
      ? "complete"
      : "unknown";
  };
  const containingBlocks = new Map();
  const containingBlock = (element, kind) => {
    if (!containingBlocks.has(element)) {
      const s = style(element), box = s.display !== "none" && s.display !== "contents";
      const replaced = /^(?:input|textarea|select|img|canvas|video|audio|iframe|object|embed)$/.test(element.localName);
      const boxKind = !box || s.display === "inline" && !replaced ? "no"
        : replaced || /^(?:block|flow-root|flex|grid|inline-block|inline-flex|inline-grid|(?:inline )?(?:flow-root )?list-item)$/.test(s.display) ? "yes" : "unknown";
      const hints = s.willChange.split(",").map((name) => name.trim()).filter((name) => CSS.supports(name, "initial"))
        .map((name) => name.replace(/^-webkit-/, ""));
      const transformHints = /^(?:transform|perspective|transform-style|translate|scale|rotate|offset|offset-path|offset-position)$/;
      const textControl = element.localName === "textarea" || element.localName === "input"
        && /^(?:text|search|url|tel|email|password|number)$/.test(element.type);
      const transformed = ["transform", "translate", "rotate", "scale", "perspective", "offset-path"].some((key) => nonNone(s, key))
        || !["", "normal", "none", "auto"].includes(s.getPropertyValue("offset-position"))
        || s.transformStyle === "preserve-3d" || hints.some((name) => transformHints.test(name));
      const containment = /\b(?:layout|paint|strict|content)\b/.test(s.contain) || s.contentVisibility !== "visible" || hints.includes("contain");
      let fixed = box && (textControl || boxKind === "yes" && (transformed || containment)
        || element !== document.documentElement && (nonNone(s, "filter") || nonNone(s, "backdrop-filter")
          || hints.includes("filter") || hints.includes("backdrop-filter"))) ? "yes" : "no";
      if (fixed === "no" && boxKind === "unknown" && (transformed || containment)) fixed = "unknown";
      if (fixed === "no" && boxKind !== "no") {
        try {
          const related = new Set(["transform", "translate", "rotate", "scale", "perspective", "transformStyle", "offsetPath", "offsetPosition"]);
          if (element.getAnimations().some((animation) => animation.effect?.target === element && !animation.effect.pseudoElement
            && animation.effect.getKeyframes().some((frame) => Object.keys(frame).some((key) => related.has(key))))) fixed = "unknown";
        } catch { fixed = "unknown"; }
      }
      const absolute = box && (/^(?:relative|absolute|fixed|sticky)$/.test(s.position) || hints.includes("position")) ? "yes" : fixed;
      containingBlocks.set(element, { absolute, fixed });
    }
    return containingBlocks.get(element)[kind];
  };
  const svgViewports = new Map();
  const svgViewport = (element) => {
    if (svgViewports.has(element)) return svgViewports.get(element);
    const s = style(element);
    let result = null;
    if ([s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft,
      s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].every((value) => parseFloat(value) === 0)
      && /^(?:0(?:px|%)?\s*)+$/.test(s.borderRadius) && !nonNone(s, "border-shape")
      && s.overflowClipMargin === "0px") {
      if (element.parentElement?.namespaceURI === "http://www.w3.org/1999/xhtml") result = element.getBoundingClientRect();
      else if (element.parentElement instanceof SVGElement && element.viewBox.animVal.width === 0 && element.viewBox.animVal.height === 0) {
        // A nested SVG's client box bounds its ink, not its viewport. Without
        // a viewBox, its native screen matrix maps the declared viewport.
        const matrix = element.getScreenCTM(), width = element.width.animVal.value, height = element.height.animVal.value;
        if (matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, width, height].every(Number.isFinite)
          && matrix.a === 1 && matrix.d === 1 && matrix.b === 0 && matrix.c === 0 && width >= 0 && height >= 0
          && /^\d+(?:\.\d+)?px$/.test(s.width) && /^\d+(?:\.\d+)?px$/.test(s.height)
          && parseFloat(s.width) === width && parseFloat(s.height) === height)
          result = { left: matrix.e, top: matrix.f, right: matrix.e + width, bottom: matrix.f + height };
      }
    }
    svgViewports.set(element, result);
    return result;
  };
  const clippedRects = (parent, rects, surfaceBox = false) => {
    let uncertain = null, escape = null;
    for (let element = parent; element; element = parentOf(element)) {
      const s = style(element),
        rect = element.getBoundingClientRect();
      const coverage = effectCoverage(s, rect, rects);
      if (coverage === "empty") return "hidden";
      if (coverage !== "complete") uncertain ||= "effect-coverage";
      // Overflow clips descendants, not the control's own border/background.
      // Absolute descendants escape overflow between themselves and their
      // containing block. Fixed descendants escape ordinary ancestor overflow.
      const generatesBox = s.display !== "contents" && s.display !== "none";
      if (escape) {
        const boundary = containingBlock(element, escape);
        if (boundary === "yes") escape = null;
        else if (boundary === "unknown") uncertain ||= "clip-coverage";
      }
      const skipOverflow = escape || surfaceBox && element === parent;
      if (generatesBox && s.position === "fixed") escape = "fixed";
      else if (generatesBox && s.position === "absolute" && !escape) escape = "absolute";
      if (skipOverflow) continue;
      if (element instanceof SVGSVGElement && (s.overflowX !== "visible" || s.overflowY !== "visible")) {
        const viewport = svgViewport(element);
        if (!viewport) { uncertain ||= "clip-coverage"; continue; }
        if (rects.every((r) => s.overflowX !== "visible" && (r.right <= viewport.left || r.left >= viewport.right)
          || s.overflowY !== "visible" && (r.bottom <= viewport.top || r.top >= viewport.bottom))) return "hidden";
        if (rects.some((r) => s.overflowX !== "visible" && (r.left < viewport.left || r.right > viewport.right)
          || s.overflowY !== "visible" && (r.top < viewport.top || r.bottom > viewport.bottom))) uncertain ||= "clip-coverage";
        continue;
      }
      // Non-replaced inline/contents boxes do not apply overflow clipping.
      if (!generatesBox || s.display === "inline") continue;
      if (!/^(?:block|flow-root|flex|grid|inline-block|inline-flex|inline-grid|list-item|table-cell|table-caption)$/.test(s.display)) {
        if (s.overflowX !== "visible" || s.overflowY !== "visible") uncertain ||= "clip-coverage";
        continue;
      }
      const rootStyle = style(document.documentElement);
      if (element === document.documentElement || element === document.body && rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible") {
        // Root/body overflow can propagate to the viewport, rather than clip
        // at a zero-height root containing only positioned descendants.
        continue;
      }
      const left = rect.left + parseFloat(s.borderLeftWidth),
        top = rect.top + parseFloat(s.borderTopWidth);
      const right = rect.right - parseFloat(s.borderRightWidth),
        bottom = rect.bottom - parseFloat(s.borderBottomWidth);
      const exactX = (s.overflowX === "hidden" || s.overflowX === "clip") && s.scrollbarGutter === "auto";
      const exactY = (s.overflowY === "hidden" || s.overflowY === "clip") && s.scrollbarGutter === "auto";
      const clipRight = exactX ? right : Math.min(right, rect.left + element.clientLeft + element.clientWidth);
      const clipBottom = exactY ? bottom : Math.min(bottom, rect.top + element.clientTop + element.clientHeight);
      if ((s.overflowX === "clip" || s.overflowY === "clip") && s.overflowClipMargin !== "0px") {
        const contentBox = /^(?:content-box(?: 0px)?|0px content-box)$/.test(s.overflowClipMargin)
          && [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].every((value) => parseFloat(value) === 0);
        if (!contentBox) { uncertain ||= "clip-coverage"; continue; }
      }
      // A complete exclusion is stronger evidence than an earlier uncertain
      // mask or background. Never turn fully clipped carousel clones into rows.
      if (rects.every((r) => s.overflowX !== "visible" && (r.right <= left || r.left >= clipRight)
        || s.overflowY !== "visible" && (r.bottom <= top || r.top >= clipBottom))) return "hidden";
      const interior = roundedInterior(element, s, rect);
      if (interior === false) { uncertain ||= "clip-coverage"; continue; }
      for (const r of rects)
        if (
          (s.overflowX !== "visible" && (r.left < left || r.right > clipRight)) ||
          (s.overflowY !== "visible" && (r.top < top || r.bottom > clipBottom)) ||
          (interior && !insideShape(r, interior))
        )
          uncertain ||= "clip-coverage";
    }
    return uncertain;
  };
  const foreignCover = (parent, rects, presence = false) =>
    covers.some(
      ({ element, rect, path, foregroundEffect, directText }) =>
        !(presence && paintContains(parent, element)) &&
        (!paintContains(element, parent) || foregroundEffect || (directText && element !== parent)) &&
        rects.some((r) => overlaps(r, rect)) &&
        !strictlyAbove(stack(parent), path),
    );
  for (const element of topLayers) {
    const p = getComputedStyle(element, "::backdrop");
    if (!clear(p.backgroundColor) || p.backgroundImage !== "none" || p.filter !== "none" || p.backdropFilter !== "none") {
      const path = appendContext(null, p, 0);
      path.topLayer = element;
      covers.push({ element, rect: viewportRect, path });
    }
  }
  for (const slot of unsupportedSlots) if (!hiddenTree(slot) && style(slot).visibility === "visible") {
    let owner = slot;
    while (owner && !(owner.getBoundingClientRect().width > 0 && owner.getBoundingClientRect().height > 0)) owner = composedParent(owner);
    gap("slotted-content", slot, owner?.getBoundingClientRect());
  }
  const unionBox = (rects) => {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const rect of rects) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return [left, top, right - left, bottom - top];
  };
  const candidates = [];
  const selection = getSelection();
  const boundedText = new Map();
  const boundedTextClip = (parent) => {
    const pending = [];
    let current = parent;
    while (current && !boundedText.has(current)) { pending.push(current); current = parentOf(current); }
    let bounded = current ? boundedText.get(current) : true;
    while (pending.length) {
      const element = pending.pop(), s = style(element);
      const simpleInk = (v) => v.textShadow === "none" && parseFloat(v.webkitTextStrokeWidth) === 0 && v.textEmphasisStyle === "none"
        && v.textDecorationLine === "none" && safeClipChain(v)
        && effects.every((key) => key === "mask-image" || key === "clip-path" || noGeometryEffect(v, key));
      bounded = bounded && element.namespaceURI === "http://www.w3.org/1999/xhtml" && simpleInk(s)
        && ["::first-line", "::first-letter"].every((pseudo) => simpleInk(getComputedStyle(element, pseudo)));
      boundedText.set(element, bounded);
    }
    return bounded;
  };
  // Reuse the same per-graphic ink evidence for simple SVG text. A parent
  // text/tspan's aggregate box is not foreign ink when it has no direct text;
  // all other intersecting graphics remain uncertain regardless of draw order.
  const svgTextProof = (node, parent) => {
    if (!/^(?:text|tspan)$/.test(parent.localName) || parent.children.length
      || [...parent.childNodes].filter((item) => item.nodeType === Node.TEXT_NODE && item.nodeValue).length !== 1) return null;
    // Start with an explicit LTR text subset; unsupported scripts and bidi
    // controls retain unknown regions instead of implying a glyph order.
    if (!/^[\x09\x0a\x0c\x0d\x20-\x7e\u00a0\p{Unified_Ideograph}]*$/u.test(node.nodeValue)
      || selection?.rangeCount && selection.containsNode(node, true)) return null;
    let root = parent;
    while (root && !svgPaintEvidence.has(root)) root = parentOf(root);
    if (!root) return null;
    const s = style(parent), fill = rgba(s.fill);
    if (s.stroke !== "none") return null;
    const hiddenFill = s.fill === "none" || fill?.[3] === 0 || Number(s.fillOpacity) === 0;
    if (!hiddenFill && (!fill || fill[3] !== 255 || Number(s.fillOpacity) !== 1)) return null;
    for (let element = parent; element instanceof SVGElement; element = parentOf(element)) {
      const v = style(element);
      if (v.display === "none" || v.visibility !== "visible" || v.contentVisibility !== "visible"
        || v.contain !== "none" || Number(v.opacity) !== 1 || v.mixBlendMode !== "normal"
        || v.direction !== "ltr" || v.unicodeBidi !== "normal" || v.writingMode !== "horizontal-tb"
        || effects.some((key) => !noGeometryEffect(v, key)) || v.clip !== "auto"
        || v.textDecorationLine !== "none" || v.textEmphasisStyle !== "none" || v.textShadow !== "none"
        || parseFloat(v.webkitTextStrokeWidth) !== 0 || !["1", "normal"].includes(v.zoom)) return null;
      if (element.hasAttribute("textLength") || element.hasAttribute("lengthAdjust") || element.hasAttribute("rotate")) return null;
      if (element !== parent && /^(?:text|tspan)$/.test(element.localName)
        && [...element.childNodes].some((item) => item.nodeType === Node.TEXT_NODE && item.nodeValue?.trim())) return null;
      if (!svgTextPseudoSafe(element, v)) return null;
      if (/^(?:text|tspan)$/.test(element.localName)) {
        // Per-character positioning and unusual spacing can rearrange glyphs
        // while leaving the element's screen matrix a pure translation.
        if (!["normal", "0px"].includes(v.letterSpacing) || !["normal", "0px"].includes(v.wordSpacing)) return null;
        for (const name of ["x", "y", "dx", "dy"])
          if (!Number.isInteger(element[name]?.animVal?.numberOfItems) || element[name].animVal.numberOfItems > 1) return null;
        if (element.rotate?.animVal?.numberOfItems !== 0) return null;
      }
    }
    if (hiddenFill) return { hidden: true };
    const pieces = svgPaintEvidence.get(root), own = pieces.find((piece) => piece.element === parent && !piece.css);
    if (!own || !(own.rect.right > own.rect.left && own.rect.bottom > own.rect.top)) return null;
    const matrix = own.matrix;
    if (!matrix || matrix.a !== 1 || matrix.d !== 1 || matrix.b !== 0 || matrix.c !== 0) return null;
    const margin = 2 * Math.max(1, 1 / viewport.scale);
    for (const piece of pieces) {
      if (piece.element === parent) continue;
      if (paintContains(piece.element, parent) && (piece.css || /^(?:text|tspan)$/.test(piece.element.localName))) continue;
      const rect = { left: piece.rect.left - margin, top: piece.rect.top - margin,
        right: piece.rect.right + margin, bottom: piece.rect.bottom + margin };
      if (overlaps(own.rect, rect)) return null;
    }
    return { rect: { ...own.rect, x: own.rect.left, y: own.rect.top,
      width: own.rect.right - own.rect.left, height: own.rect.bottom - own.rect.top } };
  };
  for (const node of textNodes) {
    const parent = composedParent(node), rawText = node.nodeValue;
    if (!parent || !rawText || hiddenTree(parent)) continue;
    const s = style(parent);
    if (s.visibility !== "visible" || !(parseFloat(s.fontSize) > 0)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const svgText = parent instanceof SVGElement, svgProof = svgText ? svgTextProof(node, parent) : null;
    if (svgProof?.hidden) continue;
    const rects = svgProof ? [svgProof.rect] : [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length || !rects.some((r) => overlaps(r, viewportRect))) continue;
    const bounds = unionBox(rects), region = { left: bounds[0], top: bounds[1], width: bounds[2], height: bounds[3] };
    if (!svgText && !nativeOwners.has(node) && !(primitives?.version === 2 && primitives.textFlowCoverage(node, style, composedParent).coverage === "complete")) {
      gap("effect-coverage", node, region);
      continue;
    }
    const textPaint = svgText ? s.fill : s.webkitTextFillColor || s.color;
    if (!svgText && clear(textPaint)) {
      if (s.textShadow !== "none" || parseFloat(s.webkitTextStrokeWidth) > 0 || selection?.containsNode(node, true))
        gap("text-paint", node, region);
      continue;
    }
    if (s.textTransform !== "none" || s.webkitTextSecurity !== "none") {
      gap("text-paint", node, region);
      continue;
    }
    let valid = true;
    for (let element = parent; element; element = parentOf(element)) {
      if (!(svgProof && element instanceof SVGElement) && !uncomplicated(element)) {
        valid = false;
        break;
      }
    }
    if (!valid || (selection?.rangeCount && selection.containsNode(node, true))) {
      // Background or generated-content uncertainty does not make text
      // visible outside a proven clip. Expanding text effects and selections
      // cannot use this early exclusion.
      if (!(selection?.rangeCount && selection.containsNode(node, true)) && boundedTextClip(parent)
        && clippedRects(parent, rects) === "hidden") continue;
      gap("text-paint", node, region);
      continue;
    }
    if (!rects.every(inViewport)) {
      gap("clip-coverage", node, region);
      continue;
    }
    const clip = clippedRects(parent, rects);
    if (clip) {
      if (clip !== "hidden") gap(clip, node, region);
      continue;
    }
    const layers = background(parent, rects),
      ground = layers && composite(layers),
      ink = layers && composite([...layers, textPaint]);
    if (!ink || !ground) {
      gap("text-background", node, region);
      continue;
    }
    if (!ink.some((channel, index) => Math.abs(channel - ground[index]) >= 1)) continue;
    const text = renderedWhitespace(node, rawText, s);
    if (text === null || foreignCover(parent, rects)) {
      gap(text === null ? "text-whitespace" : "paint-occlusion", node, region);
      continue;
    }
    if (text) candidates.push({ node, text, rects, region });
  }
  const accepted = candidates.filter((item, i) => {
    const overlap = candidates.some((other, j) => j !== i && item.rects.some((a) => other.rects.some((b) => overlaps(a, b))));
    if (overlap) gap("text-overlap", item.node, item.region);
    return !overlap;
  });
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
  ]);
  const declaredRoles = new Set([
    ...interactiveRoles,
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "caption",
    "cell",
    "code",
    "columnheader",
    "complementary",
    "contentinfo",
    "definition",
    "dialog",
    "directory",
    "document",
    "feed",
    "figure",
    "form",
    "generic",
    "grid",
    "gridcell",
    "group",
    "heading",
    "img",
    "list",
    "listitem",
    "log",
    "main",
    "marquee",
    "math",
    "meter",
    "navigation",
    "note",
    "paragraph",
    "presentation",
    "progressbar",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "separator",
    "status",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
  ]);
  const roleCache = new Map();
  const asciiToken = (value) => (value || "").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const roleOf = (element) => {
    if (nativeOwners.has(element)) return null;
    if (roleCache.has(element)) return roleCache.get(element);
    const tag = element.localName,
      inputType = tag === "input" ? element.type : "";
    let role =
      tag === "button"
        ? "button"
        : tag === "a" && element.hasAttribute("href")
          ? "link"
          : tag === "select"
            ? element.multiple || element.size > 1
              ? "listbox"
              : "combobox"
            : tag === "textarea"
              ? "textbox"
              : tag === "input" && inputType !== "hidden"
                ? {
                    checkbox: "checkbox",
                    radio: "radio",
                    range: "slider",
                    number: "spinbutton",
                    search: "searchbox",
                    button: "button",
                    submit: "button",
                    reset: "button",
                    image: "button",
                    file: "button",
                    color: "ColorWell",
                    date: "Date",
                    month: "Date",
                    week: "Date",
                    "datetime-local": "DateTime",
                    time: "InputTime",
                  }[inputType] || "textbox"
                : tag === "summary" && element.parentElement?.localName === "details"
                  ? "button"
                  : null;
    const declaredRole = (element.getAttribute("role") || "").split(/[ \t\n\r\f]+/).map(asciiToken).find((value) => declaredRoles.has(value));
    if (declaredRole && declaredRole !== "presentation") role = declaredRole;
    if (!role) {
      if (!declaredRole)
        role =
          {
            main: "main",
            nav: "navigation",
            article: "article",
            aside: "complementary",
            p: "paragraph",
            pre: "paragraph",
            ul: "list",
            ol: "list",
            li: "listitem",
            table: "table",
            thead: "rowgroup",
            tbody: "rowgroup",
            tfoot: "rowgroup",
            tr: "row",
            th: element.scope === "row" ? "rowheader" : "columnheader",
            td: "cell",
            figure: "figure",
            figcaption: "caption",
            hr: "separator",
            img: "img",
            canvas: "img",
            progress: "progressbar",
            meter: "meter",
            audio: "Audio",
            video: "Video",
            iframe: "iframe",
            frame: "iframe",
          }[tag] || (/^h[1-6]$/.test(tag) ? "heading" : null);
      if (!role && element.isContentEditable && !element.parentElement?.isContentEditable) role = "textbox";
      if (!role && (element.hasAttribute("tabindex") || typeof element.onclick === "function" || element.hasAttribute("aria-haspopup")))
        role = "generic";
    }
    if (role === "paragraph") {
      for (let parent = composedParent(element); parent; parent = composedParent(parent))
        if (interactiveRoles.has(roleOf(parent))) { role = null; break; }
    }
    roleCache.set(element, role);
    return role;
  };
  // Native UI contributes paint evidence and field values, never a control's
  // author label. All strings below are read from these live roots in this task.
  const nativeValueBearing = (element) => /^(?:input|textarea|select|progress|meter)$/.test(element.localName)
    && !/^(?:checkbox|radio|button|submit|reset|hidden|image)$/.test(element.type || "");
  const nativePlaceholderBearing = (element) => element.localName === "textarea"
    || element.localName === "input" && /^(?:text|search|email|tel|url|password|number)$/.test(element.type);
  const nativeFields = new Map(), nativeAccepted = new Map(), consumedNativeText = new Set();
  for (const item of accepted) {
    const host = nativeOwners.get(item.node);
    if (!host) continue;
    const items = nativeAccepted.get(host) || [];
    items.push(item); nativeAccepted.set(host, items);
  }
  const nativeRequests = [], nativeObjects = [], nativeRequestHosts = [], nativeRequestParts = [];
  const selectRequests = [], selectObjects = [], selectRequestHosts = [], selectHosts = [];
  const liveNativeHosts = elements.filter((element) => !nativeOwners.has(element) && /^(?:input|textarea|select)$/.test(element.localName)
    && (nativeValueBearing(element) || nativePlaceholderBearing(element))
    && !hiddenTree(element) && style(element).visibility === "visible");
  for (const host of liveNativeHosts) {
    const rect = host.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0 && overlaps(rect, viewportRect)) || clippedRects(host, [rect], true) === "hidden") continue;
    const field = nativeValueBearing(host) ? { valueUnknown: true } : {};
    const expectedPlaceholder = nativePlaceholderBearing(host) && typeof host.placeholder === "string" ? host.placeholder : "";
    if (expectedPlaceholder && host.value === "") field.placeholder = { status: "unknown" };
    nativeFields.set(host, field);
    const root = nativeRootByHost.get(host);
    if (!root || shadowRoots.get(host) !== root || !root.isConnected || root.host !== host || root.ownerDocument !== document) {
      if (host.value || expectedPlaceholder && host.value === "" || host.localName === "select" && host.options.length)
        gap("native-root-missing", host, rect, roleOf(host) || undefined);
      continue;
    }
    const texts = nativeTextNodes.get(host) || [];
    if (expectedPlaceholder) {
      const placeholders = texts.filter((node) => node.parentElement?.getAttribute("pseudo") === "-webkit-input-placeholder");
      const text = placeholders.length === 1 ? placeholders[0] : null;
      let proof;
      try { if (typeof nativeProofs?.placeholder === "function") proof = nativeProofs.placeholder.call(host, text, expectedPlaceholder); } catch {}
      const acceptedPlaceholder = (nativeAccepted.get(host) || []).find((item) => item.node === text);
      if (proof?.status === "hidden") delete field.placeholder;
      else if (proof?.status === "visible" && proof.text === expectedPlaceholder && host.placeholder === expectedPlaceholder
        && acceptedPlaceholder?.text === expectedPlaceholder && text?.isConnected && text.getRootNode() === root) {
        field.placeholder = { status: "visible", text: proof.text };
        consumedNativeText.add(text);
      }
      else if (field.placeholder) gap("native-placeholder-unconfirmed", host, rect, roleOf(host) || undefined);
    }
    if (host.localName === "select") {
      selectHosts.push(host);
      const labels = texts.filter((node) => node.parentElement?.getAttribute("pseudo") === "-internal-select-inner-element");
      if (labels.length === 1 && host.selectedOptions.length === 1) {
        selectRequests.push({ expected: labels[0].data });
        selectObjects.push(labels[0], host.selectedOptions[0]); selectRequestHosts.push(host);
      }
    } else if (host.value && (host.localName === "textarea" || /^(?:text|search|email|tel|url)$/.test(host.type))) {
      const content = texts.filter((node) => node.parentElement?.getAttribute("pseudo") !== "-webkit-input-placeholder"
        && node.parentElement?.parentNode === root);
      const matches = host.localName === "textarea" ? content.filter((node) => node.data) : content.filter((node) => node.data === host.value);
      if (matches.length && (host.localName === "textarea" || matches.length === 1)) {
        nativeRequests.push({ expected: host.value }); nativeObjects.push(matches[0]); nativeRequestHosts.push(host);
        nativeRequestParts.push(content.filter((node) => node.data));
      }
    }
  }
  let nativeControlProof;
  if (nativeRequests.length || selectRequests.length || selectHosts.length) {
    try {
      if (typeof nativeProofs?.controls === "function") nativeControlProof = nativeProofs.controls.call(document,
        { native: nativeRequests, selects: selectRequests, selectHosts: selectHosts.map(() => ({})) }, true, !hasAuthorShadowRoots,
        ...nativeObjects, ...selectObjects, ...selectHosts);
    } catch {}
  }
  if (Array.isArray(nativeControlProof?.nativeValues) && nativeControlProof.nativeValues.length === nativeRequests.length)
    for (let index = 0; index < nativeRequests.length; index++) {
      const host = nativeRequestHosts[index], proof = nativeControlProof.nativeValues[index], expected = nativeRequests[index].expected;
      const items = nativeAccepted.get(host) || [];
      if (typeof proof?.text !== "string" || proof.text !== expected || host.value !== expected || !host.isConnected
        || !nativeRequestParts[index].every((node) => node.isConnected && node.getRootNode() === nativeRootByHost.get(host)
          && items.some((item) => item.node === node && item.text === node.data))) continue;
      const field = nativeFields.get(host); field.value = proof.text; delete field.valueUnknown;
      for (const node of nativeRequestParts[index]) consumedNativeText.add(node);
    }
  if (Array.isArray(nativeControlProof?.selectValues) && nativeControlProof.selectValues.length === selectRequests.length)
    for (let index = 0; index < selectRequests.length; index++) {
      const host = selectRequestHosts[index], proof = nativeControlProof.selectValues[index], text = selectObjects[index * 2], option = selectObjects[index * 2 + 1];
      if (typeof proof?.text !== "string" || proof.text !== selectRequests[index].expected || !host.isConnected
        || host.selectedOptions.length !== 1 || host.selectedOptions[0] !== option || !option.selected
        || !text.isConnected || text.getRootNode() !== nativeRootByHost.get(host)
        || !(nativeAccepted.get(host) || []).some((item) => item.node === text && item.text === proof.text)) continue;
      const field = nativeFields.get(host); field.selectedLabels = [proof.text]; delete field.valueUnknown;
      consumedNativeText.add(text);
    }
  if (Array.isArray(nativeControlProof?.selectStates) && nativeControlProof.selectStates.length === selectHosts.length)
    for (let index = 0; index < selectHosts.length; index++) {
      const host = selectHosts[index], state = nativeControlProof.selectStates[index];
      if (state && state.multiple === host.multiple && state.size === host.size && typeof state.open === "boolean"
        && state.open === host.matches(":open") && roleOf(host) === "combobox") nativeFields.get(host).expanded = state.open;
    }
  for (const [host, field] of nativeFields) if (field.valueUnknown && host.value)
    gap("native-value-unconfirmed", host, host.getBoundingClientRect(), roleOf(host) || undefined);
  for (const [host, items] of nativeAccepted) if (items.some((item) => !consumedNativeText.has(item.node)))
    gap("native-content-unconfirmed", host, host.getBoundingClientRect(), roleOf(host) || undefined);

  const semantic = new Set(),
    fragments = new Map();
  const labelRoles = new Set([...interactiveRoles, "heading", "paragraph", "caption", "code", "term", "definition", "listitem", "cell", "gridcell", "columnheader", "rowheader", "generic", "img"]);
  const claimedLabels = new Set();
  const ownerFor = (node) => {
    for (let element = composedParent(node); element; element = composedParent(element)) if (roleOf(element)) return element;
    return null;
  };
  for (const item of accepted) {
    if (nativeOwners.has(item.node)) continue;
    if (!item.text.trim() && !ownerFor(item.node)) continue;
    const owner = ownerFor(item.node);
    if (owner) semantic.add(owner);
    const owned = fragments.get(owner) || [];
    owned.push(item);
    fragments.set(owner, owned);
  }
  const unknownByOwner = new Map(), unknownLeaves = [];
  for (const [node, rect] of uncertainText) {
    const owner = ownerFor(node);
    if (owner) semantic.add(owner);
    if (owner && labelRoles.has(roleOf(owner))) {
      const regions = unknownByOwner.get(owner) || [];
      regions.push(rect); unknownByOwner.set(owner, regions);
    } else unknownLeaves.push({ node, owner, rect });
  }
  const rectTuple = (rect) => [rect.left, rect.top, rect.width, rect.height];
  const nativeControl = (element) => /^(?:button|input|textarea|select|summary|progress|meter)$/.test(element.localName);
  const surface = (element) => {
    const s = style(element),
      rect = element.getBoundingClientRect();
    if (!inViewport(rect) || hiddenTree(element) || s.visibility !== "visible") return false;
    for (let current = element; current; current = parentOf(current)) {
      const cs = style(current);
      if (
        cs.visibility !== "visible" ||
        Number(cs.opacity) !== 1 || cs.mixBlendMode !== "normal" ||
        cs.contentVisibility !== "visible" || cs.contain !== "none" ||
        effects.some((key) => key !== "mask-image" && key !== "clip-path" && !noGeometryEffect(cs, key))
      )
        return false;
    }
    if (clippedRects(element, [rect], true) || foreignCover(element, [rect], true)) return false;
    if (s.appearance !== "none" && (/^(?:select|progress|meter)$/.test(element.localName) || element.localName === "input" && /^(?:checkbox|radio|range|color)$/.test(element.type))) return true;
    const layers = background(composedParent(element), [rect]),
      ground = layers && composite(layers);
    if (!ground) return false;
    const fill = s.backgroundImage === "none" && s.borderImageSource === "none" && !insetShadowRisk(s.boxShadow) && s.backgroundClip === "border-box"
      ? composite([...layers, s.backgroundColor]) : null;
    if (fill?.some((channel, index) => Math.abs(channel - ground[index]) >= 1)) return true;
    return ["Top", "Right", "Bottom", "Left"].some((side) => {
      if (s.borderImageSource !== "none" || s.borderImageOutset !== "0") return false;
      if (!(parseFloat(s["border" + side + "Width"]) > 0) || s["border" + side + "Style"] === "none") return false;
      const color = composite([...layers, s["border" + side + "Color"]]);
      return color?.some((channel, index) => Math.abs(channel - ground[index]) >= 1);
    });
  };
  for (const host of new Set([...nativeAccepted.keys(), ...nativeUncertain])) {
    const box = host.getBoundingClientRect();
    if (composedOrder.has(host) && !hiddenTree(host) && style(host).visibility === "visible"
      && box.width > 0 && box.height > 0 && overlaps(box, viewportRect) && clippedRects(host, [box], true) !== "hidden") semantic.add(host);
  }
  for (const element of elements) {
    if (hiddenTree(element) || style(element).visibility !== "visible") continue;
    const rect = element.getBoundingClientRect(),
      role = roleOf(element);
    if (rect.width > 0 && rect.height > 0 && overlaps(rect, viewportRect)) {
      if (element.localName === "iframe" || element.localName === "frame") gap("embedded-document", element, rect, "iframe");
      if (/^(?:svg|img|canvas|audio|video|object|embed)$/.test(element.localName)) gap("visual-content", element, rect, role || "img");
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(element, pseudo);
        if (
          ps.content &&
          ps.content !== "none" &&
          ps.content !== "normal" &&
          !emptyPseudo(ps) &&
          ps.display !== "none" &&
          ps.visibility === "visible" &&
          Number(ps.opacity) > 0
        )
          gap("generated-content", element, rect, role || undefined);
      }
    }
    if (!role || !(interactiveRoles.has(role) || /^(?:img|iframe|separator|generic|progressbar|meter|ColorWell|Date|DateTime|InputTime|Audio|Video)$/.test(role))) continue;
    if (semantic.has(element)) continue;
    if (surface(element)) semantic.add(element);
    else if (rect.width > 0 && rect.height > 0 && overlaps(rect, viewportRect)) gap("control-presence", element, rect, role);
  }
  // Retain only semantic ancestry. Empty layout wrappers never become rows.
  for (const element of [...semantic])
    for (let parent = composedParent(element); parent; parent = composedParent(parent)) if (roleOf(parent)) semantic.add(parent);
  const rows = new Map(),
    rowNodes = new Map(),
    rootKey = keyFor(document);
  const root = {
    key: rootKey,
    role: "RootWebArea",
    bounds: [0, 0, viewport.width, viewport.height],
    depth: 0,
  };
  result.rows.push(root);
  rowNodes.set(rootKey, document);
  const stateFor = (element, role) => {
    const state = {};
    if ((nativeControl(element) && element.matches(":disabled")) || asciiToken(element.getAttribute("aria-disabled")) === "true") state.disabled = true;
    if (element.readOnly === true) state.readonly = true;
    if (element.required === true) state.required = true;
    if (/^(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role) && element.localName === "input" && /^(?:checkbox|radio)$/.test(element.type))
      state.checked = element.indeterminate ? "mixed" : element.checked;
    else if (/^(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)) {
      const value = asciiToken(element.getAttribute("aria-checked"));
      if (value === "true" || value === "false" || value === "mixed") state.checked = value === "mixed" ? value : value === "true";
    }
    for (const name of ["expanded", "pressed", "selected", "required", "readonly"]) {
      const value = asciiToken(element.getAttribute("aria-" + name));
      if (value === "true" || value === "false") state[name] = state[name] === true || value === "true";
      else if (name === "pressed" && value === "mixed") state[name] = value;
    }
    const current = element.getAttribute("aria-current")?.trim().toLowerCase();
    if (current) state.current = ["page", "step", "location", "date", "time"].includes(current) ? current : current !== "false";
    if (role === "heading") {
      const level = /^h[1-6]$/.test(element.localName) ? Number(element.localName.slice(1)) : Number(element.getAttribute("aria-level"));
      if (Number.isSafeInteger(level) && level > 0) state.level = level;
    }
    if (element.localName === "summary" && element.parentElement?.localName === "details") state.expanded = element.parentElement.open;
    if (element.isContentEditable && !element.parentElement?.isContentEditable) state.editable = "contenteditable";
    if (element.localName === "input" && element.type === "password") state.masked = true;
    return state;
  };
  const fragmentCache = new Map();
  const allFragments = (element) => {
    if (!fragmentCache.has(element))
      fragmentCache.set(
        element,
        accepted.filter((item) => !nativeOwners.has(item.node) && composedContains(element, item.node)),
      );
    return fragmentCache.get(element);
  };
  for (const element of elements) {
    if (!semantic.has(element)) continue;
    const role = roleOf(element);
    let parent = composedParent(element);
    while (parent && !semantic.has(parent)) parent = composedParent(parent);
    const parentRow = rows.get(parent) || root;
    const own = fragments.get(element) || [],
      meaningful = own.some((item) => item.text.trim());
    const direct = meaningful && labelRoles.has(role) ? own : [];
    let label = direct;
    const associated = element.labels ? [...element.labels] : [];
    if (element.ariaLabelledByElements) associated.push(...element.ariaLabelledByElements);
    if (interactiveRoles.has(role) && !label.length) {
      label = [...new Set(associated)].flatMap(allFragments);
      for (const item of label) claimedLabels.add(item.node);
    }
    const textFragments = label.map((item) => ({ text: item.text, bounds: unionBox(item.rects) }));
    const labelScopes = [element, ...associated];
    const nameUncertain = unknownByOwner.has(element) || labelRoles.has(role) && [...uncertainLabels].some((owner) => labelScopes.some((scope) => composedContains(scope, owner)));
    const box = element.getBoundingClientRect(),
      ownBox = box.width > 0 && box.height > 0 ? rectTuple(box) : undefined;
    const fallbackBox = textFragments.length ? textFragments[0].bounds : unknownByOwner.has(element) ? unionBox(unknownByOwner.get(element)) : undefined;
    const state = stateFor(element, role), field = nativeFields.get(element), valueBearing = nativeValueBearing(element);
    if (field?.expanded !== undefined) state.expanded = field.expanded;
    const row = {
      key: keyFor(element),
      parentKey: parentRow.key,
      role,
      depth: parentRow.depth + 1,
      ...(ownBox || fallbackBox ? { bounds: ownBox || fallbackBox } : {}),
      ...(textFragments.length ? { text: label.map((item) => item.text).join(""), textFragments } : {}),
      ...(nameUncertain || ((interactiveRoles.has(role) || role === "generic" || role === "img" || nativeControl(element)) && !label.some((item) => item.text.trim()))
        ? { nameUnknown: true }
        : {}),
      ...(Object.keys(state).length ? { state } : {}),
      ...(field?.value !== undefined ? { value: field.value } : {}),
      ...(field?.selectedLabels ? { selectedLabels: field.selectedLabels } : {}),
      ...(field?.placeholder ? { placeholder: field.placeholder } : {}),
      ...(valueBearing && (!field || field.valueUnknown) ? { valueUnknown: true } : {}),
    };
    rows.set(element, row);
    rowNodes.set(row.key, element);
    result.rows.push(row);
  }
  for (const [owner, items] of fragments) {
    if (owner && labelRoles.has(roleOf(owner))) continue;
    const parent = rows.get(owner) || root;
    for (const item of items) if (item.text.trim() && !claimedLabels.has(item.node)) {
      const row = { key: keyFor(item.node), parentKey: parent.key, role: "text", text: item.text, bounds: unionBox(item.rects), depth: parent.depth + 1 };
      rowNodes.set(row.key, item.node);
      result.rows.push(row);
    }
  }
  for (const { node, owner, rect } of unknownLeaves) {
    const parent = rows.get(owner) || root;
    const row = { key: keyFor(node), parentKey: parent.key, role: "text", nameUnknown: true,
      bounds: rectTuple(rect), depth: parent.depth + 1 };
    rowNodes.set(row.key, node); result.rows.push(row);
  }
  result.rows.sort((a, b) =>
    a === root
      ? -1
      : b === root
        ? 1
        : composedOrder.get(rowNodes.get(a.key)) - composedOrder.get(rowNodes.get(b.key)),
  );
  if (result.rows.length === 1) result.rows = [];
  // A synchronous metric lookup can activate a previously unused font.
  // Never combine earlier layout with a loading/new primary font. Blink
  // keeps this status loading until a later task, even for immediate loads.
  if (document.fonts.status !== "loaded") return null;
  return result;
}
